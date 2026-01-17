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
  render: boolean;
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
