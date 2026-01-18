import { JSDOM } from "jsdom";
import { extractContent, extractMarkdownContent } from "./content";
import { loadUrls, writeOutputs } from "./io";
import {
  extractLinksFromDom,
  extractLinksFromMarkdown,
  resolveDocumentBaseUrl,
  rewriteLinksInResult,
} from "./links";
import { logger } from "./logger";
import { fetchMarkdownIfAvailable, getPageHtml } from "./network";
import { buildAllowAllPolicy, loadRobotsPolicy } from "./robots";
import type { CliOptions, CrawlQueueItem } from "./types";
import { normalizeForQueue, sleep } from "./utils";

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
  const queue = [...urls];
  const knownUrls = new Set(
    queue.map((candidate) => normalizeForQueue(new URL(candidate)))
  );
  const workers: Promise<void>[] = [];
  let processed = 0;

  logger.startProgress(queue.length);

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const nextUrl = queue.shift();
      if (!nextUrl) {
        return;
      }
      try {
        logger.updateProgress(processed, nextUrl);
        await scrapeOne(nextUrl, options, knownUrls);
        processed += 1;
        logger.incrementProgress(nextUrl);
      } catch (error) {
        processed += 1;
        logger.recordFailure();
        logger.error(`Failed ${nextUrl}: ${String(error)}`);
      }
    }
  };

  const workerCount = Math.min(options.concurrency, queue.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
  logger.endProgress();
}

export async function crawlSite(
  startUrl: string,
  options: CliOptions
): Promise<void> {
  const start = new URL(startUrl);
  const scopeOrigin = start.origin;
  const scopePathPrefix = start.pathname.endsWith("/")
    ? start.pathname
    : `${start.pathname}`;

  logger.logCrawlStart(startUrl, {
    maxDepth: options.maxDepth,
    maxPages: options.maxPages,
    delay: `${options.delayMs}ms`,
    concurrency: options.concurrency,
    respectRobots: options.respectRobots,
  });

  const robotsPolicy = options.respectRobots
    ? await loadRobotsPolicy(start, {
        timeoutMs: options.timeoutMs,
        userAgent: options.userAgent,
        verbose: options.verbose,
      })
    : buildAllowAllPolicy();

  const effectiveDelay = Math.max(
    options.delayMs,
    robotsPolicy.crawlDelayMs ?? 0
  );
  let throttle = Promise.resolve();
  let nextAllowed = 0;

  const rateLimit = async (): Promise<void> => {
    if (effectiveDelay <= 0) {
      return;
    }
    let release: () => void = () => undefined;
    const previous = throttle;
    throttle = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const now = Date.now();
    const wait = Math.max(0, nextAllowed - now);
    nextAllowed = Math.max(now, nextAllowed) + effectiveDelay;
    release();
    if (wait > 0) {
      await sleep(wait);
    }
  };

  const queue: CrawlQueueItem[] = [{ url: start.toString(), depth: 0 }];
  let queueIndex = 0;
  const visited = new Set<string>();
  const failures: string[] = [];
  let savedCount = 0;
  let activeWorkers = 0;
  let inFlightCount = 0; // Items taken from queue but not yet completed (ensures stable total)
  const knownUrls = new Set<string>([normalizeForQueue(start)]);

  const getPendingCount = (): number => queue.length - queueIndex;
  // Total = saved + in-flight + pending (remains stable as items move through states)
  const getDynamicTotal = (): number =>
    savedCount + inFlightCount + getPendingCount();

  logger.startProgress(getDynamicTotal());

  const handleMarkdownSource = async (
    markdownSource: { markdown: string; markdownUrl: string },
    currentUrl: URL,
    depth: number,
    canGoDeeper: boolean
  ): Promise<string[]> => {
    logger.debug(
      `Using markdown source ${markdownSource.markdownUrl} for ${currentUrl.toString()}`
    );
    const linkCandidates = canGoDeeper
      ? extractLinksFromMarkdown(
          markdownSource.markdown,
          currentUrl,
          scopeOrigin,
          scopePathPrefix
        )
      : [];
    const linkHints =
      linkCandidates.length > 0
        ? new Set(
            linkCandidates.map((link) => normalizeForQueue(new URL(link)))
          )
        : undefined;

    const result = extractMarkdownContent(
      markdownSource.markdown,
      currentUrl.toString()
    );
    const rewritten = await rewriteLinksInResult(
      result,
      currentUrl.toString(),
      options,
      knownUrls,
      undefined,
      linkHints,
      scopePathPrefix
    );
    await writeOutputs(currentUrl.toString(), options, rewritten);
    savedCount += 1;
    logger.updateProgress(savedCount, currentUrl.toString(), getDynamicTotal());
    logger.logPageSaved(currentUrl.toString(), depth);

    if (!canGoDeeper) {
      return [];
    }

    return linkCandidates;
  };

  const processItem = async (item: CrawlQueueItem): Promise<string[]> => {
    const normalized = normalizeForQueue(new URL(item.url));
    if (visited.has(normalized)) {
      return [];
    }
    visited.add(normalized);

    const currentUrl = new URL(item.url);
    const canGoDeeper = item.depth < options.maxDepth;
    if (!robotsPolicy.isAllowed(currentUrl.pathname)) {
      logger.logBlocked(currentUrl.toString(), "robots.txt");
      return [];
    }

    await rateLimit();
    logger.updateProgress(savedCount, currentUrl.toString(), getDynamicTotal());

    const markdownSource = await fetchMarkdownIfAvailable(
      currentUrl.toString(),
      {
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        userAgent: options.userAgent,
        verbose: options.verbose,
      }
    );

    if (markdownSource) {
      return await handleMarkdownSource(
        markdownSource,
        currentUrl,
        item.depth,
        canGoDeeper
      );
    }

    let html: string;
    try {
      html = await getPageHtml(currentUrl.toString(), {
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        userAgent: options.userAgent,
        verbose: options.verbose,
        render: options.render,
      });
    } catch (error) {
      const reason = `${currentUrl.toString()}: ${String(error)}`;
      failures.push(reason);
      logger.recordFailure();
      logger.error(`Failed ${reason}`);
      return [];
    }

    const dom = new JSDOM(html, { url: currentUrl.toString() });
    const document = dom.window.document;
    const linkBaseUrl = resolveDocumentBaseUrl(document, currentUrl);
    const linkCandidates = canGoDeeper
      ? extractLinksFromDom(document, currentUrl, scopeOrigin, scopePathPrefix)
      : [];
    const linkHints =
      linkCandidates.length > 0
        ? new Set(
            linkCandidates.map((link) => normalizeForQueue(new URL(link)))
          )
        : undefined;

    const result = extractContent(html, currentUrl.toString(), {
      readabilityDom: dom,
      cleaningDocument: document.cloneNode(true) as Document,
    });
    const rewritten = await rewriteLinksInResult(
      result,
      currentUrl.toString(),
      options,
      knownUrls,
      linkBaseUrl.toString(),
      linkHints
    );
    await writeOutputs(currentUrl.toString(), options, rewritten);
    savedCount += 1;
    logger.updateProgress(savedCount, currentUrl.toString(), getDynamicTotal());
    logger.logPageSaved(currentUrl.toString(), item.depth);

    if (!canGoDeeper) {
      return [];
    }

    return linkCandidates;
  };

  const takeNextItem = (): CrawlQueueItem | null => {
    const next = queue[queueIndex];
    if (!next) {
      return null;
    }
    queueIndex += 1;
    return next;
  };

  const enqueueLinks = (links: string[], parentDepth: number): void => {
    let added = 0;
    for (const link of links) {
      const pending = getPendingCount();
      if (savedCount + pending >= options.maxPages) {
        break;
      }
      const normalizedLink = normalizeForQueue(new URL(link));
      if (visited.has(normalizedLink) || knownUrls.has(normalizedLink)) {
        continue;
      }
      knownUrls.add(normalizedLink);
      queue.push({ url: link, depth: parentDepth + 1 });
      added += 1;
    }
    // Update progress total when new links are discovered
    if (added > 0) {
      logger.setProgressTotal(getDynamicTotal());
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (savedCount >= options.maxPages) {
        return;
      }
      const item = takeNextItem();
      if (!item) {
        if (activeWorkers === 0) {
          return;
        }
        await sleep(5);
        continue;
      }
      activeWorkers += 1;
      inFlightCount += 1;

      try {
        const links = await processItem(item);
        enqueueLinks(links, item.depth);
      } finally {
        inFlightCount -= 1;
        activeWorkers -= 1;
      }
    }
  };

  const workerCount = Math.min(options.concurrency, options.maxPages);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  logger.endProgress();

  const skipped = visited.size - savedCount;
  if (skipped > 0) {
    logger.info(`Skipped ${skipped} duplicate/visited URL(s)`);
  }

  logger.printFailureSummary(failures);
}

export async function runCliFlow(options: CliOptions): Promise<void> {
  if (options.crawlStart) {
    await crawlSite(options.crawlStart, options);
    return;
  }
  const urls = await loadUrls(options);
  await runWithConcurrency(urls, options);
}
