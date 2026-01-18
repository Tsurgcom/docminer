import { logger } from "./logger";
import type { CliOptions } from "./types";

const TRAILING_SLASH_REGEX = /\/+$/;
const MARKDOWN_ACCEPT_HEADER = "text/markdown,text/plain;q=0.9,*/*;q=0.8";
const BLOCKED_DOWNLOAD_REGEX = /\.(css|js)$/i;

function isBlockedDownloadUrl(targetUrl: string): boolean {
  try {
    return BLOCKED_DOWNLOAD_REGEX.test(new URL(targetUrl).pathname);
  } catch {
    return false;
  }
}

async function fetchResponseWithTimeout(
  targetUrl: string,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(targetUrl, {
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithTimeout(
  targetUrl: string,
  timeoutMs: number,
  userAgent: string
): Promise<string> {
  const response = await fetchResponseWithTimeout(targetUrl, timeoutMs, {
    "User-Agent": userAgent,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

export async function fetchWithRetries(
  targetUrl: string,
  options: Pick<CliOptions, "timeoutMs" | "retries" | "userAgent" | "verbose">
): Promise<string> {
  if (isBlockedDownloadUrl(targetUrl)) {
    throw new Error(`Refusing to fetch blocked asset: ${targetUrl}`);
  }
  let attempt = 0;
  let lastError: unknown;
  const maxAttempts = options.retries + 1;

  while (attempt <= options.retries) {
    try {
      logger.logFetch(targetUrl, attempt + 1, maxAttempts);
      return await fetchWithTimeout(
        targetUrl,
        options.timeoutMs,
        options.userAgent
      );
    } catch (error) {
      lastError = error;
      attempt += 1;
      logger.logFetchError(targetUrl, attempt, error);
      if (attempt > options.retries) {
        break;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch URL");
}

export async function fetchHtml(
  targetUrl: string,
  options: Pick<CliOptions, "timeoutMs" | "retries" | "userAgent" | "verbose">
): Promise<string> {
  return await fetchWithRetries(targetUrl, options);
}

export function buildMarkdownCandidateUrl(targetUrl: string): string {
  const parsed = new URL(targetUrl);
  parsed.hash = "";

  const originalPath = parsed.pathname;
  const lowerPath = originalPath.toLowerCase();
  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".txt")) {
    return parsed.toString();
  }

  if (originalPath === "/" || originalPath.length === 0) {
    parsed.pathname = "/llms.txt";
    return parsed.toString();
  }

  if (originalPath.endsWith("/")) {
    const trimmed = originalPath.replace(TRAILING_SLASH_REGEX, "");
    if (trimmed.length === 0) {
      parsed.pathname = "/llms.txt";
      return parsed.toString();
    }
    if (trimmed.toLowerCase().endsWith(".md")) {
      parsed.pathname = trimmed;
      return parsed.toString();
    }
    parsed.pathname = `${trimmed}.md`;
    return parsed.toString();
  }

  parsed.pathname = `${originalPath}.md`;
  return parsed.toString();
}

export async function fetchMarkdownIfAvailable(
  targetUrl: string,
  options: Pick<CliOptions, "timeoutMs" | "retries" | "userAgent" | "verbose">
): Promise<{ markdown: string; markdownUrl: string } | null> {
  if (isBlockedDownloadUrl(targetUrl)) {
    return null;
  }
  const markdownUrl = buildMarkdownCandidateUrl(targetUrl);
  let attempt = 0;
  let lastError: unknown;
  const maxAttempts = options.retries + 1;

  while (attempt <= options.retries) {
    try {
      logger.logFetch(markdownUrl, attempt + 1, maxAttempts);
      const response = await fetchResponseWithTimeout(
        markdownUrl,
        options.timeoutMs,
        {
          "User-Agent": options.userAgent,
          Accept: MARKDOWN_ACCEPT_HEADER,
        }
      );

      if (!response.ok) {
        if (response.status !== 404 && response.status !== 410) {
          logger.debug(
            `Markdown source unavailable (${response.status}) for ${markdownUrl}`
          );
        }
        return null;
      }

      const markdown = await response.text();
      return { markdown, markdownUrl };
    } catch (error) {
      lastError = error;
      attempt += 1;
      logger.logFetchError(markdownUrl, attempt, error);
      if (attempt > options.retries) {
        break;
      }
    }
  }

  if (lastError) {
    logger.debug(
      `Markdown source check failed for ${markdownUrl}: ${String(lastError)}`
    );
  }

  return null;
}

export function hasMeaningfulText(html: string): boolean {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const textOnly = withoutScripts.replace(/<[^>]+>/g, " ").replace(/\s+/g, "");
  return textOnly.length > 200;
}

export async function renderWithPlaywright(
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

export async function getPageHtml(
  targetUrl: string,
  options: Pick<
    CliOptions,
    "timeoutMs" | "retries" | "userAgent" | "verbose" | "render"
  >
): Promise<string> {
  if (isBlockedDownloadUrl(targetUrl)) {
    throw new Error(`Refusing to fetch blocked asset: ${targetUrl}`);
  }
  const rawHtml = await fetchHtml(targetUrl, options);
  if (!options.render || hasMeaningfulText(rawHtml)) {
    return rawHtml;
  }

  logger.logFallback(`Using headless render for ${targetUrl}`);

  try {
    const renderedHtml = await renderWithPlaywright(targetUrl, options);
    if (hasMeaningfulText(renderedHtml)) {
      return renderedHtml;
    }
    logger.debug(
      `Headless render returned insufficient content for ${targetUrl}`
    );
  } catch (error) {
    logger.debug(`Headless render failed for ${targetUrl}: ${String(error)}`);
  }

  return rawHtml;
}
