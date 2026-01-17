import { extractContent } from "./content";
import { loadUrls, writeOutputs } from "./io";
import { extractLinks, rewriteLinksInResult } from "./links";
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
  const visited = new Set<string>();
  const failures: string[] = [];
  const saved: string[] = [];
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

    const result = extractContent(html, currentUrl.toString());
    const rewritten = await rewriteLinksInResult(
      result,
      currentUrl.toString(),
      options,
      knownUrls
    );
    await writeOutputs(currentUrl.toString(), options, rewritten);
    saved.push(currentUrl.toString());
    console.info(`Saved ${currentUrl.toString()} (depth ${item.depth})`);

    if (item.depth >= options.maxDepth) {
      return [];
    }

    return extractLinks(html, currentUrl, scopeOrigin, scopePathPrefix);
  };

  const worker = async (): Promise<void> => {
    while (queue.length > 0 && saved.length < options.maxPages) {
      const item = queue.shift();
      if (!item || saved.length >= options.maxPages) {
        return;
      }

      const links = await processItem(item);
      for (const link of links) {
        if (saved.length + queue.length >= options.maxPages) {
          break;
        }
        const normalizedLink = normalizeForQueue(new URL(link));
        if (visited.has(normalizedLink)) {
          continue;
        }
        knownUrls.add(normalizedLink);
        queue.push({ url: link, depth: item.depth + 1 });
      }
    }
  };

  const workerCount = Math.min(
    options.concurrency,
    options.maxPages,
    queue.length || 1
  );
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  console.info(
    `Crawl finished. Saved ${saved.length} page(s), skipped ${visited.size - saved.length} item(s).`
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
