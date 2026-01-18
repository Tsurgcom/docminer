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
  clutter: false,
  render: true,
  progress: true,
  maxDepth: 5,
  maxPages: 1000,
  delayMs: 150,
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
  /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|woff2?|ttf|eot|css|js)$/i;

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

// Custom table handling to avoid tr.parentNode errors
interface TableNode extends TurndownNode {
  rows?: HTMLCollectionOf<HTMLTableRowElement> | ArrayLike<TurndownNode>;
  parentNode?: TableNode;
  firstChild?: TableNode;
  previousSibling?: TableNode;
}

const getCellContent = (cell: TurndownNode): string => {
  const content = collectTextContent(cell);
  // Escape pipe characters and normalize whitespace
  return content.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
};

const isHeadingCell = (node: TurndownNode): boolean => {
  return node.nodeName === "TH";
};

const collectTableRows = (
  element: TurndownNode,
  rows: TurndownNode[]
): void => {
  if (!element.childNodes) {
    return;
  }

  for (const child of Array.from(element.childNodes)) {
    if (!child) {
      continue;
    }

    if (child.nodeName === "TR") {
      rows.push(child);
    } else if (["THEAD", "TBODY", "TFOOT"].includes(child.nodeName ?? "")) {
      collectTableRows(child, rows);
    }
  }
};

const extractCellsFromRow = (row: TurndownNode): TurndownNode[] => {
  if (!row.childNodes) {
    return [];
  }

  const cells: TurndownNode[] = [];
  for (const cell of Array.from(row.childNodes)) {
    if (cell && ["TD", "TH"].includes(cell.nodeName ?? "")) {
      cells.push(cell);
    }
  }
  return cells;
};

const buildTableRow = (cells: TurndownNode[]): string => {
  const cellContents = cells.map(getCellContent);
  return `| ${cellContents.join(" | ")} |`;
};

const buildHeaderSeparator = (cellCount: number): string => {
  const separators = new Array(cellCount).fill("---");
  return `| ${separators.join(" | ")} |`;
};

const addDefaultHeader = (
  rows: TurndownNode[],
  markdownRows: string[]
): void => {
  const firstRow = rows[0];
  if (!firstRow?.childNodes) {
    return;
  }

  const cellCount = Array.from(firstRow.childNodes).filter(
    (cell) => cell && ["TD", "TH"].includes(cell.nodeName ?? "")
  ).length;

  if (cellCount > 0) {
    const headers = new Array(cellCount)
      .fill("Column")
      .map((c, i) => `${c} ${i + 1}`);
    const headerRow = `| ${headers.join(" | ")} |`;
    const separator = buildHeaderSeparator(cellCount);
    markdownRows.unshift(separator);
    markdownRows.unshift(headerRow);
  }
};

turndownService.addRule("tables", {
  filter: "table",
  replacement(content, node): string {
    const tableNode = node as TableNode;
    const rows: TurndownNode[] = [];

    collectTableRows(tableNode, rows);

    if (rows.length === 0) {
      return content;
    }

    const markdownRows: string[] = [];
    let hasHeader = false;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) {
        continue;
      }

      const cells = extractCellsFromRow(row);
      if (cells.length === 0) {
        continue;
      }

      const isHeaderRow = i === 0 || cells.some(isHeadingCell);
      const rowContent = buildTableRow(cells);
      markdownRows.push(rowContent);

      if (isHeaderRow && !hasHeader) {
        const separator = buildHeaderSeparator(cells.length);
        markdownRows.push(separator);
        hasHeader = true;
      }
    }

    if (markdownRows.length === 0) {
      return content;
    }

    if (!hasHeader && markdownRows.length > 0) {
      addDefaultHeader(rows, markdownRows);
    }

    return `\n\n${markdownRows.join("\n")}\n\n`;
  },
});

// Keep strikethrough support
turndownService.addRule("strikethrough", {
  filter: ["del", "s"],
  replacement(content): string {
    return `~~${content}~~`;
  },
});
