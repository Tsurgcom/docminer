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

export const turndownService = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});
