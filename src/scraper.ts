import { JSDOM } from "jsdom";
import { extractContent, extractMarkdownContent } from "./content";
import { loadUrls, writeOutputs } from "./io";
import { resolveDocumentBaseUrl, rewriteLinksInResult } from "./links";
import { logger } from "./logger";
import { fetchMarkdownIfAvailable, getPageHtml } from "./network";
import type { CliOptions } from "./types";
import { runCrawlWithWorkers, runScrapeWithWorkers } from "./worker-scheduler";

export async function scrapeOne(
  targetUrl: string,
  options: CliOptions,
  knownUrls: Set<string>
): Promise<void> {
  const markdownSource = await fetchMarkdownIfAvailable(targetUrl, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    userAgent: options.userAgent,
    verbose: options.verbose,
  });

  if (markdownSource) {
    logger.debug(
      `Using markdown source ${markdownSource.markdownUrl} for ${targetUrl}`
    );
    const result = extractMarkdownContent(markdownSource.markdown, targetUrl);
    const scopePathPrefix = new URL(targetUrl).pathname;
    const rewritten = await rewriteLinksInResult(
      result,
      targetUrl,
      options,
      knownUrls,
      undefined,
      undefined,
      scopePathPrefix
    );
    await writeOutputs(targetUrl, options, rewritten);
    logger.logPageSaved(targetUrl);
    return;
  }

  const html = await getPageHtml(targetUrl, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    userAgent: options.userAgent,
    verbose: options.verbose,
    render: options.render,
  });
  const dom = new JSDOM(html, { url: targetUrl });
  const document = dom.window.document;
  const result = extractContent(html, targetUrl, {
    readabilityDom: dom,
    cleaningDocument: document.cloneNode(true) as Document,
  });
  const linkBaseUrl = resolveDocumentBaseUrl(document, new URL(targetUrl));
  const rewritten = await rewriteLinksInResult(
    result,
    targetUrl,
    options,
    knownUrls,
    linkBaseUrl.toString()
  );
  await writeOutputs(targetUrl, options, rewritten);
  logger.logPageSaved(targetUrl);
}

export async function runWithConcurrency(
  urls: string[],
  options: CliOptions
): Promise<void> {
  await runScrapeWithWorkers(urls, options);
}

export async function crawlSite(
  startUrl: string,
  options: CliOptions
): Promise<void> {
  await runCrawlWithWorkers(startUrl, options);
}

export async function runCliFlow(options: CliOptions): Promise<void> {
  if (options.crawlStart) {
    await crawlSite(options.crawlStart, options);
    return;
  }
  const urls = await loadUrls(options);
  await runWithConcurrency(urls, options);
}
