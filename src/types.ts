export interface CliOptions {
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
  clutter: boolean;
  render: boolean;
  progress: boolean;
  maxDepth: number;
  maxPages: number;
  delayMs: number;
  respectRobots: boolean;
}

export interface ScrapeResult {
  markdown: string;
  clutterMarkdown: string;
  llmsMarkdown: string;
  llmsFullMarkdown: string;
}

export interface RobotsPolicy {
  isAllowed: (pathname: string) => boolean;
  crawlDelayMs?: number;
  source: string;
}

export interface CrawlQueueItem {
  url: string;
  depth: number;
}

export interface FindOptions {
  query: string;
  directory: string;
  filesOnly: boolean;
  contentOnly: boolean;
  limit: number;
  contextLines: number;
}

export interface ContentMatch {
  lineNumber: number;
  line: string;
  matchIndex: number;
  matchLength: number;
  contextBefore: string[];
  contextAfter: string[];
}

export interface FindResult {
  filePath: string;
  relativePath: string;
  score: number;
  matchType: "path" | "content";
  pathIndices?: number[];
  contentMatches?: ContentMatch[];
}
