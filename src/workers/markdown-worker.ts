import { BloomFilter, type KnownUrlLookup } from "../bloom";
import { extractMarkdownContent } from "../content";
import { writeOutputs } from "../io";
import { extractLinksFromMarkdown, rewriteLinksInResult } from "../links";
import { fetchMarkdownIfAvailable } from "../network";
import { normalizeForQueue } from "../utils";
import type {
  JobPayload,
  MainToWorkerMessage,
  WorkerKind,
  WorkerOptions,
  WorkerToMainMessage,
} from "./protocol";

declare let self: Worker;

const emptyKnownUrlFilter: KnownUrlLookup = { has: () => false };
let workerId = "";
let workerKind: WorkerKind = "markdown";
let options: WorkerOptions | null = null;
let inactivityMs = 60_000;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let activeJob: JobPayload | null = null;
let stopRequested = false;
let knownUrlFilter: KnownUrlLookup = emptyKnownUrlFilter;

const post = (message: WorkerToMainMessage): void => {
  postMessage(message);
};

const clearInactivityTimer = (): void => {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
};

const startInactivityTimer = (): void => {
  clearInactivityTimer();
  inactivityTimer = setTimeout(() => {
    if (activeJob) {
      startInactivityTimer();
      return;
    }
    post({ type: "stopped", workerId, reason: "idle" });
    process.exit(0);
  }, inactivityMs);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitUntil = async (
  deadlineMs: number,
  job: JobPayload
): Promise<void> => {
  while (true) {
    const now = Date.now();
    if (now >= deadlineMs) {
      return;
    }
    post({
      type: "progress",
      workerId,
      jobId: job.jobId,
      stage: "wait",
      url: job.url,
    });
    const wait = Math.min(50, deadlineMs - now);
    await sleep(wait);
  }
};

const requestNext = (): void => {
  if (stopRequested) {
    post({ type: "stopped", workerId, reason: "stop" });
    process.exit(0);
  }
  post({ type: "requestTarget", workerId, kind: workerKind });
  startInactivityTimer();
};

const runJob = async (job: JobPayload): Promise<void> => {
  const workerOptions = options;
  if (!workerOptions) {
    return;
  }
  activeJob = job;
  clearInactivityTimer();

  try {
    await waitUntil(job.waitUntilMs, job);
    post({
      type: "progress",
      workerId,
      jobId: job.jobId,
      stage: "fetch",
      url: job.url,
    });

    const markdownSource = await fetchMarkdownIfAvailable(job.url, {
      timeoutMs: workerOptions.timeoutMs,
      retries: workerOptions.retries,
      userAgent: workerOptions.userAgent,
      verbose: workerOptions.verbose,
    });

    if (!markdownSource || markdownSource.markdown.trim().length === 0) {
      post({
        type: "markdownUnavailable",
        workerId,
        jobId: job.jobId,
        url: job.url,
        depth: job.depth,
      });
      return;
    }

    post({
      type: "progress",
      workerId,
      jobId: job.jobId,
      stage: "parse",
      url: job.url,
    });

    const result = extractMarkdownContent(markdownSource.markdown, job.url);
    const crawlContext = job.crawl;
    const linkCandidates =
      job.canGoDeeper && crawlContext
        ? extractLinksFromMarkdown(
            markdownSource.markdown,
            new URL(job.url),
            crawlContext.scopeOrigin,
            crawlContext.scopePathPrefix
          )
        : [];
    const linkHints =
      linkCandidates.length > 0
        ? new Set(
            linkCandidates.map((link) => normalizeForQueue(new URL(link)))
          )
        : undefined;

    const rewritten = await rewriteLinksInResult(
      result,
      job.url,
      {
        ...workerOptions,
        verbose: false,
      },
      knownUrlFilter,
      undefined,
      linkHints,
      crawlContext?.scopePathPrefix
    );

    post({
      type: "progress",
      workerId,
      jobId: job.jobId,
      stage: "write",
      url: job.url,
    });

    await writeOutputs(
      job.url,
      { ...workerOptions, verbose: false },
      rewritten
    );
    post({
      type: "completed",
      workerId,
      jobId: job.jobId,
      url: job.url,
      depth: job.depth,
      discoveredLinks: linkCandidates,
    });
  } catch (error) {
    post({
      type: "failed",
      workerId,
      jobId: job.jobId,
      url: job.url,
      error: String(error),
    });
  } finally {
    activeJob = null;
    requestNext();
  }
};

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;
  if (!message) {
    return;
  }
  if (message.type === "init") {
    workerId = message.workerId;
    workerKind = message.kind;
    options = message.options;
    inactivityMs = message.inactivityMs;
    knownUrlFilter = message.knownUrlFilter
      ? new BloomFilter(message.knownUrlFilter)
      : emptyKnownUrlFilter;
    post({ type: "ready", workerId, kind: workerKind });
    requestNext();
    return;
  }

  if (message.type === "stop") {
    stopRequested = true;
    if (!activeJob) {
      post({ type: "stopped", workerId, reason: "stop" });
      process.exit(0);
    }
    return;
  }

  if (message.type === "assign") {
    if (activeJob) {
      return;
    }
    runJob(message.job);
  }
};
