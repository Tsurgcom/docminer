import { JSDOM } from "jsdom";
import type { CliOptions } from "./types";

export async function fetchWithTimeout(
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

export async function fetchWithRetries(
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

export function hasMeaningfulText(html: string): boolean {
  const dom = new JSDOM(html);
  const bodyText =
    dom.window.document.body.textContent?.replace(/\s+/g, "") ?? "";
  return bodyText.length > 200;
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
