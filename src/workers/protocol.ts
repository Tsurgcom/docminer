import type { BloomFilterInit } from "../bloom";
import type { CliOptions } from "../types";

export type WorkerKind = "markdown" | "hybrid";

export type WorkerOptions = CliOptions;

export interface CrawlContext {
  scopeOrigin: string;
  scopePathPrefix: string;
}

export interface JobPayload {
  jobId: string;
  url: string;
  depth: number;
  canGoDeeper: boolean;
  waitUntilMs: number;
  crawl?: CrawlContext;
}

export type MainToWorkerMessage =
  | {
      type: "init";
      workerId: string;
      kind: WorkerKind;
      options: WorkerOptions;
      inactivityMs: number;
      knownUrlFilter: BloomFilterInit;
    }
  | {
      type: "assign";
      job: JobPayload;
    }
  | {
      type: "renderWithPlaywright";
      jobId: string;
    }
  | {
      type: "stop";
    };

export type WorkerToMainMessage =
  | {
      type: "ready";
      workerId: string;
      kind: WorkerKind;
    }
  | {
      type: "requestTarget";
      workerId: string;
      kind: WorkerKind;
    }
  | {
      type: "progress";
      workerId: string;
      jobId: string;
      stage: "wait" | "fetch" | "parse" | "write";
      url: string;
    }
  | {
      type: "completed";
      workerId: string;
      jobId: string;
      url: string;
      depth: number;
      discoveredLinks: string[];
    }
  | {
      type: "failed";
      workerId: string;
      jobId: string;
      url: string;
      error: string;
    }
  | {
      type: "markdownUnavailable";
      workerId: string;
      jobId: string;
      url: string;
      depth: number;
    }
  | {
      type: "htmlInsufficient";
      workerId: string;
      jobId: string;
      url: string;
      depth: number;
    }
  | {
      type: "stopped";
      workerId: string;
      reason: "stop" | "idle";
    };
