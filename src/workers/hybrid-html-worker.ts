import { JSDOM } from "jsdom";
import { extractContent } from "../content";
import { writeOutputs } from "../io";
import {
  extractLinksFromDom,
  resolveDocumentBaseUrl,
  rewriteLinksInResult,
} from "../links";
import { fetchHtml, hasMeaningfulText, renderWithPlaywright } from "../network";
import { normalizeForQueue } from "../utils";
import type {
  JobPayload,
  MainToWorkerMessage,
  WorkerKind,
  WorkerOptions,
  WorkerToMainMessage,
} from "./protocol";

declare let self: Worker;

const knownUrls = new Set<string>();
let workerId = "";
let workerKind: WorkerKind = "hybrid";
let options: WorkerOptions | null = null;
let inactivityMs = 60_000;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let activeJob: JobPayload | null = null;
let pendingRenderJob: JobPayload | null = null;
let stopRequested = false;

const FRONTMATTER_REGEX = /^---[\s\S]*?---\s*/;
const MIN_MARKDOWN_CHARS = 200;

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
    if (activeJob || pendingRenderJob) {
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

const addKnownUrls = (urls: string[]): void => {
  for (const url of urls) {
    if (url) {
      knownUrls.add(url);
    }
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

const isMarkdownTooShort = (markdown: string): boolean => {
  const cleaned = markdown.replace(FRONTMATTER_REGEX, "").trim();
  return cleaned.length < MIN_MARKDOWN_CHARS;
};

const buildResult = async (
  html: string,
  job: JobPayload,
  workerOptions: WorkerOptions
): Promise<{
  rewritten: Awaited<ReturnType<typeof rewriteLinksInResult>>;
  links: string[];
}> => {
  const dom = new JSDOM(html, { url: job.url });
  const document = dom.window.document;
  const linkBaseUrl = resolveDocumentBaseUrl(document, new URL(job.url));
  const crawlContext = job.crawl;
  const linkCandidates =
    job.canGoDeeper && crawlContext
      ? extractLinksFromDom(
          document,
          new URL(job.url),
          crawlContext.scopeOrigin,
          crawlContext.scopePathPrefix
        )
      : [];
  const linkHints =
    linkCandidates.length > 0
      ? new Set(linkCandidates.map((link) => normalizeForQueue(new URL(link))))
      : undefined;

  const result = extractContent(html, job.url, {
    readabilityDom: dom,
    cleaningDocument: document.cloneNode(true) as Document,
  });

  const rewritten = await rewriteLinksInResult(
    result,
    job.url,
    { ...workerOptions, verbose: false },
    knownUrls,
    linkBaseUrl.toString(),
    linkHints,
    crawlContext?.scopePathPrefix
  );

  return { rewritten, links: linkCandidates };
};

const runJob = async (job: JobPayload): Promise<void> => {
  const workerOptions = options;
  if (!workerOptions) {
    return;
  }
  activeJob = job;
  clearInactivityTimer();

  try {
    knownUrls.add(normalizeForQueue(new URL(job.url)));
    await waitUntil(job.waitUntilMs, job);
    post({
      type: "progress",
      workerId,
      jobId: job.jobId,
      stage: "fetch",
      url: job.url,
    });

    const html = await fetchHtml(job.url, {
      timeoutMs: workerOptions.timeoutMs,
      retries: workerOptions.retries,
      userAgent: workerOptions.userAgent,
      verbose: workerOptions.verbose,
    });

    post({
      type: "progress",
      workerId,
      jobId: job.jobId,
      stage: "parse",
      url: job.url,
    });

    const { rewritten, links } = await buildResult(html, job, workerOptions);
    const insufficient =
      !hasMeaningfulText(html) || isMarkdownTooShort(rewritten.llmsMarkdown);

    if (insufficient) {
      pendingRenderJob = job;
      post({
        type: "htmlInsufficient",
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
      discoveredLinks: links,
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
    if (!pendingRenderJob) {
      requestNext();
    }
  }
};

const runRender = async (job: JobPayload): Promise<void> => {
  const workerOptions = options;
  if (!workerOptions) {
    return;
  }
  clearInactivityTimer();
  pendingRenderJob = null;

  try {
    post({
      type: "progress",
      workerId,
      jobId: job.jobId,
      stage: "fetch",
      url: job.url,
    });

    const renderedHtml = await renderWithPlaywright(job.url, {
      timeoutMs: workerOptions.timeoutMs,
      userAgent: workerOptions.userAgent,
      verbose: workerOptions.verbose,
    });

    post({
      type: "progress",
      workerId,
      jobId: job.jobId,
      stage: "parse",
      url: job.url,
    });

    const { rewritten, links } = await buildResult(
      renderedHtml,
      job,
      workerOptions
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
      discoveredLinks: links,
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
    post({ type: "ready", workerId, kind: workerKind });
    requestNext();
    return;
  }

  if (message.type === "knownUrls") {
    addKnownUrls(message.urls);
    return;
  }

  if (message.type === "stop") {
    stopRequested = true;
    if (!(activeJob || pendingRenderJob)) {
      post({ type: "stopped", workerId, reason: "stop" });
      process.exit(0);
    }
    return;
  }

  if (message.type === "assign") {
    if (activeJob || pendingRenderJob) {
      return;
    }
    runJob(message.job);
    return;
  }

  if (
    message.type === "renderWithPlaywright" &&
    pendingRenderJob &&
    pendingRenderJob.jobId === message.jobId
  ) {
    runRender(pendingRenderJob);
  }
};
