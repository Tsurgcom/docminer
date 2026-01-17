import { JSDOM } from "jsdom";
import { extractContent } from "./content";
import { loadUrls, writeOutputs } from "./io";
import { extractLinksFromDom, rewriteLinksInResult } from "./links";
import { getPageHtml } from "./network";
import { buildAllowAllPolicy, loadRobotsPolicy } from "./robots";
import type { CliOptions, CrawlQueueItem } from "./types";
import { normalizeForQueue, sleep } from "./utils";

export async function scrapeOne(
  targetUrl: string,
  options: CliOptions,
  knownUrls: Set<string>
): Promise<void> {
  const html = await getPageHtml(targetUrl, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    userAgent: options.userAgent,
    verbose: options.verbose,
    render: options.render,
  });
  const result = extractContent(html, targetUrl);
  const rewritten = await rewriteLinksInResult(
    result,
    targetUrl,
    options,
    knownUrls
  );
  await writeOutputs(targetUrl, options, rewritten);
  console.info(`Saved ${targetUrl}`);
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

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const nextUrl = queue.shift();
      if (!nextUrl) {
        return;
      }
      try {
        await scrapeOne(nextUrl, options, knownUrls);
      } catch (error) {
        console.error(`Failed ${nextUrl}: ${String(error)}`);
      }
    }
  };

  const workerCount = Math.min(options.concurrency, queue.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
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
  const knownUrls = new Set<string>([normalizeForQueue(start)]);

  const processItem = async (item: CrawlQueueItem): Promise<string[]> => {
    const normalized = normalizeForQueue(new URL(item.url));
    if (visited.has(normalized)) {
      return [];
    }
    visited.add(normalized);

    const currentUrl = new URL(item.url);
    if (!robotsPolicy.isAllowed(currentUrl.pathname)) {
      console.info(`Blocked by robots.txt: ${currentUrl.toString()}`);
      return [];
    }

    await rateLimit();

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
      const reason = `Failed ${currentUrl.toString()}: ${String(error)}`;
      failures.push(reason);
      console.error(reason);
      return [];
    }

    const dom = new JSDOM(html, { url: currentUrl.toString() });
    const document = dom.window.document;
    const canGoDeeper = item.depth < options.maxDepth;
    const linkCandidates = canGoDeeper
      ? extractLinksFromDom(document, currentUrl, scopeOrigin, scopePathPrefix)
      : [];

    const result = extractContent(html, currentUrl.toString(), {
      readabilityDom: dom,
      cleaningDocument: document.cloneNode(true) as Document,
    });
    const rewritten = await rewriteLinksInResult(
      result,
      currentUrl.toString(),
      options,
      knownUrls
    );
    await writeOutputs(currentUrl.toString(), options, rewritten);
    savedCount += 1;
    console.info(`Saved ${currentUrl.toString()} (depth ${item.depth})`);

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
    for (const link of links) {
      const pending = queue.length - queueIndex;
      if (savedCount + pending >= options.maxPages) {
        break;
      }
      const normalizedLink = normalizeForQueue(new URL(link));
      if (visited.has(normalizedLink) || knownUrls.has(normalizedLink)) {
        continue;
      }
      knownUrls.add(normalizedLink);
      queue.push({ url: link, depth: parentDepth + 1 });
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

      try {
        const links = await processItem(item);
        enqueueLinks(links, item.depth);
      } finally {
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

  console.info(
    `Crawl finished. Saved ${savedCount} page(s), skipped ${visited.size - savedCount} item(s).`
  );
  if (failures.length > 0) {
    console.warn(`Failures (${failures.length}):`);
    for (const failure of failures) {
      console.warn(` - ${failure}`);
    }
  }
}

export async function runCliFlow(options: CliOptions): Promise<void> {
  if (options.crawlStart) {
    await crawlSite(options.crawlStart, options);
    return;
  }
  const urls = await loadUrls(options);
  await runWithConcurrency(urls, options);
}
