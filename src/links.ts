import path from "node:path";
import { JSDOM } from "jsdom";
import type { CliOptions, ScrapeResult } from "./types";
import {
  buildOutputPaths,
  fileExists,
  isHtmlCandidate,
  isPathInScope,
  normalizeForQueue,
} from "./utils";

export function extractLinksFromDom(
  document: Document,
  base: URL,
  scopeOrigin: string,
  scopePathPrefix: string
): string[] {
  const anchors = document.querySelectorAll("a[href]");
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

export function extractLinks(
  html: string,
  base: URL,
  scopeOrigin: string,
  scopePathPrefix: string
): string[] {
  const dom = new JSDOM(html, { url: base.toString() });
  return extractLinksFromDom(
    dom.window.document,
    base,
    scopeOrigin,
    scopePathPrefix
  );
}

export function normalizeHrefTarget(
  href: string,
  currentUrl: string
): URL | null {
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

export async function resolveLinkToRelative(
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

export async function rewriteLinksInMarkdown(
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

export async function rewriteLinksInResult(
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
