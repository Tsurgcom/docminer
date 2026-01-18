import type { Dirent } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OPTIONS, LINE_SPLIT_REGEX } from "./constants";
import { rewriteMarkdownContent } from "./links";
import { logger } from "./logger";
import type { LinkCheckOptions } from "./types";
import { normalizeForQueue } from "./utils";

interface DocEntry {
  filePath: string;
  sourceUrl: string;
  content: string;
  origin: string;
  pathname: string;
}

const FRONTMATTER_BLOCK_REGEX = /^---\s*\n([\s\S]*?)\n---/;
const SOURCE_LINE_REGEX = /^Source:\s*(.+?)\s*$/i;
const SOURCE_MARKDOWN_LINK_REGEX = /^\[(.+?)\]\((.+?)\)$/;
const SOURCE_AUTOLINK_REGEX = /^<(.+)>$/;
const SOURCE_EXTERNAL_MARKER_REGEX = /\s*↗\s*$/;
const SOURCE_URL_PREFIX_REGEX = /^https?:\/\//i;

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent<string>[] = [];

    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  };

  await walk(directory);
  return files;
}

function extractSourceUrl(content: string): string | null {
  const frontmatterMatch = content.match(FRONTMATTER_BLOCK_REGEX);
  if (!frontmatterMatch) {
    return null;
  }
  const frontmatter = frontmatterMatch[1] ?? "";
  if (!frontmatter) {
    return null;
  }

  const lines = frontmatter.split(LINE_SPLIT_REGEX);
  for (const line of lines) {
    const match = line.match(SOURCE_LINE_REGEX);
    if (match) {
      const rawValue = match[1]?.trim() ?? "";
      return normalizeSourceValue(rawValue);
    }
  }

  return null;
}

function normalizeSourceValue(value: string): string | null {
  const trimmed = value.replace(SOURCE_EXTERNAL_MARKER_REGEX, "").trim();
  if (!trimmed) {
    return null;
  }

  const markdownMatch = trimmed.match(SOURCE_MARKDOWN_LINK_REGEX);
  if (markdownMatch) {
    const label = markdownMatch[1]?.trim() ?? "";
    const href = markdownMatch[2]?.trim() ?? "";
    return pickUrlCandidate(label, href);
  }

  const autoLinkMatch = trimmed.match(SOURCE_AUTOLINK_REGEX);
  if (autoLinkMatch) {
    const href = autoLinkMatch[1]?.trim() ?? "";
    return href || null;
  }

  return trimmed;
}

function pickUrlCandidate(label: string, href: string): string | null {
  if (SOURCE_URL_PREFIX_REGEX.test(label)) {
    return label;
  }
  if (SOURCE_URL_PREFIX_REGEX.test(href)) {
    return href;
  }
  return label || href || null;
}

function computeScopePathPrefix(paths: string[]): string {
  if (paths.length === 0) {
    return "/";
  }

  const segmentsList = paths.map((pathname) =>
    pathname.split("/").filter(Boolean)
  );

  if (segmentsList.length === 1) {
    const segments = segmentsList[0] ?? [];
    if (segments.length === 0) {
      return "/";
    }
    return `/${segments[0]}`;
  }
  let prefix = segmentsList[0] ?? [];

  for (const segments of segmentsList.slice(1)) {
    let i = 0;
    while (
      i < prefix.length &&
      i < segments.length &&
      prefix[i] === segments[i]
    ) {
      i += 1;
    }
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) {
      break;
    }
  }

  return prefix.length > 0 ? `/${prefix.join("/")}` : "/";
}

export async function runLinkCheckCommand(
  options: LinkCheckOptions
): Promise<void> {
  const { directory, verbose } = options;

  try {
    const stats = await stat(directory);
    if (!stats.isDirectory()) {
      logger.error(`"${directory}" is not a directory`);
      process.exitCode = 1;
      return;
    }
  } catch {
    logger.error(`Directory "${directory}" does not exist`);
    process.exitCode = 1;
    return;
  }

  logger.configure({ verbose, showProgress: false });

  const markdownFiles = await collectMarkdownFiles(directory);
  if (markdownFiles.length === 0) {
    logger.warn(`No markdown files found in "${directory}"`);
    return;
  }

  const entries: DocEntry[] = [];
  const knownUrls = new Set<string>();
  const originPaths = new Map<string, string[]>();

  for (const filePath of markdownFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      logger.warn(`Failed to read ${filePath}`);
      continue;
    }

    const sourceUrl = extractSourceUrl(content);
    if (!sourceUrl) {
      logger.warn(`Missing Source frontmatter in ${filePath}`);
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      logger.warn(`Invalid Source URL in ${filePath}: ${sourceUrl}`);
      continue;
    }

    const normalized = normalizeForQueue(parsed);
    knownUrls.add(normalized);

    const origin = parsed.origin;
    const originList = originPaths.get(origin) ?? [];
    originList.push(parsed.pathname);
    originPaths.set(origin, originList);

    entries.push({
      filePath,
      sourceUrl,
      content,
      origin,
      pathname: parsed.pathname,
    });
  }

  const scopePrefixes = new Map<string, string>();
  for (const [origin, paths] of originPaths.entries()) {
    scopePrefixes.set(origin, computeScopePathPrefix(paths));
  }

  const rewriteOptions = { ...DEFAULT_OPTIONS, outDir: directory };
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const entry of entries) {
    const scopePathPrefix = scopePrefixes.get(entry.origin) ?? "/";
    const rewritten = await rewriteMarkdownContent(
      entry.content,
      entry.sourceUrl,
      rewriteOptions,
      knownUrls,
      undefined,
      undefined,
      scopePathPrefix
    );

    if (rewritten !== entry.content) {
      await writeFile(entry.filePath, rewritten, "utf8");
      updatedCount += 1;
    } else {
      unchangedCount += 1;
    }
  }

  logger.success(
    `Link check complete: ${updatedCount} updated, ${unchangedCount} unchanged`
  );
}
