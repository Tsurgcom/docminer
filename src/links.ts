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

const INLINE_LINK_REGEX = /!?\[([^\]]+)\]\(([^)]+)\)/g;
const REFERENCE_DEFINITION_REGEX = /^[ \t]*\[[^\]]+\]:\s*(\S+).*$/gm;
const REFERENCE_REWRITE_REGEX = /(^[ \t]*\[[^\]]+\]:\s*)(\S+)(.*)$/gm;
const AUTO_LINK_REGEX = /<\s*(https?:\/\/[^>\s]+)\s*>/g;
const BARE_URL_REGEX = /\bhttps?:\/\/[^\s<>"'()]+/g;
const REFERENCE_LINE_REGEX = /^[ \t]*\[[^\]]+\]:\s*\S+/;
const SOURCE_LINE_REGEX = /^Source:\s*(.+?)\s*$/i;
const SOURCE_MARKDOWN_LINK_REGEX = /^\[(.+?)\]\((.+?)\)$/;
const SOURCE_AUTOLINK_REGEX = /^<(.+)>$/;
const SOURCE_URL_PREFIX_REGEX = /^https?:\/\//i;
const HREF_ATTRIBUTE_REGEX =
  /(\bhref\s*=\s*)(?:"([^"]+)"|'([^']+)'|\{([^}]+)\})/g;
const BRACED_STRING_REGEX = /^\s*(['"])(.+)\1\s*$/;
const FENCE_REGEX = /^\s*(```|~~~)/;
const TRAILING_PUNCTUATION_REGEX = /[.,!?;:]+$/;
const TRAILING_WHITESPACE_REGEX = /\s+$/;
const WHITESPACE_REGEX = /\s/;
const EXTERNAL_MARKER = "↗";
const FRONTMATTER_REGEX = /^(---\s*\n[\s\S]*?\n---\s*\n)([\s\S]*)$/;
const EXTERNAL_MARKER_REGEX = /\s*↗\s*$/;
const LINE_SPLIT_REGEX = /\r?\n/;

export function extractLinksFromDom(
  document: Document,
  base: URL,
  scopeOrigin: string,
  scopePathPrefix: string
): string[] {
  const anchors = document.querySelectorAll("a[href]");
  const results: string[] = [];
  const baseForResolution = resolveDocumentBaseUrl(document, base);

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    try {
      const resolved = new URL(href, baseForResolution);
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

export function resolveDocumentBaseUrl(document: Document, base: URL): URL {
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (!baseHref) {
    return base;
  }
  try {
    return new URL(baseHref, base);
  } catch {
    return base;
  }
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

export function extractLinksFromMarkdown(
  markdown: string,
  base: URL,
  scopeOrigin: string,
  scopePathPrefix: string
): string[] {
  const { body } = splitFrontmatter(markdown);
  const results = new Set<string>();

  const resolveMarkdownTarget = (href: string): URL | null => {
    const target = normalizeHrefTarget(href, base.toString());
    if (!target) {
      return null;
    }
    return applyScopePathPrefix(href, target, scopePathPrefix) ?? target;
  };

  const addCandidate = (href: string): void => {
    const target = resolveMarkdownTarget(href);
    if (!target) {
      return;
    }
    if (target.origin !== scopeOrigin) {
      return;
    }
    if (!isPathInScope(target.pathname, scopePathPrefix)) {
      return;
    }
    if (!isHtmlCandidate(target)) {
      return;
    }
    results.add(target.toString());
  };

  const inlineLinkRegex = new RegExp(INLINE_LINK_REGEX);
  for (const match of body.matchAll(inlineLinkRegex)) {
    const fullMatch = match[0] ?? "";
    if (fullMatch.startsWith("![")) {
      continue;
    }
    const hrefRaw = match[2] ?? "";
    const { href } = parseMarkdownHref(hrefRaw);
    if (href) {
      addCandidate(href);
    }
  }

  const referenceDefinitionRegex = new RegExp(REFERENCE_DEFINITION_REGEX);
  for (const match of body.matchAll(referenceDefinitionRegex)) {
    const hrefRaw = match[1] ?? "";
    const { href } = parseMarkdownHref(hrefRaw);
    if (href) {
      addCandidate(href);
    }
  }

  const hrefAttributeRegex = new RegExp(HREF_ATTRIBUTE_REGEX);
  for (const match of body.matchAll(hrefAttributeRegex)) {
    const href = extractHrefFromAttributeMatch(match);
    if (href) {
      addCandidate(href);
    }
  }

  const autoLinkRegex = new RegExp(AUTO_LINK_REGEX);
  for (const match of body.matchAll(autoLinkRegex)) {
    const href = match[1];
    if (href) {
      addCandidate(href);
    }
  }

  for (const href of collectBareUrlsFromMarkdown(body)) {
    addCandidate(href);
  }

  return Array.from(results);
}

export function normalizeHrefTarget(
  href: string,
  currentUrl: string,
  linkBaseUrl?: string
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
    const baseForResolution = linkBaseUrl ?? currentUrl;
    const target = new URL(href, baseForResolution);
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

function resolveHrefAnchor(
  href: string,
  currentUrl: string,
  linkBaseUrl?: string
): string {
  try {
    const baseForResolution = linkBaseUrl ?? currentUrl;
    const target = new URL(href, baseForResolution);
    return target.hash;
  } catch {
    return "";
  }
}

function isExternalLink(
  href: string,
  currentUrl: string,
  linkBaseUrl?: string
): boolean {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:")
  ) {
    return false;
  }
  try {
    const baseForResolution = linkBaseUrl ?? currentUrl;
    const target = new URL(href, baseForResolution);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return false;
    }
    return target.origin !== new URL(currentUrl).origin;
  } catch {
    return false;
  }
}

function withExternalMarker(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(EXTERNAL_MARKER)) {
    return text;
  }
  return `${text} ${EXTERNAL_MARKER}`;
}

function removeExternalMarker(text: string): string {
  return text.replace(EXTERNAL_MARKER_REGEX, "").trimEnd();
}

function normalizeLinkLabel(text: string, external: boolean): string {
  return external ? withExternalMarker(text) : removeExternalMarker(text);
}

function normalizeSourceValue(value: string): string | null {
  const trimmed = removeExternalMarker(value).trim();
  if (!trimmed) {
    return null;
  }

  const markdownMatch = trimmed.match(SOURCE_MARKDOWN_LINK_REGEX);
  if (markdownMatch) {
    const label = markdownMatch[1]?.trim() ?? "";
    const href = markdownMatch[2]?.trim() ?? "";
    return pickSourceUrlCandidate(label, href);
  }

  const autoLinkMatch = trimmed.match(SOURCE_AUTOLINK_REGEX);
  if (autoLinkMatch) {
    const href = autoLinkMatch[1]?.trim() ?? "";
    return href || null;
  }

  return trimmed;
}

function pickSourceUrlCandidate(label: string, href: string): string | null {
  if (SOURCE_URL_PREFIX_REGEX.test(label)) {
    return label;
  }
  if (SOURCE_URL_PREFIX_REGEX.test(href)) {
    return href;
  }
  return label || href || null;
}

export async function resolveLinkToRelative(
  href: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string,
  keepHash = false
): Promise<string | null> {
  const initialTarget = normalizeHrefTarget(href, currentUrl, linkBaseUrl);
  if (!initialTarget) {
    return null;
  }

  const anchor = keepHash
    ? resolveHrefAnchor(href, currentUrl, linkBaseUrl)
    : "";
  const scopedTarget =
    applyScopePathPrefix(href, initialTarget, scopePathPrefix) ?? initialTarget;
  const normalizedTarget = normalizeForQueue(scopedTarget);
  const { pagePath: targetPagePath } = buildOutputPaths(
    scopedTarget.toString(),
    options.outDir
  );

  const targetExists =
    knownUrls.has(normalizedTarget) ||
    linkHints?.has(normalizedTarget) ||
    (await fileExists(targetPagePath));
  if (!targetExists) {
    return null;
  }

  const currentPageDir = path.dirname(
    buildOutputPaths(currentUrl, options.outDir).pagePath
  );
  const relativePath = path.relative(currentPageDir, targetPagePath);
  const normalizedRelative = relativePath.split(path.sep).join("/");
  return anchor ? `${normalizedRelative}${anchor}` : normalizedRelative;
}

export async function rewriteLinksInMarkdown(
  markdown: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string
): Promise<string> {
  const withInlineLinks = await rewriteInlineMarkdownLinks(
    markdown,
    currentUrl,
    options,
    knownUrls,
    linkBaseUrl,
    linkHints,
    scopePathPrefix
  );

  const withReferenceLinks = await rewriteReferenceMarkdownLinks(
    withInlineLinks,
    currentUrl,
    options,
    knownUrls,
    linkBaseUrl,
    linkHints,
    scopePathPrefix
  );

  return await rewriteMarkdownHrefAttributes(
    withReferenceLinks,
    currentUrl,
    options,
    knownUrls,
    linkBaseUrl,
    linkHints,
    scopePathPrefix
  );
}

export async function rewriteMarkdownContent(
  markdown: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string
): Promise<string> {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const normalizedFrontmatter = normalizeFrontmatterSource(frontmatter);
  const rewrittenBody = await rewriteLinksInMarkdown(
    body,
    currentUrl,
    options,
    knownUrls,
    linkBaseUrl,
    linkHints,
    scopePathPrefix
  );
  const linkifiedBody = await linkifyBareUrls(
    rewrittenBody,
    currentUrl,
    options,
    knownUrls,
    linkBaseUrl,
    linkHints,
    scopePathPrefix
  );
  return normalizedFrontmatter
    ? `${normalizedFrontmatter}${linkifiedBody}`
    : linkifiedBody;
}

async function linkifyBareUrls(
  markdown: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string
): Promise<string> {
  const lines = markdown.split("\n");
  const fenceState = createFenceState();
  const processed: string[] = [];

  for (const line of lines) {
    if (shouldSkipLineForFence(line, fenceState)) {
      processed.push(line);
      continue;
    }

    if (REFERENCE_LINE_REGEX.test(line)) {
      processed.push(line);
      continue;
    }

    processed.push(
      await linkifyBareUrlsInLine(
        line,
        currentUrl,
        options,
        knownUrls,
        linkBaseUrl,
        linkHints,
        scopePathPrefix
      )
    );
  }

  return processed.join("\n");
}

function extractHrefFromAttributeMatch(match: RegExpMatchArray): string | null {
  const doubleQuoted = match[2];
  const singleQuoted = match[3];
  const braced = match[4];

  if (doubleQuoted !== undefined) {
    return doubleQuoted;
  }
  if (singleQuoted !== undefined) {
    return singleQuoted;
  }
  if (braced === undefined) {
    return null;
  }

  const bracedMatch = braced.match(BRACED_STRING_REGEX);
  if (!bracedMatch) {
    return null;
  }

  return bracedMatch[2] ?? null;
}

function parseMarkdownHref(raw: string): {
  href: string;
  suffix: string;
  wrapped: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { href: "", suffix: "", wrapped: false };
  }
  const spaceIndex = trimmed.search(WHITESPACE_REGEX);
  const hrefPart = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const suffix = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex);
  const wrapped = hrefPart.startsWith("<") && hrefPart.endsWith(">");
  const href = wrapped ? hrefPart.slice(1, -1) : hrefPart;
  return { href, suffix, wrapped };
}

async function rewriteInlineMarkdownLinks(
  markdown: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string
): Promise<string> {
  const inlineLinkRegex = new RegExp(INLINE_LINK_REGEX);
  let result = "";
  let lastIndex = 0;

  for (const match of markdown.matchAll(inlineLinkRegex)) {
    const fullMatch = match[0] ?? "";
    const text = match[1] ?? "";
    const hrefRaw = match[2] ?? "";
    const index = match.index ?? 0;
    result += markdown.slice(lastIndex, index);

    if (fullMatch.startsWith("![")) {
      result += fullMatch;
      lastIndex = index + fullMatch.length;
      continue;
    }

    const { href, suffix, wrapped } = parseMarkdownHref(hrefRaw);
    const replacement = href
      ? await resolveLinkToRelative(
          href,
          currentUrl,
          options,
          knownUrls,
          linkBaseUrl,
          linkHints,
          scopePathPrefix,
          true
        )
      : null;
    const displayText = replacement
      ? removeExternalMarker(text)
      : normalizeLinkLabel(
          text,
          Boolean(href && isExternalLink(href, currentUrl, linkBaseUrl))
        );

    if (replacement) {
      const resolvedHref = wrapped ? `<${replacement}>` : replacement;
      result += `[${displayText}](${resolvedHref}${suffix})`;
    } else {
      result += `[${displayText}](${hrefRaw})`;
    }
    lastIndex = index + fullMatch.length;
  }

  if (lastIndex < markdown.length) {
    result += markdown.slice(lastIndex);
  }

  return result;
}

async function rewriteReferenceMarkdownLinks(
  markdown: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string
): Promise<string> {
  const referenceRegex = new RegExp(REFERENCE_REWRITE_REGEX);
  let result = "";
  let lastIndex = 0;

  for (const match of markdown.matchAll(referenceRegex)) {
    const fullMatch = match[0] ?? "";
    const prefix = match[1] ?? "";
    const hrefRaw = match[2] ?? "";
    const suffix = match[3] ?? "";
    const index = match.index ?? 0;
    result += markdown.slice(lastIndex, index);

    const { href, wrapped } = parseMarkdownHref(hrefRaw);
    const replacement = href
      ? await resolveLinkToRelative(
          href,
          currentUrl,
          options,
          knownUrls,
          linkBaseUrl,
          linkHints,
          scopePathPrefix,
          true
        )
      : null;

    if (replacement) {
      const resolvedHref = wrapped ? `<${replacement}>` : replacement;
      result += `${prefix}${resolvedHref}${suffix}`;
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

async function rewriteMarkdownHrefAttributes(
  markdown: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string
): Promise<string> {
  const hrefAttributeRegex = new RegExp(HREF_ATTRIBUTE_REGEX);
  let result = "";
  let lastIndex = 0;

  for (const match of markdown.matchAll(hrefAttributeRegex)) {
    const fullMatch = match[0] ?? "";
    const prefix = match[1] ?? "href=";
    const index = match.index ?? 0;
    result += markdown.slice(lastIndex, index);

    const parsed = parseHrefAttributeMatch(match);
    if (!parsed) {
      result += fullMatch;
      lastIndex = index + fullMatch.length;
      continue;
    }

    const replacement = await resolveLinkToRelative(
      parsed.href,
      currentUrl,
      options,
      knownUrls,
      linkBaseUrl,
      linkHints,
      scopePathPrefix,
      true
    );

    if (replacement) {
      result += `${prefix}${formatHrefAttributeValue(parsed, replacement)}`;
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

function parseHrefAttributeMatch(match: RegExpMatchArray): {
  href: string;
  wrap: "double" | "single" | "braced";
  quote: "'" | '"';
} | null {
  const doubleQuoted = match[2];
  const singleQuoted = match[3];
  const braced = match[4];

  if (doubleQuoted !== undefined) {
    return { href: doubleQuoted, wrap: "double", quote: '"' };
  }
  if (singleQuoted !== undefined) {
    return { href: singleQuoted, wrap: "single", quote: "'" };
  }
  if (braced === undefined) {
    return null;
  }

  const bracedMatch = braced.match(BRACED_STRING_REGEX);
  if (!bracedMatch) {
    return null;
  }

  const quote = bracedMatch[1] === "'" ? "'" : '"';
  const href = bracedMatch[2] ?? "";
  return { href, wrap: "braced", quote };
}

function formatHrefAttributeValue(
  parsed: { wrap: "double" | "single" | "braced"; quote: "'" | '"' },
  replacement: string
): string {
  if (parsed.wrap === "braced") {
    return `{${parsed.quote}${replacement}${parsed.quote}}`;
  }
  if (parsed.wrap === "single") {
    return `'${replacement}'`;
  }
  return `"${replacement}"`;
}

function applyScopePathPrefix(
  href: string,
  target: URL,
  scopePathPrefix?: string
): URL | null {
  if (!scopePathPrefix || scopePathPrefix === "/") {
    return null;
  }
  if (!href.startsWith("/")) {
    return null;
  }
  if (isPathInScope(target.pathname, scopePathPrefix)) {
    return null;
  }
  const scopePrefix = scopePathPrefix.endsWith("/")
    ? scopePathPrefix.slice(0, -1)
    : scopePathPrefix;
  const combinedPath = `${scopePrefix}${target.pathname}`;

  try {
    const scoped = new URL(target.origin);
    scoped.pathname = combinedPath;
    scoped.search = "";
    scoped.hash = "";
    return scoped;
  } catch {
    return null;
  }
}

function splitFrontmatter(markdown: string): {
  frontmatter: string;
  body: string;
} {
  const match = markdown.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: "", body: markdown };
  }
  return {
    frontmatter: match[1] ?? "",
    body: match[2] ?? "",
  };
}

function normalizeFrontmatterSource(frontmatter: string): string {
  if (!frontmatter) {
    return frontmatter;
  }

  const lines = frontmatter.split(LINE_SPLIT_REGEX);
  let updated = false;
  const normalizedLines = lines.map((line) => {
    const match = line.match(SOURCE_LINE_REGEX);
    if (!match) {
      return line;
    }
    const rawValue = match[1]?.trim() ?? "";
    const normalized = normalizeSourceValue(rawValue);
    if (!normalized) {
      return line;
    }
    updated = true;
    return `Source: ${normalized}`;
  });

  return updated ? normalizedLines.join("\n") : frontmatter;
}

interface FenceState {
  inFence: boolean;
  fenceMarker: string | null;
}

function createFenceState(): FenceState {
  return { inFence: false, fenceMarker: null };
}

function shouldSkipLineForFence(line: string, state: FenceState): boolean {
  const fenceMatch = line.match(FENCE_REGEX);
  if (!fenceMatch) {
    return state.inFence;
  }

  const marker = fenceMatch[1] ?? "";
  if (!state.inFence) {
    state.inFence = true;
    state.fenceMarker = marker;
    return true;
  }

  if (!state.fenceMarker || marker.startsWith(state.fenceMarker)) {
    state.inFence = false;
    state.fenceMarker = null;
  }

  return true;
}

function collectBareUrlsFromMarkdown(markdown: string): string[] {
  const urls: string[] = [];
  const lines = markdown.split("\n");
  const fenceState = createFenceState();

  for (const line of lines) {
    if (shouldSkipLineForFence(line, fenceState)) {
      continue;
    }

    if (REFERENCE_LINE_REGEX.test(line)) {
      continue;
    }

    urls.push(...collectBareUrlsFromLine(line));
  }

  return urls;
}

function collectBareUrlsFromLine(line: string): string[] {
  const urls: string[] = [];
  const inlineCodeRanges = getInlineCodeRanges(line);
  const inlineLinkRanges = getInlineLinkRanges(line);
  const bareUrlRegex = new RegExp(BARE_URL_REGEX);

  for (const match of line.matchAll(bareUrlRegex)) {
    const rawMatch = match[0] ?? "";
    const matchIndex = match.index ?? 0;

    if (
      shouldSkipBareUrl(line, matchIndex, inlineCodeRanges, inlineLinkRanges)
    ) {
      continue;
    }

    const { url } = splitTrailingPunctuation(rawMatch);
    if (url) {
      urls.push(url);
    }
  }

  return urls;
}

async function linkifyBareUrlsInLine(
  line: string,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string
): Promise<string> {
  const inlineCodeRanges = getInlineCodeRanges(line);
  const inlineLinkRanges = getInlineLinkRanges(line);
  const bareUrlRegex = new RegExp(BARE_URL_REGEX);
  let result = "";
  let lastIndex = 0;

  for (const match of line.matchAll(bareUrlRegex)) {
    const rawMatch = match[0] ?? "";
    const matchIndex = match.index ?? 0;

    result += line.slice(lastIndex, matchIndex);
    if (
      shouldSkipBareUrl(line, matchIndex, inlineCodeRanges, inlineLinkRanges)
    ) {
      result += rawMatch;
      lastIndex = matchIndex + rawMatch.length;
      continue;
    }
    const { url, trailing } = splitTrailingPunctuation(rawMatch);
    const replacement = url
      ? await resolveLinkToRelative(
          url,
          currentUrl,
          options,
          knownUrls,
          linkBaseUrl,
          linkHints,
          scopePathPrefix,
          true
        )
      : null;

    if (replacement) {
      result += `[${url}](${replacement})${trailing}`;
    } else {
      result += rawMatch;
    }

    lastIndex = matchIndex + rawMatch.length;
  }

  if (lastIndex < line.length) {
    result += line.slice(lastIndex);
  }

  return result;
}

function getInlineCodeRanges(line: string): [number, number][] {
  const ranges: [number, number][] = [];
  let index = 0;

  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }

    let tickCount = 1;
    while (index + tickCount < line.length && line[index + tickCount] === "`") {
      tickCount += 1;
    }
    const delimiter = "`".repeat(tickCount);
    const start = index;
    index += tickCount;
    const end = line.indexOf(delimiter, index);
    if (end === -1) {
      break;
    }
    ranges.push([start, end + tickCount]);
    index = end + tickCount;
  }

  return ranges;
}

function getInlineLinkRanges(line: string): [number, number][] {
  const ranges: [number, number][] = [];
  const inlineLinkRegex = new RegExp(INLINE_LINK_REGEX);

  for (const match of line.matchAll(inlineLinkRegex)) {
    const matchIndex = match.index ?? -1;
    if (matchIndex >= 0) {
      ranges.push([matchIndex, matchIndex + match[0].length]);
    }
  }

  return ranges;
}

function shouldSkipBareUrl(
  line: string,
  matchIndex: number,
  inlineCodeRanges: [number, number][],
  inlineLinkRanges: [number, number][]
): boolean {
  if (isIndexInRanges(matchIndex, inlineCodeRanges)) {
    return true;
  }
  if (isIndexInRanges(matchIndex, inlineLinkRanges)) {
    return true;
  }
  if (isInsideTag(line, matchIndex)) {
    return true;
  }
  if (isInlineLinkContext(line, matchIndex)) {
    return true;
  }
  if (line.slice(matchIndex - 1, matchIndex) === "<") {
    return true;
  }
  return false;
}

function isIndexInRanges(index: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) {
      return true;
    }
  }
  return false;
}

function isInsideTag(line: string, index: number): boolean {
  const lastOpen = line.lastIndexOf("<", index);
  const lastClose = line.lastIndexOf(">", index);
  if (lastOpen <= lastClose) {
    return false;
  }
  const nextClose = line.indexOf(">", index);
  return nextClose !== -1;
}

function isInlineLinkContext(line: string, index: number): boolean {
  const before = line.slice(0, index);
  const trimmedBefore = before.replace(TRAILING_WHITESPACE_REGEX, "");
  return trimmedBefore.endsWith("](");
}

function splitTrailingPunctuation(value: string): {
  url: string;
  trailing: string;
} {
  const match = value.match(TRAILING_PUNCTUATION_REGEX);
  if (!match) {
    return { url: value, trailing: "" };
  }
  const trailing = match[0] ?? "";
  return {
    url: value.slice(0, -trailing.length),
    trailing,
  };
}

export async function rewriteLinksInResult(
  result: ScrapeResult,
  currentUrl: string,
  options: CliOptions,
  knownUrls: Set<string>,
  linkBaseUrl?: string,
  linkHints?: Set<string>,
  scopePathPrefix?: string
): Promise<ScrapeResult> {
  return {
    markdown: await rewriteMarkdownContent(
      result.markdown,
      currentUrl,
      options,
      knownUrls,
      linkBaseUrl,
      linkHints,
      scopePathPrefix
    ),
    clutterMarkdown:
      options.clutter && result.clutterMarkdown
        ? await rewriteMarkdownContent(
            result.clutterMarkdown,
            currentUrl,
            options,
            knownUrls,
            linkBaseUrl,
            linkHints,
            scopePathPrefix
          )
        : "",
    llmsMarkdown: await rewriteMarkdownContent(
      result.llmsMarkdown,
      currentUrl,
      options,
      knownUrls,
      linkBaseUrl,
      linkHints,
      scopePathPrefix
    ),
    llmsFullMarkdown: await rewriteMarkdownContent(
      result.llmsFullMarkdown,
      currentUrl,
      options,
      knownUrls,
      linkBaseUrl,
      linkHints,
      scopePathPrefix
    ),
  };
}
