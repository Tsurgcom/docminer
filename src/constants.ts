import TurndownService from "turndown";
import type { CliOptions } from "./types";

export const DEFAULT_OPTIONS: CliOptions = {
  outDir: ".docs",
  concurrency: 4,
  timeoutMs: 15_000,
  retries: 2,
  userAgent: "aidocs-scraper/1.0",
  verbose: false,
  overwriteLlms: false,
  render: true,
  progress: true,
  maxDepth: 3,
  maxPages: 200,
  delayMs: 500,
  respectRobots: true,
};

export const CLUTTER_SELECTORS = [
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

export const BLOCKED_EXTENSIONS_REGEX =
  /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|woff2?|ttf|eot)$/i;

export const LINE_SPLIT_REGEX = /\r?\n/;
const HEADING_TAG_REGEX = /^H([1-6])$/i;

export const turndownService = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

interface TurndownNode {
  nodeName?: string;
  childNodes?: ArrayLike<TurndownNode>;
  textContent?: string | null;
  getAttribute?: (name: string) => string | null;
}

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const collectTextContent = (node: TurndownNode | null | undefined): string => {
  if (!node) {
    return "";
  }

  const childNodes = node.childNodes ? Array.from(node.childNodes) : [];
  if (childNodes.length === 0) {
    return node.textContent ?? "";
  }

  const parts = childNodes
    .map((child) => collectTextContent(child))
    .filter((text) => text.trim().length > 0);

  return collapseWhitespace(parts.join(" "));
};

const findTopmostHeadingLevel = (
  node: TurndownNode | null | undefined
): number | null => {
  if (!node) {
    return null;
  }

  const match = HEADING_TAG_REGEX.exec(node.nodeName ?? "");
  const ownLevel = match ? Number.parseInt(match[1] ?? "", 10) : null;

  const childNodes = node.childNodes ? Array.from(node.childNodes) : [];
  const childLevel = childNodes.reduce<number | null>((current, child) => {
    const level = findTopmostHeadingLevel(child);
    if (level === null) {
      return current;
    }
    if (current === null) {
      return level;
    }
    return Math.min(current, level);
  }, null);

  if (ownLevel === null) {
    return childLevel;
  }
  if (childLevel === null) {
    return ownLevel;
  }
  return Math.min(ownLevel, childLevel);
};

turndownService.addRule("singleLineAnchors", {
  filter: "a",
  replacement(content, node): string {
    const href =
      typeof node.getAttribute === "function"
        ? node.getAttribute("href")
        : null;
    const text = collapseWhitespace(
      collectTextContent(node as TurndownNode) || content
    );
    if (!href) {
      return text;
    }

    const headingLevel = findTopmostHeadingLevel(node as TurndownNode);
    const link = `[${text}](${href})`;

    if (!headingLevel) {
      return link;
    }

    const prefix = "#".repeat(headingLevel);
    return `${prefix} ${link}\n`;
  },
});
