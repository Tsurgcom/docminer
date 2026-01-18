import { BloomFilter, type BloomFilterInit } from "./bloom";
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

const resolveWorkerPath = (workerName: string): string => {
  // Check if we're running from source (development) or built (production)
  const currentFile = import.meta.url;
  const isDevelopment = currentFile.includes("/src/");

  if (isDevelopment) {
    // In development, use TypeScript source files
    // Bun resolves paths relative to project root
    return `./src/workers/${workerName}.ts`;
  }

  // In production (when installed from npm)
  // Bun resolves paths relative to project root, but we need to find the package location
  // Try to detect if we're in node_modules and construct the path accordingly
  const isInNodeModules = currentFile.includes("/node_modules/");

  if (isInNodeModules) {
    // Extract package path from node_modules
    const nodeModulesIndex = currentFile.indexOf("/node_modules/");
    const afterNodeModules = currentFile.slice(
      nodeModulesIndex + "/node_modules/".length
    );
    const packageNameEnd = afterNodeModules.indexOf("/");
    if (packageNameEnd > 0) {
      const packageName = afterNodeModules.slice(0, packageNameEnd);
      // Path relative to project root: node_modules/packageName/dist/workers/worker.js
      return `./node_modules/${packageName}/dist/workers/${workerName}.js`;
    }
  }

  // Fallback: try to resolve using import.meta.resolve if available
  try {
    // Use the current file's directory as base
    const baseDir = new URL(".", currentFile);
    const workerUrl = new URL(`workers/${workerName}.js`, baseDir);
    // Return as file path (Bun accepts file:// URLs or paths)
    return workerUrl.pathname;
  } catch {
    // Final fallback: relative path from dist/
    return `./dist/workers/${workerName}.js`;
  }
};

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
}

interface JobTiming {
  kind: WorkerKind;
  assignedAtMs: number;
  activeStartAtMs: number | null;
}

interface AutoScaleMetrics {
  markdownActiveMs: number;
  hybridActiveMs: number;
  markdownUnavailableRate: number;
}

interface AutoScaleQueues {
  pendingMarkdown: number;
  pendingHybrid: number;
}

interface AutoScaleConfig {
  pool: WorkerPool;
  idleMarkdown: Set<string>;
  idleHybrid: Set<string>;
  maxTotalWorkers: number;
  getPendingCounts: () => AutoScaleQueues;
  getMetrics: () => AutoScaleMetrics;
  isDone: () => boolean;
  label: string;
}

const MIN_TOTAL_WORKERS = 2;
const MIN_WORKERS_PER_KIND = 1;
const WORKER_INACTIVITY_MS = 45_000;
const AUTOSCALE_INTERVAL_MS = 1000;
const AUTOSCALE_TARGET_DRAIN_MS = 6000;
const MAX_SPAWN_PER_TICK = 5;
const MAX_STOP_PER_TICK = 5;
const EWMA_ALPHA = 0.3;
const DEFAULT_MARKDOWN_ACTIVE_MS = 200;
const DEFAULT_HYBRID_ACTIVE_MS = 600;
const DEFAULT_MARKDOWN_UNAVAILABLE_RATE = 0.25;
const BLOOM_BITS_PER_ITEM = 10;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const updateEwma = (current: number, sample: number, alpha: number): number =>
  Number.isFinite(sample) ? alpha * sample + (1 - alpha) * current : current;

const createJobId = (): string => crypto.randomUUID();

const createWorkerOptions = (options: CliOptions): CliOptions => ({
  ...options,
  verbose: false,
  progress: false,
});

const createKnownUrlFilter = (
  capacity: number
): { filter: BloomFilter; init: BloomFilterInit } =>
  BloomFilter.create(Math.max(1, capacity), BLOOM_BITS_PER_ITEM);

const createWorkerPool = (
  options: CliOptions,
  onMessage: (state: WorkerState, message: WorkerToMainMessage) => void,
  knownUrlFilter: BloomFilterInit
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
    message.type === "renderWithPlaywright" ||
    message.type === "stop";

  const formatMainMessage = (message: MainToWorkerMessage): string => {
    switch (message.type) {
      case "assign":
        return `assign job=${message.job.jobId} url=${message.job.url} waitUntilMs=${message.job.waitUntilMs}`;
      case "init":
        return `init kind=${message.kind} inactivityMs=${message.inactivityMs}`;
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
    const workerFileName =
      kind === "markdown" ? "markdown-worker" : "hybrid-html-worker";
    const workerPath = resolveWorkerPath(workerFileName);
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

    worker.addEventListener("error", (event: ErrorEvent) => {
      let errorMessage = "Unknown error";

      if (event.error instanceof Error) {
        errorMessage = event.error.message;
      } else if (event.error) {
        errorMessage = String(event.error);
      } else if (event.message) {
        errorMessage = event.message;
      }

      const errorDetails =
        event.filename && event.lineno
          ? ` at ${event.filename}:${event.lineno}:${event.colno ?? 0}`
          : "";
      logger.error(`Worker ${state.id} failed: ${errorMessage}${errorDetails}`);
      handleStopped(state.id);
    });

    const initMessage: MainToWorkerMessage = {
      type: "init",
      workerId: id,
      kind,
      options: workerOptions,
      inactivityMs: WORKER_INACTIVITY_MS,
      knownUrlFilter,
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

  return { workers, spawnWorker, stopWorker, stopAll };
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

const startAutoScaler = (config: AutoScaleConfig): (() => void) => {
  let stopped = false;

  const getPoolCounts = (): {
    markdown: number;
    hybrid: number;
    inFlightMarkdown: number;
    inFlightHybrid: number;
  } => {
    let markdown = 0;
    let hybrid = 0;
    let inFlightMarkdown = 0;
    let inFlightHybrid = 0;
    for (const state of config.pool.workers.values()) {
      if (state.kind === "markdown") {
        markdown += 1;
        if (state.currentJobId) {
          inFlightMarkdown += 1;
        }
      } else {
        hybrid += 1;
        if (state.currentJobId) {
          inFlightHybrid += 1;
        }
      }
    }
    return { markdown, hybrid, inFlightMarkdown, inFlightHybrid };
  };

  const collectIdleIds = (idleSet: Set<string>): string[] => {
    const ids: string[] = [];
    for (const id of Array.from(idleSet)) {
      const state = config.pool.workers.get(id);
      if (!state) {
        idleSet.delete(id);
        continue;
      }
      if (!state.idle || state.stopping) {
        idleSet.delete(id);
        continue;
      }
      ids.push(id);
    }
    return ids;
  };

  const stopIdleWorker = (workerId: string, kind: WorkerKind): void => {
    if (kind === "markdown") {
      config.idleMarkdown.delete(workerId);
    } else {
      config.idleHybrid.delete(workerId);
    }
    config.pool.stopWorker(workerId);
  };

  type PoolCounts = ReturnType<typeof getPoolCounts>;
  interface AutoScaleTargets {
    desiredTotal: number;
    desiredMarkdown: number;
    desiredHybrid: number;
  }
  interface ScaleState {
    markdownCount: number;
    hybridCount: number;
    markdownDiff: number;
    hybridDiff: number;
    spawnBudget: number;
    stopBudget: number;
  }

  const computeTargets = (
    pending: AutoScaleQueues,
    counts: PoolCounts,
    metrics: AutoScaleMetrics
  ): AutoScaleTargets => {
    const pendingTotal = pending.pendingMarkdown + pending.pendingHybrid;
    const inFlightTotal = counts.inFlightMarkdown + counts.inFlightHybrid;
    const hasWork = pendingTotal + inFlightTotal > 0;
    const effectiveMarkdownRate = clamp(metrics.markdownUnavailableRate, 0, 1);
    const safeMarkdownMs = Math.max(1, metrics.markdownActiveMs);
    const safeHybridMs = Math.max(1, metrics.hybridActiveMs);
    const markdownDemand = pending.pendingMarkdown + counts.inFlightMarkdown;
    const hybridDemand =
      pending.pendingHybrid +
      counts.inFlightHybrid +
      markdownDemand * effectiveMarkdownRate;
    const markdownWorkMs = markdownDemand * safeMarkdownMs;
    const hybridWorkMs = hybridDemand * safeHybridMs;
    const totalWorkMs = markdownWorkMs + hybridWorkMs;

    const desiredTotal = hasWork
      ? clamp(
          Math.ceil(totalWorkMs / AUTOSCALE_TARGET_DRAIN_MS),
          MIN_TOTAL_WORKERS,
          config.maxTotalWorkers
        )
      : MIN_TOTAL_WORKERS;

    const desiredMarkdown =
      totalWorkMs > 0
        ? clamp(
            Math.round((desiredTotal * markdownWorkMs) / totalWorkMs),
            MIN_WORKERS_PER_KIND,
            desiredTotal - MIN_WORKERS_PER_KIND
          )
        : clamp(
            Math.round(desiredTotal / 2),
            MIN_WORKERS_PER_KIND,
            desiredTotal - MIN_WORKERS_PER_KIND
          );

    const desiredHybrid = Math.max(
      MIN_WORKERS_PER_KIND,
      desiredTotal - desiredMarkdown
    );

    return { desiredTotal, desiredMarkdown, desiredHybrid };
  };

  const createScaleState = (
    counts: PoolCounts,
    targets: AutoScaleTargets
  ): ScaleState => ({
    markdownCount: counts.markdown,
    hybridCount: counts.hybrid,
    markdownDiff: targets.desiredMarkdown - counts.markdown,
    hybridDiff: targets.desiredHybrid - counts.hybrid,
    spawnBudget: MAX_SPAWN_PER_TICK,
    stopBudget: MAX_STOP_PER_TICK,
  });

  const pickSpawnKind = (
    markdownDiff: number,
    hybridDiff: number
  ): WorkerKind | null => {
    if (markdownDiff > 0 && hybridDiff > 0) {
      return markdownDiff >= hybridDiff ? "markdown" : "hybrid";
    }
    if (markdownDiff > 0) {
      return "markdown";
    }
    if (hybridDiff > 0) {
      return "hybrid";
    }
    return null;
  };

  const shiftWorkers = (
    fromKind: WorkerKind,
    toKind: WorkerKind,
    idleIds: string[],
    requested: number,
    state: ScaleState
  ): number => {
    if (requested <= 0 || state.spawnBudget <= 0 || state.stopBudget <= 0) {
      return 0;
    }
    const allowed = Math.min(
      requested,
      idleIds.length,
      state.spawnBudget,
      state.stopBudget
    );
    let shifted = 0;
    for (let i = 0; i < allowed; i += 1) {
      const workerId = idleIds.shift();
      if (!workerId) {
        break;
      }
      stopIdleWorker(workerId, fromKind);
      config.pool.spawnWorker(toKind);
      state.spawnBudget -= 1;
      state.stopBudget -= 1;
      shifted += 1;
    }
    return shifted;
  };

  const rebalanceKinds = (
    state: ScaleState,
    idleMarkdownIds: string[],
    idleHybridIds: string[]
  ): void => {
    if (state.markdownDiff > 0 && state.hybridDiff < 0) {
      const requested = Math.min(state.markdownDiff, -state.hybridDiff);
      const shifted = shiftWorkers(
        "hybrid",
        "markdown",
        idleHybridIds,
        requested,
        state
      );
      if (shifted > 0) {
        state.markdownCount += shifted;
        state.hybridCount -= shifted;
        state.markdownDiff -= shifted;
        state.hybridDiff += shifted;
      }
      return;
    }
    if (state.markdownDiff < 0 && state.hybridDiff > 0) {
      const requested = Math.min(-state.markdownDiff, state.hybridDiff);
      const shifted = shiftWorkers(
        "markdown",
        "hybrid",
        idleMarkdownIds,
        requested,
        state
      );
      if (shifted > 0) {
        state.markdownCount -= shifted;
        state.hybridCount += shifted;
        state.markdownDiff += shifted;
        state.hybridDiff -= shifted;
      }
    }
  };

  const scaleUpWorkers = (
    state: ScaleState,
    targets: AutoScaleTargets
  ): void => {
    const totalDiff =
      targets.desiredTotal - (state.markdownCount + state.hybridCount);
    if (totalDiff <= 0 || state.spawnBudget <= 0) {
      return;
    }
    const spawnCount = Math.min(state.spawnBudget, totalDiff);
    for (let i = 0; i < spawnCount; i += 1) {
      const kind = pickSpawnKind(state.markdownDiff, state.hybridDiff);
      if (!kind) {
        break;
      }
      config.pool.spawnWorker(kind);
      state.spawnBudget -= 1;
      if (kind === "markdown") {
        state.markdownCount += 1;
        state.markdownDiff -= 1;
      } else {
        state.hybridCount += 1;
        state.hybridDiff -= 1;
      }
    }
  };

  const stopWorkersFromKind = (
    state: ScaleState,
    idleIds: string[],
    kind: WorkerKind,
    requested: number
  ): number => {
    if (requested <= 0 || state.stopBudget <= 0) {
      return 0;
    }
    const allowed = Math.min(requested, idleIds.length, state.stopBudget);
    let stopped = 0;
    for (let i = 0; i < allowed; i += 1) {
      const workerId = idleIds.shift();
      if (!workerId) {
        break;
      }
      stopIdleWorker(workerId, kind);
      state.stopBudget -= 1;
      stopped += 1;
    }
    return stopped;
  };

  const scaleDownWorkers = (
    state: ScaleState,
    idleMarkdownIds: string[],
    idleHybridIds: string[],
    targets: AutoScaleTargets
  ): void => {
    const totalDiff =
      targets.desiredTotal - (state.markdownCount + state.hybridCount);
    if (totalDiff >= 0 || state.stopBudget <= 0) {
      return;
    }
    let remainingStop = Math.min(state.stopBudget, -totalDiff);
    if (state.markdownDiff < 0 && remainingStop > 0) {
      const requested = Math.min(-state.markdownDiff, remainingStop);
      const stopped = stopWorkersFromKind(
        state,
        idleMarkdownIds,
        "markdown",
        requested
      );
      if (stopped > 0) {
        state.markdownCount -= stopped;
        state.markdownDiff += stopped;
        remainingStop -= stopped;
      }
    }
    if (state.hybridDiff < 0 && remainingStop > 0) {
      const requested = Math.min(-state.hybridDiff, remainingStop);
      const stopped = stopWorkersFromKind(
        state,
        idleHybridIds,
        "hybrid",
        requested
      );
      if (stopped > 0) {
        state.hybridCount -= stopped;
        state.hybridDiff += stopped;
      }
    }
  };

  const logAutoScale = (
    pending: AutoScaleQueues,
    counts: PoolCounts,
    metrics: AutoScaleMetrics,
    targets: AutoScaleTargets
  ): void => {
    if (!logger.verbose) {
      return;
    }
    logger.debug(
      `${config.label} autoscale pending=md${pending.pendingMarkdown}/hy${pending.pendingHybrid} inFlight=md${counts.inFlightMarkdown}/hy${counts.inFlightHybrid} activeMs=md${Math.round(
        metrics.markdownActiveMs
      )}/hy${Math.round(
        metrics.hybridActiveMs
      )} unavailableRate=${metrics.markdownUnavailableRate.toFixed(
        2
      )} target=${targets.desiredTotal} (md ${targets.desiredMarkdown}, hy ${targets.desiredHybrid}) current=${counts.markdown + counts.hybrid} (md ${counts.markdown}, hy ${counts.hybrid})`
    );
  };

  const tick = (): void => {
    if (stopped || config.isDone()) {
      return;
    }

    const counts = getPoolCounts();
    const pending = config.getPendingCounts();
    const metrics = config.getMetrics();
    const targets = computeTargets(pending, counts, metrics);
    const idleMarkdownIds = collectIdleIds(config.idleMarkdown);
    const idleHybridIds = collectIdleIds(config.idleHybrid);

    const state = createScaleState(counts, targets);
    rebalanceKinds(state, idleMarkdownIds, idleHybridIds);
    scaleUpWorkers(state, targets);
    scaleDownWorkers(state, idleMarkdownIds, idleHybridIds, targets);
    logAutoScale(pending, counts, metrics, targets);
  };

  tick();
  const interval = setInterval(tick, AUTOSCALE_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
};

export async function runScrapeWithWorkers(
  urls: string[],
  options: CliOptions
): Promise<void> {
  const totalUrls = urls.length;
  const { filter: knownUrlFilter, init: knownUrlFilterInit } =
    createKnownUrlFilter(totalUrls);
  const maxTotalWorkers = Math.max(options.concurrency, MIN_TOTAL_WORKERS);
  const markdownQueue: QueueItem[] = [];
  const hybridQueue: QueueItem[] = [];
  const jobMap = new Map<string, QueueItem>();
  const jobTimings = new Map<string, JobTiming>();
  let markdownActiveMs = DEFAULT_MARKDOWN_ACTIVE_MS;
  let hybridActiveMs = DEFAULT_HYBRID_ACTIVE_MS;
  let markdownUnavailableRate = DEFAULT_MARKDOWN_UNAVAILABLE_RATE;
  const knownUrls = new Set<string>();
  const idleMarkdown = new Set<string>();
  const idleHybrid = new Set<string>();
  const nextAllowedByOrigin = new Map<string, number>();
  const delayMs = Math.max(options.delayMs, 0);
  let inFlightCount = 0;
  let processedCount = 0;
  let doneResolve: (() => void) | null = null;
  let isDone = false;
  let stopAutoScaler: (() => void) | null = null;

  for (const url of urls) {
    const normalized = normalizeForQueue(new URL(url));
    knownUrls.add(normalized);
    knownUrlFilter.add(normalized);
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

  const recordAssignment = (state: WorkerState, jobId: string): void => {
    jobTimings.set(jobId, {
      kind: state.kind,
      assignedAtMs: Date.now(),
      activeStartAtMs: null,
    });
  };

  const markActiveStart = (jobId: string): void => {
    const timing = jobTimings.get(jobId);
    if (!timing || timing.activeStartAtMs !== null) {
      return;
    }
    timing.activeStartAtMs = Date.now();
  };

  const recordTerminal = (
    jobId: string,
    outcome: "completed" | "failed" | "markdownUnavailable"
  ): void => {
    const timing = jobTimings.get(jobId);
    if (timing?.activeStartAtMs) {
      const durationMs = Date.now() - timing.activeStartAtMs;
      if (durationMs > 0) {
        if (timing.kind === "markdown") {
          markdownActiveMs = updateEwma(
            markdownActiveMs,
            durationMs,
            EWMA_ALPHA
          );
        } else {
          hybridActiveMs = updateEwma(hybridActiveMs, durationMs, EWMA_ALPHA);
        }
      }
    }
    if (timing?.kind === "markdown") {
      const sample = outcome === "markdownUnavailable" ? 1 : 0;
      markdownUnavailableRate = updateEwma(
        markdownUnavailableRate,
        sample,
        EWMA_ALPHA
      );
    }
    jobTimings.delete(jobId);
  };

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
    recordAssignment(state, next.jobId);
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
      markActiveStart(message.jobId);
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
    recordTerminal(message.jobId, "completed");
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
    recordTerminal(message.jobId, "failed");
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
    recordTerminal(message.jobId, "markdownUnavailable");
    const job = jobMap.get(message.jobId);
    if (job) {
      hybridQueue.push(job);
      dispatchIdle();
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

  pool = createWorkerPool(options, handleScrapeMessage, knownUrlFilterInit);

  for (let i = 0; i < MIN_WORKERS_PER_KIND; i += 1) {
    pool.spawnWorker("markdown");
  }
  for (let i = 0; i < MIN_WORKERS_PER_KIND; i += 1) {
    pool.spawnWorker("hybrid");
  }

  stopAutoScaler = startAutoScaler({
    pool,
    idleMarkdown,
    idleHybrid,
    maxTotalWorkers,
    getPendingCounts: () => ({
      pendingMarkdown: markdownQueue.length,
      pendingHybrid: hybridQueue.length,
    }),
    getMetrics: () => ({
      markdownActiveMs,
      hybridActiveMs,
      markdownUnavailableRate,
    }),
    isDone: () => isDone,
    label: "scrape",
  });

  await new Promise<void>((resolve) => {
    doneResolve = resolve;
    checkDone();
  });

  if (stopAutoScaler) {
    stopAutoScaler();
  }

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

  const { filter: knownUrlFilter, init: knownUrlFilterInit } =
    createKnownUrlFilter(options.maxPages);
  const maxTotalWorkers = Math.max(options.concurrency, MIN_TOTAL_WORKERS);
  const markdownQueue: QueueItem[] = [];
  const hybridQueue: QueueItem[] = [];
  const jobMap = new Map<string, QueueItem>();
  const jobTimings = new Map<string, JobTiming>();
  let markdownActiveMs = DEFAULT_MARKDOWN_ACTIVE_MS;
  let hybridActiveMs = DEFAULT_HYBRID_ACTIVE_MS;
  let markdownUnavailableRate = DEFAULT_MARKDOWN_UNAVAILABLE_RATE;
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
  let stopAutoScaler: (() => void) | null = null;

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
  knownUrlFilter.add(initialNormalized);
  jobMap.set(initialJobId, initialItem);
  markdownQueue.push(initialItem);

  const getPendingCount = (): number =>
    markdownQueue.length + hybridQueue.length;
  const getDynamicTotal = (): number =>
    savedCount + inFlightCount + getPendingCount();

  logger.startProgress(getDynamicTotal());

  let pool: WorkerPool;

  const recordAssignment = (state: WorkerState, jobId: string): void => {
    jobTimings.set(jobId, {
      kind: state.kind,
      assignedAtMs: Date.now(),
      activeStartAtMs: null,
    });
  };

  const markActiveStart = (jobId: string): void => {
    const timing = jobTimings.get(jobId);
    if (!timing || timing.activeStartAtMs !== null) {
      return;
    }
    timing.activeStartAtMs = Date.now();
  };

  const recordTerminal = (
    jobId: string,
    outcome: "completed" | "failed" | "markdownUnavailable"
  ): void => {
    const timing = jobTimings.get(jobId);
    if (timing?.activeStartAtMs) {
      const durationMs = Date.now() - timing.activeStartAtMs;
      if (durationMs > 0) {
        if (timing.kind === "markdown") {
          markdownActiveMs = updateEwma(
            markdownActiveMs,
            durationMs,
            EWMA_ALPHA
          );
        } else {
          hybridActiveMs = updateEwma(hybridActiveMs, durationMs, EWMA_ALPHA);
        }
      }
    }
    if (timing?.kind === "markdown") {
      const sample = outcome === "markdownUnavailable" ? 1 : 0;
      markdownUnavailableRate = updateEwma(
        markdownUnavailableRate,
        sample,
        EWMA_ALPHA
      );
    }
    jobTimings.delete(jobId);
  };

  const markIdle = (state: WorkerState): void => {
    state.idle = true;
    if (state.kind === "markdown") {
      idleMarkdown.add(state.id);
    } else {
      idleHybrid.add(state.id);
    }
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
      knownUrlFilter.add(normalized);
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
        logger.debug(`Blocked by robots.txt: ${next.url}`);
        jobMap.delete(next.jobId);
        logger.setProgressTotal(getDynamicTotal());
        maybeFinish();
        continue;
      }
      idleMarkdown.delete(state.id);
      state.idle = false;
      state.currentJobId = next.jobId;
      recordAssignment(state, next.jobId);
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
    recordAssignment(state, next.jobId);
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
      markActiveStart(message.jobId);
      logger.updateProgress(savedCount, message.url, getDynamicTotal());
    }
  };

  const handleCompleted = (
    state: WorkerState,
    message: Extract<WorkerToMainMessage, { type: "completed" }>
  ): void => {
    inFlightCount -= 1;
    state.currentJobId = null;
    recordTerminal(message.jobId, "completed");
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
    recordTerminal(message.jobId, "failed");
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
    recordTerminal(message.jobId, "markdownUnavailable");
    const job = jobMap.get(message.jobId);
    if (job) {
      hybridQueue.push(job);
      dispatchIdle();
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

  pool = createWorkerPool(options, handleCrawlMessage, knownUrlFilterInit);

  for (let i = 0; i < MIN_WORKERS_PER_KIND; i += 1) {
    pool.spawnWorker("markdown");
  }
  for (let i = 0; i < MIN_WORKERS_PER_KIND; i += 1) {
    pool.spawnWorker("hybrid");
  }

  stopAutoScaler = startAutoScaler({
    pool,
    idleMarkdown,
    idleHybrid,
    maxTotalWorkers,
    getPendingCounts: () => ({
      pendingMarkdown: markdownQueue.length,
      pendingHybrid: hybridQueue.length,
    }),
    getMetrics: () => ({
      markdownActiveMs,
      hybridActiveMs,
      markdownUnavailableRate,
    }),
    isDone: () => isDone,
    label: "crawl",
  });

  await new Promise<void>((resolve) => {
    doneResolve = resolve;
    maybeFinish();
  });

  if (stopAutoScaler) {
    stopAutoScaler();
  }

  await pool.stopAll();

  logger.endProgress();

  const skipped = visited.size - savedCount;
  if (skipped > 0) {
    logger.info(`Skipped ${skipped} duplicate/visited URL(s)`);
  }

  logger.printFailureSummary(failures);
}
