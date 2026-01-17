import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

interface CliOptions {
  url?: string;
  urlsFile?: string;
  crawlStart?: string;
  outDir: string;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  userAgent: string;
  verbose: boolean;
  overwriteLlms: boolean;
  render: boolean;
  maxDepth: number;
  maxPages: number;
  delayMs: number;
  respectRobots: boolean;
}

interface ScrapeResult {
  markdown: string;
  clutterMarkdown: string;
  llmsMarkdown: string;
  llmsFullMarkdown: string;
}

interface RobotsPolicy {
  isAllowed: (pathname: string) => boolean;
  crawlDelayMs?: number;
  source: string;
}

interface CrawlQueueItem {
  url: string;
  depth: number;
}

const DEFAULT_OPTIONS: CliOptions = {
  outDir: ".docs",
  concurrency: 4,
  timeoutMs: 15_000,
  retries: 2,
  userAgent: "aidocs-scraper/1.0",
  verbose: false,
  overwriteLlms: false,
  render: true,
  maxDepth: 3,
  maxPages: 200,
  delayMs: 500,
  respectRobots: true,
};

const CLUTTER_SELECTORS = [
  "nav",
  "header",
  "footer",
  "script",
  "style",
  "iframe",
  "svg",
  "noscript",
  "template",
  "form",
  "button",
  "input",
  "[aria-label='skip to content']",
];

const BLOCKED_EXTENSIONS_REGEX =
  /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|woff2?|ttf|eot)$/i;

const turndownService = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const argv = process.argv.slice(2);
const LINE_SPLIT_REGEX = /\r?\n/;

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULT_OPTIONS };

  const iterator = args[Symbol.iterator]();
  const positionalArgs: string[] = [];
  const consumeNext = (valueFromEq: string | undefined): string | undefined => {
    if (valueFromEq) {
      return valueFromEq;
    }
    const next = iterator.next();
    return next.done ? undefined : next.value;
  };

  const handlers: Record<string, (valueFromEq: string | undefined) => void> = {
    "--url": (valueFromEq) => {
      opts.url = consumeNext(valueFromEq);
    },
    "--urls": (valueFromEq) => {
      opts.urlsFile = consumeNext(valueFromEq);
    },
    "--crawl": (valueFromEq) => {
      opts.crawlStart = consumeNext(valueFromEq);
    },
    "--outDir": (valueFromEq) => {
      opts.outDir = consumeNext(valueFromEq) ?? DEFAULT_OPTIONS.outDir;
    },
    "--concurrency": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.concurrency = parsePositiveInt(raw, DEFAULT_OPTIONS.concurrency);
    },
    "--timeout": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.timeoutMs = parsePositiveInt(raw, DEFAULT_OPTIONS.timeoutMs);
    },
    "--retries": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.retries = parsePositiveInt(raw, DEFAULT_OPTIONS.retries);
    },
    "--userAgent": (valueFromEq) => {
      opts.userAgent = consumeNext(valueFromEq) ?? DEFAULT_OPTIONS.userAgent;
    },
    "--verbose": () => {
      opts.verbose = true;
    },
    "--overwrite-llms": () => {
      opts.overwriteLlms = true;
    },
    "--render": () => {
      opts.render = true;
    },
    "--no-render": () => {
      opts.render = false;
    },
    "--maxDepth": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.maxDepth = parsePositiveInt(raw, DEFAULT_OPTIONS.maxDepth);
    },
    "--maxPages": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.maxPages = parsePositiveInt(raw, DEFAULT_OPTIONS.maxPages);
    },
    "--delay": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.delayMs = parsePositiveInt(raw, DEFAULT_OPTIONS.delayMs);
    },
    "--no-robots": () => {
      opts.respectRobots = false;
    },
    "--help": () => {
      printHelp();
      process.exit(0);
    },
  };

  for (const arg of iterator) {
    const [flag, valueFromEq] = arg.split("=", 2);
    const handler = handlers[flag as keyof typeof handlers];
    if (handler) {
      handler(valueFromEq);
    } else {
      positionalArgs.push(arg);
    }
  }

  if (!(opts.url || opts.urlsFile || opts.crawlStart)) {
    const firstArg = positionalArgs[0];
    if (firstArg) {
      try {
        new URL(firstArg);
        opts.url = firstArg;
      } catch {
        printHelp();
        console.error(
          `"${firstArg}" is not a valid URL. Provide --url, --urls <file>, or --crawl <url>`
        );
        process.exit(1);
      }
    } else {
      printHelp();
      console.error("Provide --url, --urls <file>, or --crawl <url>");
      process.exit(1);
    }
  }

  if (positionalArgs.length > 1) {
    console.warn(
      `Ignoring extra positional arguments: ${positionalArgs.slice(1).join(", ")}`
    );
  }

  return opts;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSegment(segment: string): string {
  const clean = segment.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  return clean.length > 0 ? clean.toLowerCase() : "index";
}

function toSnakeDomain(hostname: string): string {
  return sanitizeSegment(hostname);
}

function buildOutputPaths(
  targetUrl: string,
  outDir: string
): {
  dir: string;
  pagePath: string;
  clutterPath: string;
  llmsPath: string;
  llmsFullPath: string;
} {
  const parsed = new URL(targetUrl);
  const domainPart = toSnakeDomain(parsed.hostname);
  const pathSegments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map(sanitizeSegment);
  const finalSegments = pathSegments.length > 0 ? pathSegments : ["root"];
  const dir = path.join(outDir, domainPart, ...finalSegments);
  return {
    dir,
    pagePath: path.join(dir, "page.md"),
    clutterPath: path.join(dir, "clutter.md"),
    llmsPath: path.join(dir, ".llms.md"),
    llmsFullPath: path.join(dir, "llms-full.md"),
  };
}

async function fetchWithTimeout(
  targetUrl: string,
  timeoutMs: number,
  userAgent: string
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetries(
  targetUrl: string,
  options: Pick<CliOptions, "timeoutMs" | "retries" | "userAgent" | "verbose">
): Promise<string> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= options.retries) {
    try {
      if (options.verbose) {
        console.info(
          `Fetching (${attempt + 1}/${options.retries + 1}): ${targetUrl}`
        );
      }
      return await fetchWithTimeout(
        targetUrl,
        options.timeoutMs,
        options.userAgent
      );
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (options.verbose) {
        console.warn(
          `Fetch attempt ${attempt} failed for ${targetUrl}: ${String(error)}`
        );
      }
      if (attempt > options.retries) {
        break;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch URL");
}

function buildAllowAllPolicy(): RobotsPolicy {
  return {
    isAllowed: () => true,
    source: "allow-all",
  };
}

function normalizeRulePath(rule: string): string {
  if (!rule.startsWith("/")) {
    return `/${rule}`;
  }
  return rule;
}

function selectAgentPolicy(
  rules: Map<
    string,
    { allow: string[]; disallow: string[]; crawlDelayMs?: number }
  >,
  userAgent: string
): { allow: string[]; disallow: string[]; crawlDelayMs?: number } | undefined {
  const lowerUA = userAgent.toLowerCase();
  if (rules.has(lowerUA)) {
    return rules.get(lowerUA);
  }
  for (const [agent, policy] of rules.entries()) {
    if (agent !== "*" && lowerUA.includes(agent)) {
      return policy;
    }
  }
  return rules.get("*");
}

function parseRobotsTxt(robotsText: string, userAgent: string): RobotsPolicy {
  const rules = new Map<
    string,
    { allow: string[]; disallow: string[]; crawlDelayMs?: number }
  >();
  let currentAgents = new Set<string>();

  const ensureEntry = (agent: string): void => {
    if (!rules.has(agent)) {
      rules.set(agent, { allow: [], disallow: [] });
    }
  };

  const applyToAgents = (
    handler: (entry: {
      allow: string[];
      disallow: string[];
      crawlDelayMs?: number;
    }) => void
  ): void => {
    if (currentAgents.size === 0) {
      currentAgents.add("*");
    }
    for (const agent of currentAgents) {
      ensureEntry(agent);
      const entry = rules.get(agent);
      if (entry) {
        handler(entry);
      }
    }
  };

  const lines = robotsText.split(LINE_SPLIT_REGEX);
  for (const rawLine of lines) {
    const line = rawLine.split("#", 1)[0]?.trim();
    if (!line) {
      continue;
    }
    const [directiveRaw = "", valueRaw = ""] = line.split(":", 2);
    const directive = directiveRaw.trim().toLowerCase();
    const value = valueRaw.trim();

    if (directive === "user-agent") {
      const agent = value.toLowerCase();
      currentAgents = new Set([agent]);
      ensureEntry(agent);
      continue;
    }

    if (directive === "allow") {
      applyToAgents((entry) => {
        entry.allow.push(normalizeRulePath(value));
      });
      continue;
    }

    if (directive === "disallow") {
      applyToAgents((entry) => {
        entry.disallow.push(normalizeRulePath(value));
      });
      continue;
    }

    if (directive === "crawl-delay") {
      const delaySeconds = Number.parseFloat(value);
      if (Number.isFinite(delaySeconds)) {
        const delayMs = delaySeconds * 1000;
        applyToAgents((entry) => {
          entry.crawlDelayMs = delayMs;
        });
      }
    }
  }

  const policy = selectAgentPolicy(rules, userAgent);
  if (!policy) {
    return buildAllowAllPolicy();
  }

  const allowRules = policy.allow;
  const disallowRules = policy.disallow;
  const evaluate = (pathname: string): boolean => {
    let longestAllow = "";
    let longestDisallow = "";
    for (const rule of allowRules) {
      if (pathname.startsWith(rule) && rule.length > longestAllow.length) {
        longestAllow = rule;
      }
    }
    for (const rule of disallowRules) {
      if (pathname.startsWith(rule) && rule.length > longestDisallow.length) {
        longestDisallow = rule;
      }
    }
    if (longestAllow.length === 0 && longestDisallow.length === 0) {
      return true;
    }
    if (longestAllow.length >= longestDisallow.length) {
      return true;
    }
    return false;
  };

  return {
    isAllowed: evaluate,
    crawlDelayMs: policy.crawlDelayMs,
    source: "robots.txt",
  };
}

async function loadRobotsPolicy(
  baseUrl: URL,
  options: Pick<CliOptions, "timeoutMs" | "userAgent" | "verbose">
): Promise<RobotsPolicy> {
  const robotsUrl = new URL("/robots.txt", baseUrl.origin).toString();
  try {
    const text = await fetchWithTimeout(
      robotsUrl,
      options.timeoutMs,
      options.userAgent
    );
    if (options.verbose) {
      console.info(`Loaded robots.txt from ${robotsUrl}`);
    }
    return parseRobotsTxt(text, options.userAgent);
  } catch (error) {
    if (options.verbose) {
      console.warn(
        `Could not load robots.txt from ${robotsUrl}: ${String(error)}`
      );
    }
    return buildAllowAllPolicy();
  }
}

function stripClutter(document: Document): {
  cleanedHtml: string;
  clutterHtml: string;
} {
  const removed: string[] = [];

  for (const selector of CLUTTER_SELECTORS) {
    const matches = document.querySelectorAll(selector);
    for (const element of matches) {
      const text = element.textContent?.trim();
      if (text) {
        removed.push(text);
      }
      element.remove();
    }
  }

  const body = document.querySelector("main") ?? document.body;
  const cleanedHtml = body?.innerHTML ?? document.body.innerHTML;
  const clutterHtml =
    removed.length > 0
      ? `<ul>${removed.map((entry) => `<li>${entry}</li>`).join("")}</ul>`
      : "";

  return { cleanedHtml, clutterHtml };
}

function extractContent(html: string, targetUrl: string): ScrapeResult {
  const domForReadability = new JSDOM(html, { url: targetUrl });
  const reader = new Readability(domForReadability.window.document);
  const article = reader.parse();

  const domForCleaning = new JSDOM(html, { url: targetUrl });
  const { cleanedHtml: fallbackHtml, clutterHtml } = stripClutter(
    domForCleaning.window.document
  );

  const rawBodyHtml = domForReadability.window.document.body.innerHTML;
  let mainHtml = article?.content;
  if (!mainHtml || mainHtml.trim().length === 0) {
    mainHtml =
      fallbackHtml && fallbackHtml.trim().length > 0
        ? fallbackHtml
        : rawBodyHtml;
  }
  const title =
    article?.title ?? domForCleaning.window.document.title ?? targetUrl;

  const markdownBody = turndownService.turndown(mainHtml);
  const clutterMarkdown = clutterHtml
    ? turndownService.turndown(clutterHtml)
    : "";
  const llmsMarkdown = markdownBody;
  const llmsFullMarkdown = turndownService.turndown(html);

  const header = [
    "---",
    `Source: ${targetUrl}`,
    `Fetched: ${new Date().toISOString()}`,
    "---\n",
    `# ${title}\n`,
  ].join("\n");

  return {
    markdown: `${header}${markdownBody}\n`,
    clutterMarkdown: clutterMarkdown ? `${header}${clutterMarkdown}\n` : "",
    llmsMarkdown: `${header}${llmsMarkdown}\n`,
    llmsFullMarkdown: `${header}${llmsFullMarkdown}\n`,
  };
}

function hasMeaningfulText(html: string): boolean {
  const dom = new JSDOM(html);
  const bodyText =
    dom.window.document.body.textContent?.replace(/\s+/g, "") ?? "";
  return bodyText.length > 200;
}

async function renderWithPlaywright(
  targetUrl: string,
  options: Pick<CliOptions, "timeoutMs" | "userAgent" | "verbose">
): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent: options.userAgent,
    });
    page.setDefaultNavigationTimeout(options.timeoutMs);
    await page.goto(targetUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(750);
    const content = await page.content();
    return content;
  } finally {
    await browser.close();
  }
}

async function getPageHtml(
  targetUrl: string,
  options: Pick<
    CliOptions,
    "timeoutMs" | "retries" | "userAgent" | "verbose" | "render"
  >
): Promise<string> {
  const rawHtml = await fetchWithRetries(targetUrl, options);
  if (!options.render || hasMeaningfulText(rawHtml)) {
    return rawHtml;
  }

  if (options.verbose) {
    console.info(`Falling back to headless render for ${targetUrl}`);
  }

  try {
    const renderedHtml = await renderWithPlaywright(targetUrl, options);
    if (hasMeaningfulText(renderedHtml)) {
      return renderedHtml;
    }
    if (options.verbose) {
      console.warn(
        `Headless render returned insufficient content for ${targetUrl}`
      );
    }
  } catch (error) {
    if (options.verbose) {
      console.warn(`Headless render failed for ${targetUrl}: ${String(error)}`);
    }
  }

  return rawHtml;
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function writeOutputs(
  targetUrl: string,
  options: CliOptions,
  result: ScrapeResult
): Promise<void> {
  const { dir, pagePath, clutterPath, llmsPath, llmsFullPath } =
    buildOutputPaths(targetUrl, options.outDir);
  await ensureDir(dir);

  await writeFile(pagePath, result.markdown, "utf8");
  if (result.clutterMarkdown) {
    await writeFile(clutterPath, result.clutterMarkdown, "utf8");
  }

  if (options.overwriteLlms) {
    await writeFile(llmsPath, result.llmsMarkdown, "utf8");
    await writeFile(llmsFullPath, result.llmsFullMarkdown, "utf8");
  } else {
    const llmsExists = await fileExists(llmsPath);
    const llmsFullExists = await fileExists(llmsFullPath);
    if (options.verbose && (llmsExists || llmsFullExists)) {
      console.info(`Skipped existing llms files in ${dir}`);
    }
  }
}

async function loadUrls(opts: CliOptions): Promise<string[]> {
  const urls: string[] = [];

  if (opts.url) {
    urls.push(opts.url);
  }

  if (opts.urlsFile) {
    const content = await readFile(opts.urlsFile, "utf8");
    const lines = content
      .split(LINE_SPLIT_REGEX)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    urls.push(...lines);
  }

  const unique = Array.from(new Set(urls));
  if (unique.length === 0) {
    throw new Error("No URLs provided to scrape");
  }
  return unique;
}

function normalizeForQueue(target: URL): string {
  const clone = new URL(target.toString());
  clone.hash = "";
  clone.search = "";
  return clone.toString();
}

function isHtmlCandidate(url: URL): boolean {
  return !BLOCKED_EXTENSIONS_REGEX.test(url.pathname);
}

function isPathInScope(pathname: string, scopePath: string): boolean {
  if (scopePath === "/") {
    return true;
  }
  const bareScope = scopePath.endsWith("/")
    ? scopePath.slice(0, -1) || "/"
    : scopePath;
  const normalizedScope = bareScope === "/" ? "/" : `${bareScope}/`;
  return (
    pathname === bareScope ||
    pathname === normalizedScope ||
    pathname.startsWith(normalizedScope)
  );
}

function extractLinks(
  html: string,
  base: URL,
  scopeOrigin: string,
  scopePathPrefix: string
): string[] {
  const dom = new JSDOM(html, { url: base.toString() });
  const anchors = dom.window.document.querySelectorAll("a[href]");
  const results: string[] = [];

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    try {
      const resolved = new URL(href, base);
      if (resolved.origin !== scopeOrigin) {
        continue;
      }
      if (!isPathInScope(resolved.pathname, scopePathPrefix)) {
        continue;
      }
      if (!isHtmlCandidate(resolved)) {
        continue;
      }
      resolved.hash = "";
      resolved.search = "";
      results.push(resolved.toString());
    } catch {
      // ignore invalid URLs
    }
  }

  return Array.from(new Set(results));
}

function normalizeHrefTarget(href: string, currentUrl: string): URL | null {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:")
  ) {
    return null;
  }
  try {
    const target = new URL(href, currentUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return null;
    }
    target.hash = "";
    target.search = "";
    return target;
  } catch {
    return null;
  }
}

async function resolveLinkToRelative(
  href: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>
): Promise<string | null> {
  const target = normalizeHrefTarget(href, currentUrl);
  if (!target) {
    return null;
  }

  const normalizedTarget = normalizeForQueue(target);
  const { pagePath: targetPagePath } = buildOutputPaths(
    target.toString(),
    options.outDir
  );

  const targetExists =
    knownUrls.has(normalizedTarget) || (await fileExists(targetPagePath));
  if (!targetExists) {
    return null;
  }

  const currentPageDir = path.dirname(
    buildOutputPaths(currentUrl, options.outDir).pagePath
  );
  const relativePath = path.relative(currentPageDir, targetPagePath);
  return relativePath.split(path.sep).join("/");
}

async function rewriteLinksInMarkdown(
  markdown: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>
): Promise<string> {
  const linkRegex = /!?\[([^\]]+)\]\(([^)]+)\)/g;
  let result = "";
  let lastIndex = 0;

  for (const match of markdown.matchAll(linkRegex)) {
    const fullMatch = match[0];
    const text = match[1] ?? "";
    const hrefRaw = match[2] ?? "";
    const index = match.index ?? 0;
    result += markdown.slice(lastIndex, index);

    // Skip images
    if (fullMatch.startsWith("![")) {
      result += fullMatch;
      lastIndex = index + fullMatch.length;
      continue;
    }

    const href = hrefRaw.trim();
    const replacement = await resolveLinkToRelative(
      href,
      currentUrl,
      options,
      knownUrls
    );

    if (replacement) {
      result += `[${text}](${replacement})`;
    } else {
      result += fullMatch;
    }
    lastIndex = index + fullMatch.length;
  }

  if (lastIndex < markdown.length) {
    result += markdown.slice(lastIndex);
  }

  return result;
}

async function rewriteLinksInResult(
  result: ScrapeResult,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>
): Promise<ScrapeResult> {
  const rewrite = async (content: string): Promise<string> =>
    rewriteLinksInMarkdown(content, currentUrl, options, knownUrls);

  return {
    markdown: await rewrite(result.markdown),
    clutterMarkdown: result.clutterMarkdown
      ? await rewrite(result.clutterMarkdown)
      : "",
    llmsMarkdown: await rewrite(result.llmsMarkdown),
    llmsFullMarkdown: await rewrite(result.llmsFullMarkdown),
  };
}

async function scrapeOne(
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

async function runWithConcurrency(
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

async function crawlSite(startUrl: string, options: CliOptions): Promise<void> {
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

function printHelp(): void {
  const lines = [
    "Usage: bun run index.ts (--url <url> | --urls <file> | --crawl <url>) [options]",
    "Options:",
    "  --url <url>            Single URL to scrape",
    "  --urls <file>          File containing URLs (one per line, # for comments)",
    "  --crawl <url>          Crawl starting URL and recurse within its path",
    "  --maxDepth <n>         Max crawl depth from start (default 3)",
    "  --maxPages <n>         Max pages to fetch during crawl (default 200)",
    "  --delay <ms>           Minimum delay between requests (default 500)",
    "  --no-robots            Ignore robots.txt (respect by default)",
    "  --outDir <path>        Output directory (default .docs)",
    "  --concurrency <n>      Parallel workers (default 4)",
    "  --timeout <ms>         Fetch timeout in ms (default 15000)",
    "  --retries <n>          Retry attempts (default 2)",
    "  --userAgent <string>   Custom User-Agent header",
    "  --verbose              Verbose logging",
    "  --overwrite-llms       Overwrite .llms.md and llms-full.md outputs",
    "  --no-render            Skip headless rendering fallback for SPAs",
    "  --help                 Show this help",
  ];
  console.info(lines.join("\n"));
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(argv);
    if (options.crawlStart) {
      await crawlSite(options.crawlStart, options);
    } else {
      const urls = await loadUrls(options);
      await runWithConcurrency(urls, options);
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}

main();
