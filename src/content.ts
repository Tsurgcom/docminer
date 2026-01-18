import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import {
  CLUTTER_SELECTORS,
  LINE_SPLIT_REGEX,
  turndownService,
} from "./constants";
import type { ScrapeResult } from "./types";

const MARKDOWN_TITLE_REGEX = /^#{1,6}\s+(.+?)\s*$/m;

export interface ContentDomContext {
  readabilityDom?: JSDOM;
  cleaningDocument?: Document;
}

export function stripClutter(document: Document): {
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

export function extractContent(
  html: string,
  targetUrl: string,
  domContext?: ContentDomContext
): ScrapeResult {
  const domForReadability =
    domContext?.readabilityDom ?? new JSDOM(html, { url: targetUrl });
  const cleaningDocument =
    domContext?.cleaningDocument ??
    new JSDOM(html, { url: targetUrl }).window.document;

  const reader = new Readability(domForReadability.window.document);
  const article = reader.parse();

  const { cleanedHtml: fallbackHtml, clutterHtml } =
    stripClutter(cleaningDocument);

  const rawBodyHtml = domForReadability.window.document.body.innerHTML;
  let mainHtml = article?.content;
  if (!mainHtml || mainHtml.trim().length === 0) {
    mainHtml =
      fallbackHtml && fallbackHtml.trim().length > 0
        ? fallbackHtml
        : rawBodyHtml;
  }
  const title =
    article?.title ??
    cleaningDocument.title ??
    domForReadability.window.document.title ??
    targetUrl;

  const markdownBody = turndownService.turndown(mainHtml);
  const clutterMarkdown = clutterHtml
    ? turndownService.turndown(clutterHtml)
    : "";
  const llmsMarkdown = markdownBody;
  const llmsFullMarkdown = turndownService.turndown(html);

  const header = buildHeader(targetUrl, title);

  return {
    markdown: `${header}${markdownBody}\n`,
    clutterMarkdown: clutterMarkdown ? `${header}${clutterMarkdown}\n` : "",
    llmsMarkdown: `${header}${llmsMarkdown}\n`,
    llmsFullMarkdown: `${header}${llmsFullMarkdown}\n`,
  };
}

function buildHeader(targetUrl: string, title: string): string {
  return [
    "---",
    `Source: ${targetUrl}`,
    `Fetched: ${new Date().toISOString()}`,
    "---\n",
    `# ${title}\n`,
  ].join("\n");
}

function findMarkdownTitle(markdown: string): string | null {
  const match = markdown.match(MARKDOWN_TITLE_REGEX);
  return match ? (match[1]?.trim() ?? null) : null;
}

function getFirstNonEmptyLine(markdown: string): string | null {
  const lines = markdown.split(LINE_SPLIT_REGEX);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function hasLeadingHeading(markdown: string): boolean {
  const firstLine = getFirstNonEmptyLine(markdown);
  return firstLine ? MARKDOWN_TITLE_REGEX.test(firstLine) : false;
}

export function extractMarkdownContent(
  markdown: string,
  targetUrl: string
): ScrapeResult {
  const body = markdown.trim();
  const hasTitle = hasLeadingHeading(body);
  const title = findMarkdownTitle(body) ?? targetUrl;
  const header = hasTitle
    ? buildFrontmatter(targetUrl)
    : `${buildFrontmatter(targetUrl)}# ${title}\n\n`;
  const combined = body.length > 0 ? `${header}${body}\n` : header;

  return {
    markdown: combined,
    clutterMarkdown: "",
    llmsMarkdown: combined,
    llmsFullMarkdown: combined,
  };
}

function buildFrontmatter(targetUrl: string): string {
  return [
    "---",
    `Source: ${targetUrl}`,
    `Fetched: ${new Date().toISOString()}`,
    "---",
    "",
  ].join("\n");
}
