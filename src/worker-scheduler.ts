import { logger } from "./logger";
import { buildAllowAllPolicy, loadRobotsPolicy } from "./robots";
import type { CliOptions, RobotsPolicy } from "./types";
import { normalizeForQueue } from "./utils";
import type {
  CrawlContext,
  JobPayload,
  MainToWorkerMessage,
  WorkerKind,
  WorkerToMainMessage,
} from "./workers/protocol";

interface QueueItem {
  jobId: string;
  url: string;
  depth: number;
  canGoDeeper: boolean;
  crawl?: CrawlContext;
}

interface WorkerState {
  id: string;
  kind: WorkerKind;
  worker: Worker;
  idle: boolean;
  stopping: boolean;
  currentJobId: string | null;
}

interface WorkerPool {
  workers: Map<string, WorkerState>;
  spawnWorker: (kind: WorkerKind) => WorkerState;
  stopWorker: (workerId: string) => void;
  stopAll: () => Promise<void>;
  broadcastKnownUrls: (urls: string[]) => void;
}

const MIN_TOTAL_WORKERS = 2;
const WORKER_INACTIVITY_MS = 60_000;

const createJobId = (): string => crypto.randomUUID();

const createWorkerOptions = (options: CliOptions): CliOptions => ({
  ...options,
  verbose: false,
  progress: false,
});

const createWorkerPool = (
  options: CliOptions,
  onMessage: (state: WorkerState, message: WorkerToMainMessage) => void
): WorkerPool => {
  const workers = new Map<string, WorkerState>();
  const stopResolvers = new Map<string, () => void>();
  const workerOptions = createWorkerOptions(options);

  const updateWorkerCounts = (): void => {
    let markdown = 0;
    let hybrid = 0;
    for (const state of workers.values()) {
      if (state.kind === "markdown") {
        markdown += 1;
      } else {
        hybrid += 1;
      }
    }
    logger.setWorkerCounts(markdown + hybrid, markdown, hybrid);
  };

  const handleStopped = (workerId: string): void => {
    const state = workers.get(workerId);
    if (!state) {
      return;
    }
    workers.delete(workerId);
    updateWorkerCounts();
    const resolve = stopResolvers.get(workerId);
    if (resolve) {
      resolve();
      stopResolvers.delete(workerId);
    }
  };

  const isMainMessage = (
    message: WorkerToMainMessage | MainToWorkerMessage
  ): message is MainToWorkerMessage =>
    message.type === "assign" ||
    message.type === "init" ||
    message.type === "knownUrls" ||
    message.type === "renderWithPlaywright" ||
    message.type === "stop";

  const formatMainMessage = (message: MainToWorkerMessage): string => {
    switch (message.type) {
      case "assign":
        return `assign job=${message.job.jobId} url=${message.job.url} waitUntilMs=${message.job.waitUntilMs}`;
      case "init":
        return `init kind=${message.kind} inactivityMs=${message.inactivityMs}`;
      case "knownUrls":
        return `knownUrls count=${message.urls.length}`;
      case "renderWithPlaywright":
        return `renderWithPlaywright job=${message.jobId}`;
      case "stop":
        return "stop";
      default:
        return "unknown";
    }
  };

  const formatWorkerMessage = (message: WorkerToMainMessage): string => {
    switch (message.type) {
      case "ready":
        return `ready kind=${message.kind}`;
      case "requestTarget":
        return `requestTarget kind=${message.kind}`;
      case "progress":
        return `progress job=${message.jobId} stage=${message.stage} url=${message.url}`;
      case "completed":
        return `completed job=${message.jobId} url=${message.url} links=${message.discoveredLinks.length}`;
      case "failed":
        return `failed job=${message.jobId} url=${message.url} error=${message.error}`;
      case "markdownUnavailable":
        return `markdownUnavailable job=${message.jobId} url=${message.url}`;
      case "htmlInsufficient":
        return `htmlInsufficient job=${message.jobId} url=${message.url}`;
      case "stopped":
        return `stopped reason=${message.reason}`;
      default:
        return "unknown";
    }
  };

  const formatMessageSummary = (
    message: WorkerToMainMessage | MainToWorkerMessage
  ): string =>
    isMainMessage(message)
      ? formatMainMessage(message)
      : formatWorkerMessage(message);

  const logOutgoing = (
    state: WorkerState,
    message: MainToWorkerMessage
  ): void => {
    if (!logger.verbose) {
      return;
    }
    logger.debug(
      `-> ${state.kind}:${state.id} ${formatMessageSummary(message)}`
    );
  };

  const logIncoming = (
    state: WorkerState,
    message: WorkerToMainMessage
  ): void => {
    if (!logger.verbose) {
      return;
    }
    logger.debug(
      `<- ${state.kind}:${state.id} ${formatMessageSummary(message)}`
    );
  };

  const spawnWorker = (kind: WorkerKind): WorkerState => {
    const workerPath =
      kind === "markdown"
        ? "./src/workers/markdown-worker.ts"
        : "./src/workers/hybrid-html-worker.ts";
    const worker =
      kind === "markdown"
        ? new Worker(workerPath, { smol: true })
        : new Worker(workerPath);
    const id = crypto.randomUUID();
    const state: WorkerState = {
      id,
      kind,
      worker,
      idle: false,
      stopping: false,
      currentJobId: null,
    };
    workers.set(id, state);
    updateWorkerCounts();

    worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as WorkerToMainMessage;
      if (!message) {
        return;
      }
      if (message.type === "stopped") {
        logIncoming(state, message);
        handleStopped(state.id);
        return;
      }
      logIncoming(state, message);
      onMessage(state, message);
    });

    worker.addEventListener("close", () => {
      handleStopped(state.id);
    });

    worker.addEventListener("error", (event) => {
      logger.error(`Worker ${state.id} failed: ${String(event)}`);
      handleStopped(state.id);
    });

    const initMessage: MainToWorkerMessage = {
      type: "init",
      workerId: id,
      kind,
      options: workerOptions,
      inactivityMs: WORKER_INACTIVITY_MS,
    };
    logOutgoing(state, initMessage);
    worker.postMessage(initMessage);

    return state;
  };

  const stopWorker = (workerId: string): void => {
    const state = workers.get(workerId);
    if (!state || state.stopping) {
      return;
    }
    state.stopping = true;
    const stopMessage: MainToWorkerMessage = { type: "stop" };
    logOutgoing(state, stopMessage);
    state.worker.postMessage(stopMessage);
  };

  const stopAll = async (): Promise<void> => {
    const pending = Array.from(workers.values()).map(
      (state) =>
        new Promise<void>((resolve) => {
          stopResolvers.set(state.id, resolve);
          state.stopping = true;
          const stopMessage: MainToWorkerMessage = { type: "stop" };
          logOutgoing(state, stopMessage);
          state.worker.postMessage(stopMessage);
        })
    );
    await Promise.allSettled(pending);
    updateWorkerCounts();
  };

  const broadcastKnownUrls = (urls: string[]): void => {
    if (urls.length === 0) {
      return;
    }
    for (const state of workers.values()) {
      const knownMessage: MainToWorkerMessage = { type: "knownUrls", urls };
      logOutgoing(state, knownMessage);
      state.worker.postMessage(knownMessage);
    }
  };

  return { workers, spawnWorker, stopWorker, stopAll, broadcastKnownUrls };
};

const computeWaitUntil = (
  nextAllowedByOrigin: Map<string, number>,
  url: string,
  delayMs: number
): number => {
  const now = Date.now();
  if (delayMs <= 0) {
    return now;
  }
  const origin = new URL(url).origin;
  const nextAllowed = nextAllowedByOrigin.get(origin) ?? 0;
  const waitUntil = Math.max(now, nextAllowed);
  nextAllowedByOrigin.set(origin, waitUntil + delayMs);
  return waitUntil;
};

export async function runScrapeWithWorkers(
  urls: string[],
  options: CliOptions
): Promise<void> {
  const totalUrls = urls.length;
  const totalWorkers = Math.max(options.concurrency, MIN_TOTAL_WORKERS);
  let markdownTarget = Math.max(1, totalWorkers - 1);
  const markdownQueue: QueueItem[] = [];
  const hybridQueue: QueueItem[] = [];
  const jobMap = new Map<string, QueueItem>();
  const knownUrls = new Set<string>();
  const idleMarkdown = new Set<string>();
  const idleHybrid = new Set<string>();
  const nextAllowedByOrigin = new Map<string, number>();
  const delayMs = Math.max(options.delayMs, 0);
  let inFlightCount = 0;
  let processedCount = 0;
  let doneResolve: (() => void) | null = null;
  let isDone = false;

  for (const url of urls) {
    const normalized = normalizeForQueue(new URL(url));
    knownUrls.add(normalized);
    const jobId = createJobId();
    const item: QueueItem = {
      jobId,
      url,
      depth: 0,
      canGoDeeper: false,
    };
    jobMap.set(jobId, item);
    markdownQueue.push(item);
  }

  logger.startProgress(totalUrls);

  let pool: WorkerPool;

  const markIdle = (state: WorkerState): void => {
    state.idle = true;
    if (state.kind === "markdown") {
      idleMarkdown.add(state.id);
    } else {
      idleHybrid.add(state.id);
    }
  };

  const assignNext = (state: WorkerState): void => {
    if (state.stopping) {
      return;
    }
    const queue = state.kind === "markdown" ? markdownQueue : hybridQueue;
    const next = queue.shift();
    if (!next) {
      markIdle(state);
      return;
    }
    idleMarkdown.delete(state.id);
    idleHybrid.delete(state.id);
    state.idle = false;
    state.currentJobId = next.jobId;
    const waitUntilMs = computeWaitUntil(
      nextAllowedByOrigin,
      next.url,
      delayMs
    );
    const payload: JobPayload = {
      ...next,
      waitUntilMs,
    };
    inFlightCount += 1;
    logger.updateProgress(processedCount, next.url, totalUrls);
    if (logger.verbose) {
      logger.debug(
        `-> ${state.kind}:${state.id} assign job=${payload.jobId} url=${payload.url} waitUntilMs=${payload.waitUntilMs}`
      );
    }
    state.worker.postMessage({ type: "assign", job: payload });
  };

  const dispatchIdle = (): void => {
    for (const workerId of Array.from(idleMarkdown)) {
      const state = pool.workers.get(workerId);
      if (state) {
        assignNext(state);
      }
    }
    for (const workerId of Array.from(idleHybrid)) {
      const state = pool.workers.get(workerId);
      if (state) {
        assignNext(state);
      }
    }
  };

  const checkDone = (): void => {
    if (isDone) {
      return;
    }
    if (
      processedCount >= urls.length &&
      inFlightCount <= 0 &&
      markdownQueue.length === 0 &&
      hybridQueue.length === 0
    ) {
      isDone = true;
      if (doneResolve) {
        doneResolve();
      }
    }
  };

  const handleProgress = (
    message: Extract<WorkerToMainMessage, { type: "progress" }>
  ): void => {
    if (message.stage === "fetch") {
      logger.updateProgress(processedCount, message.url, totalUrls);
    }
  };

  const handleCompleted = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "completed" }>
  ): void => {
    inFlightCount -= 1;
    processedCount += 1;
    state.currentJobId = null;
    jobMap.delete(message.jobId);
    logger.incrementProgress(message.url);
    logger.logPageSaved(message.url, undefined, `${state.kind}:${state.id}`);
    checkDone();
  };

  const handleFailed = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "failed" }>
  ): void => {
    inFlightCount -= 1;
    processedCount += 1;
    state.currentJobId = null;
    logger.recordFailure();
    logger.error(`Failed ${message.url}: ${message.error}`);
    logger.incrementProgress(message.url);
    jobMap.delete(message.jobId);
    checkDone();
  };

  const handleMarkdownUnavailable = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "markdownUnavailable" }>
  ): void => {
    inFlightCount -= 1;
    state.currentJobId = null;
    const job = jobMap.get(message.jobId);
    if (job) {
      hybridQueue.push(job);
      dispatchIdle();
    }
    if (state.kind === "markdown" && markdownTarget > 1) {
      markdownTarget -= 1;
      pool.stopWorker(state.id);
      pool.spawnWorker("hybrid");
    }
    checkDone();
  };

  const handleHtmlInsufficient = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "htmlInsufficient" }>
  ): void => {
    logger.info(
      `Insufficient HTML content; rendering with Playwright for ${message.url}`
    );
    if (logger.verbose) {
      logger.debug(
        `-> ${state.kind}:${state.id} renderWithPlaywright job=${message.jobId}`
      );
    }
    state.worker.postMessage({
      type: "renderWithPlaywright",
      jobId: message.jobId,
    });
  };

  const handleScrapeMessage = (
    state: WorkerState,
    message: WorkerToMainMessage
  ): void => {
    switch (message.type) {
      case "ready":
        return;
      case "requestTarget":
        assignNext(state);
        return;
      case "progress":
        handleProgress(message);
        return;
      case "completed":
        handleCompleted(state, message);
        return;
      case "failed":
        handleFailed(state, message);
        return;
      case "markdownUnavailable":
        handleMarkdownUnavailable(state, message);
        return;
      case "htmlInsufficient":
        handleHtmlInsufficient(state, message);
        return;
      default:
        return;
    }
  };

  pool = createWorkerPool(options, handleScrapeMessage);

  for (let i = 0; i < markdownTarget; i += 1) {
    pool.spawnWorker("markdown");
  }
  for (let i = 0; i < totalWorkers - markdownTarget; i += 1) {
    pool.spawnWorker("hybrid");
  }

  pool.broadcastKnownUrls(Array.from(knownUrls));

  await new Promise<void>((resolve) => {
    doneResolve = resolve;
    checkDone();
  });

  await pool.stopAll();
  logger.endProgress();
}

export async function runCrawlWithWorkers(
  startUrl: string,
  options: CliOptions
): Promise<void> {
  const start = new URL(startUrl);
  const scopeOrigin = start.origin;
  const scopePathPrefix = start.pathname.endsWith("/")
    ? start.pathname
    : `${start.pathname}`;

  logger.logCrawlStart(startUrl, {
    maxDepth: options.maxDepth,
    maxPages: options.maxPages,
    delay: `${options.delayMs}ms`,
    concurrency: options.concurrency,
    respectRobots: options.respectRobots,
  });

  const robotsPolicy: RobotsPolicy = options.respectRobots
    ? await loadRobotsPolicy(start, {
        timeoutMs: options.timeoutMs,
        userAgent: options.userAgent,
        verbose: options.verbose,
      })
    : buildAllowAllPolicy();

  const effectiveDelay = Math.max(
    options.delayMs,
    robotsPolicy.crawlDelayMs ?? 0
  );

  const totalWorkers = Math.max(options.concurrency, MIN_TOTAL_WORKERS);
  let markdownTarget = Math.max(1, totalWorkers - 1);
  const markdownQueue: QueueItem[] = [];
  const hybridQueue: QueueItem[] = [];
  const jobMap = new Map<string, QueueItem>();
  const knownUrls = new Set<string>();
  const visited = new Set<string>();
  const failures: string[] = [];
  const idleMarkdown = new Set<string>();
  const idleHybrid = new Set<string>();
  const nextAllowedByOrigin = new Map<string, number>();
  let savedCount = 0;
  let inFlightCount = 0;
  let doneResolve: (() => void) | null = null;
  let isDone = false;

  const crawlContext: CrawlContext = {
    scopeOrigin,
    scopePathPrefix,
  };

  const initialJobId = createJobId();
  const initialItem: QueueItem = {
    jobId: initialJobId,
    url: start.toString(),
    depth: 0,
    canGoDeeper: options.maxDepth > 0,
    crawl: crawlContext,
  };

  const initialNormalized = normalizeForQueue(start);
  knownUrls.add(initialNormalized);
  jobMap.set(initialJobId, initialItem);
  markdownQueue.push(initialItem);

  const getPendingCount = (): number =>
    markdownQueue.length + hybridQueue.length;
  const getDynamicTotal = (): number =>
    savedCount + inFlightCount + getPendingCount();

  logger.startProgress(getDynamicTotal());

  let pool: WorkerPool;

  const markIdle = (state: WorkerState): void => {
    state.idle = true;
    if (state.kind === "markdown") {
      idleMarkdown.add(state.id);
    } else {
      idleHybrid.add(state.id);
    }
  };

  const enqueueKnownUrls = (urls: string[]): void => {
    if (urls.length === 0) {
      return;
    }
    pool.broadcastKnownUrls(urls);
  };

  const maybeFinish = (): void => {
    if (isDone) {
      return;
    }
    if (savedCount >= options.maxPages) {
      isDone = true;
    } else if (
      inFlightCount <= 0 &&
      markdownQueue.length === 0 &&
      hybridQueue.length === 0
    ) {
      isDone = true;
    }

    if (isDone && doneResolve) {
      doneResolve();
    }
  };

  const enqueueLinks = (links: string[], parentDepth: number): void => {
    if (links.length === 0) {
      return;
    }
    let added = 0;
    const broadcast: string[] = [];
    for (const link of links) {
      const pending = getPendingCount();
      if (savedCount + pending >= options.maxPages) {
        break;
      }
      const normalized = normalizeForQueue(new URL(link));
      if (visited.has(normalized) || knownUrls.has(normalized)) {
        continue;
      }
      knownUrls.add(normalized);
      broadcast.push(normalized);
      const nextDepth = parentDepth + 1;
      const jobId = createJobId();
      const job: QueueItem = {
        jobId,
        url: link,
        depth: nextDepth,
        canGoDeeper: nextDepth < options.maxDepth,
        crawl: crawlContext,
      };
      jobMap.set(jobId, job);
      markdownQueue.push(job);
      added += 1;
    }
    if (added > 0) {
      enqueueKnownUrls(broadcast);
      logger.setProgressTotal(getDynamicTotal());
      dispatchIdle();
    }
  };

  const assignMarkdownWorker = (state: WorkerState): void => {
    while (markdownQueue.length > 0) {
      const next = markdownQueue.shift();
      if (!next) {
        break;
      }
      const normalized = normalizeForQueue(new URL(next.url));
      if (visited.has(normalized)) {
        jobMap.delete(next.jobId);
        logger.setProgressTotal(getDynamicTotal());
        maybeFinish();
        continue;
      }
      visited.add(normalized);
      if (!robotsPolicy.isAllowed(new URL(next.url).pathname)) {
        logger.logBlocked(next.url, "robots.txt");
        jobMap.delete(next.jobId);
        logger.setProgressTotal(getDynamicTotal());
        maybeFinish();
        continue;
      }
      idleMarkdown.delete(state.id);
      state.idle = false;
      state.currentJobId = next.jobId;
      const waitUntilMs = computeWaitUntil(
        nextAllowedByOrigin,
        next.url,
        effectiveDelay
      );
      const payload: JobPayload = {
        ...next,
        waitUntilMs,
      };
      inFlightCount += 1;
      logger.updateProgress(savedCount, next.url, getDynamicTotal());
      if (logger.verbose) {
        logger.debug(
          `-> ${state.kind}:${state.id} assign job=${payload.jobId} url=${payload.url} waitUntilMs=${payload.waitUntilMs}`
        );
      }
      state.worker.postMessage({ type: "assign", job: payload });
      return;
    }
    markIdle(state);
  };

  const assignHybridWorker = (state: WorkerState): void => {
    const next = hybridQueue.shift();
    if (!next) {
      markIdle(state);
      return;
    }
    idleHybrid.delete(state.id);
    state.idle = false;
    state.currentJobId = next.jobId;
    const waitUntilMs = computeWaitUntil(
      nextAllowedByOrigin,
      next.url,
      effectiveDelay
    );
    const payload: JobPayload = {
      ...next,
      waitUntilMs,
    };
    inFlightCount += 1;
    logger.updateProgress(savedCount, next.url, getDynamicTotal());
    if (logger.verbose) {
      logger.debug(
        `-> ${state.kind}:${state.id} assign job=${payload.jobId} url=${payload.url} waitUntilMs=${payload.waitUntilMs}`
      );
    }
    state.worker.postMessage({ type: "assign", job: payload });
  };

  const assignNext = (state: WorkerState): void => {
    if (state.stopping) {
      return;
    }
    if (savedCount + inFlightCount >= options.maxPages) {
      markIdle(state);
      return;
    }

    if (state.kind === "markdown") {
      assignMarkdownWorker(state);
      return;
    }
    assignHybridWorker(state);
  };

  const dispatchIdle = (): void => {
    for (const workerId of Array.from(idleMarkdown)) {
      const state = pool.workers.get(workerId);
      if (state) {
        assignNext(state);
      }
    }
    for (const workerId of Array.from(idleHybrid)) {
      const state = pool.workers.get(workerId);
      if (state) {
        assignNext(state);
      }
    }
  };

  const handleProgress = (
    message: Extract<WorkerToMainMessage, { type: "progress" }>
  ): void => {
    if (message.stage === "fetch") {
      logger.updateProgress(savedCount, message.url, getDynamicTotal());
    }
  };

  const handleCompleted = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "completed" }>
  ): void => {
    inFlightCount -= 1;
    state.currentJobId = null;
    jobMap.delete(message.jobId);
    savedCount += 1;
    logger.updateProgress(savedCount, message.url, getDynamicTotal());
    logger.logPageSaved(
      message.url,
      message.depth,
      `${state.kind}:${state.id}`
    );
    enqueueLinks(message.discoveredLinks, message.depth);
    maybeFinish();
  };

  const handleFailed = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "failed" }>
  ): void => {
    inFlightCount -= 1;
    state.currentJobId = null;
    jobMap.delete(message.jobId);
    failures.push(`${message.url}: ${message.error}`);
    logger.recordFailure();
    logger.error(`Failed ${message.url}: ${message.error}`);
    maybeFinish();
  };

  const handleMarkdownUnavailable = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "markdownUnavailable" }>
  ): void => {
    inFlightCount -= 1;
    state.currentJobId = null;
    const job = jobMap.get(message.jobId);
    if (job) {
      hybridQueue.push(job);
      dispatchIdle();
    }
    if (state.kind === "markdown" && markdownTarget > 1) {
      markdownTarget -= 1;
      pool.stopWorker(state.id);
      pool.spawnWorker("hybrid");
    }
    maybeFinish();
  };

  const handleHtmlInsufficient = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "htmlInsufficient" }>
  ): void => {
    logger.info(
      `Insufficient HTML content; rendering with Playwright for ${message.url}`
    );
    if (logger.verbose) {
      logger.debug(
        `-> ${state.kind}:${state.id} renderWithPlaywright job=${message.jobId}`
      );
    }
    state.worker.postMessage({
      type: "renderWithPlaywright",
      jobId: message.jobId,
    });
  };

  const handleCrawlMessage = (
    state: WorkerState,
    message: WorkerToMainMessage
  ): void => {
    switch (message.type) {
      case "ready":
        return;
      case "requestTarget":
        assignNext(state);
        return;
      case "progress":
        handleProgress(message);
        return;
      case "completed":
        handleCompleted(state, message);
        return;
      case "failed":
        handleFailed(state, message);
        return;
      case "markdownUnavailable":
        handleMarkdownUnavailable(state, message);
        return;
      case "htmlInsufficient":
        handleHtmlInsufficient(state, message);
        return;
      default:
        return;
    }
  };

  pool = createWorkerPool(options, handleCrawlMessage);

  for (let i = 0; i < markdownTarget; i += 1) {
    pool.spawnWorker("markdown");
  }
  for (let i = 0; i < totalWorkers - markdownTarget; i += 1) {
    pool.spawnWorker("hybrid");
  }

  pool.broadcastKnownUrls(Array.from(knownUrls));

  await new Promise<void>((resolve) => {
    doneResolve = resolve;
    maybeFinish();
  });

  await pool.stopAll();

  logger.endProgress();

  const skipped = visited.size - savedCount;
  if (skipped > 0) {
    logger.info(`Skipped ${skipped} duplicate/visited URL(s)`);
  }

  logger.printFailureSummary(failures);
}
