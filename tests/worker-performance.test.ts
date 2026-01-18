import { describe, expect, test } from "bun:test";
import { BloomFilter } from "../src/bloom";
import { DEFAULT_OPTIONS } from "../src/constants";
import type {
  JobPayload,
  MainToWorkerMessage,
  WorkerToMainMessage,
} from "../src/workers/protocol";

interface WorkerBenchmarkResult {
  workerType: "markdown" | "hybrid";
  url: string;
  durationMs: number;
  success: boolean;
  outcome: "completed" | "failed" | "markdownUnavailable" | "timeout";
  error?: string;
  linksDiscovered?: number;
}

interface WorkerBenchmarkStats {
  workerType: "markdown" | "hybrid";
  totalTests: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  markdownUnavailableCount: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  totalLinksDiscovered: number;
}

const TEST_TIMEOUT_MS = 30_000;

/**
 * Create a simple bloom filter for worker initialization
 */
const createTestBloomFilter = () => {
  const { init } = BloomFilter.create(100, 10);
  return init;
};

/**
 * Run a single worker job and measure its performance
 */

// biome-ignore lint/suspicious/useAwait: <test>
const benchmarkWorker = async (
  workerType: "markdown" | "hybrid",
  url: string,
  timeoutMs = TEST_TIMEOUT_MS
): Promise<WorkerBenchmarkResult> => {
  const workerPath =
    workerType === "markdown"
      ? "./src/workers/markdown-worker.ts"
      : "./src/workers/hybrid-html-worker.ts";

  const worker =
    workerType === "markdown"
      ? new Worker(workerPath, { smol: true })
      : new Worker(workerPath);

  const workerId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const knownUrlFilter = createTestBloomFilter();

  return new Promise((resolve) => {
    let startTime = 0;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      worker.terminate();
      resolve({
        workerType,
        url,
        durationMs: timeoutMs,
        success: false,
        outcome: "timeout",
        error: "Worker timed out",
      });
    }, timeoutMs);

    worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as WorkerToMainMessage;

      if (message.type === "ready") {
        // Worker is ready, assign the job
        const job: JobPayload = {
          jobId,
          url,
          depth: 0,
          canGoDeeper: false,
          waitUntilMs: Date.now(),
        };

        const assignMessage: MainToWorkerMessage = {
          type: "assign",
          job,
        };

        startTime = Date.now();
        worker.postMessage(assignMessage);
      } else if (message.type === "completed") {
        if (!timedOut) {
          clearTimeout(timeout);
          const durationMs = Date.now() - startTime;
          worker.terminate();
          resolve({
            workerType,
            url,
            durationMs,
            success: true,
            outcome: "completed",
            linksDiscovered: message.discoveredLinks.length,
          });
        }
      } else if (message.type === "failed") {
        if (!timedOut) {
          clearTimeout(timeout);
          const durationMs = Date.now() - startTime;
          worker.terminate();
          resolve({
            workerType,
            url,
            durationMs,
            success: false,
            outcome: "failed",
            error: message.error,
          });
        }
      } else if (message.type === "markdownUnavailable" && !timedOut) {
        clearTimeout(timeout);
        const durationMs = Date.now() - startTime;
        worker.terminate();
        resolve({
          workerType,
          url,
          durationMs,
          success: false,
          outcome: "markdownUnavailable",
        });
      }
    });

    worker.addEventListener("error", (event) => {
      if (!timedOut) {
        clearTimeout(timeout);
        worker.terminate();
        resolve({
          workerType,
          url,
          durationMs: Date.now() - startTime,
          success: false,
          outcome: "failed",
          error: String(event),
        });
      }
    });

    // Initialize the worker
    const initMessage: MainToWorkerMessage = {
      type: "init",
      workerId,
      kind: workerType,
      options: {
        ...DEFAULT_OPTIONS,
        verbose: false,
        progress: false,
      },
      inactivityMs: TEST_TIMEOUT_MS,
      knownUrlFilter,
    };

    worker.postMessage(initMessage);
  });
};

/**
 * Calculate statistics from benchmark results
 */
const calculateStats = (
  results: WorkerBenchmarkResult[]
): WorkerBenchmarkStats => {
  const workerType = results[0]?.workerType ?? "markdown";
  const durations = results.map((r) => r.durationMs);
  const successResults = results.filter((r) => r.success);

  return {
    workerType,
    totalTests: results.length,
    successCount: results.filter((r) => r.outcome === "completed").length,
    failureCount: results.filter((r) => r.outcome === "failed").length,
    timeoutCount: results.filter((r) => r.outcome === "timeout").length,
    markdownUnavailableCount: results.filter(
      (r) => r.outcome === "markdownUnavailable"
    ).length,
    avgDurationMs:
      durations.reduce((a, b) => a + b, 0) / Math.max(durations.length, 1),
    minDurationMs: Math.min(...durations),
    maxDurationMs: Math.max(...durations),
    totalLinksDiscovered: successResults.reduce(
      (sum, r) => sum + (r.linksDiscovered ?? 0),
      0
    ),
  };
};

/**
 * Format stats for display
 */
const formatStats = (stats: WorkerBenchmarkStats): string => {
  return `
${stats.workerType.toUpperCase()} Worker Statistics:
  Total Tests: ${stats.totalTests}
  Successful: ${stats.successCount}
  Failed: ${stats.failureCount}
  Markdown Unavailable: ${stats.markdownUnavailableCount}
  Timeouts: ${stats.timeoutCount}
  Avg Duration: ${stats.avgDurationMs.toFixed(2)}ms
  Min Duration: ${stats.minDurationMs.toFixed(2)}ms
  Max Duration: ${stats.maxDurationMs.toFixed(2)}ms
  Total Links Discovered: ${stats.totalLinksDiscovered}
`.trim();
};

/**
 * Compare two worker types
 */
const compareWorkers = (
  markdownStats: WorkerBenchmarkStats,
  hybridStats: WorkerBenchmarkStats
): string => {
  const speedupFactor = (
    hybridStats.avgDurationMs / markdownStats.avgDurationMs
  ).toFixed(2);
  const faster =
    markdownStats.avgDurationMs < hybridStats.avgDurationMs
      ? "markdown"
      : "hybrid";

  return `
Performance Comparison:
  Markdown Avg: ${markdownStats.avgDurationMs.toFixed(2)}ms
  Hybrid Avg: ${hybridStats.avgDurationMs.toFixed(2)}ms
  Speedup Factor: ${speedupFactor}x
  Winner: ${faster} is ${Math.abs(Number.parseFloat(speedupFactor) - 1).toFixed(2)}x faster
`.trim();
};

describe("worker performance benchmarks", () => {
  // Test URLs - using real documentation sites
  const testUrls = [
    "https://bun.sh/docs",
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
    "https://react.dev/learn",
  ];

  test(
    "benchmark markdown worker performance",
    async () => {
      console.log("\n🚀 Benchmarking MARKDOWN workers...\n");

      const results: WorkerBenchmarkResult[] = [];

      for (const url of testUrls) {
        console.log(`Testing markdown worker on ${url}...`);
        const result = await benchmarkWorker("markdown", url);
        results.push(result);
        console.log(
          `  ✓ ${result.outcome} in ${result.durationMs.toFixed(2)}ms`
        );
      }

      const stats = calculateStats(results);
      console.log(`\n${formatStats(stats)}\n`);

      expect(results.length).toBe(testUrls.length);
      expect(stats.totalTests).toBe(testUrls.length);
    },
    { timeout: TEST_TIMEOUT_MS * testUrls.length + 5000 }
  );

  test(
    "benchmark hybrid worker performance",
    async () => {
      console.log("\n🚀 Benchmarking HYBRID workers...\n");

      const results: WorkerBenchmarkResult[] = [];

      for (const url of testUrls) {
        console.log(`Testing hybrid worker on ${url}...`);
        const result = await benchmarkWorker("hybrid", url);
        results.push(result);
        console.log(
          `  ✓ ${result.outcome} in ${result.durationMs.toFixed(2)}ms`
        );
      }

      const stats = calculateStats(results);
      console.log(`\n${formatStats(stats)}\n`);

      expect(results.length).toBe(testUrls.length);
      expect(stats.totalTests).toBe(testUrls.length);
    },
    { timeout: TEST_TIMEOUT_MS * testUrls.length + 5000 }
  );

  test(
    "compare markdown vs hybrid worker performance",
    async () => {
      console.log("\n⚡ Running head-to-head comparison...\n");

      const markdownResults: WorkerBenchmarkResult[] = [];
      const hybridResults: WorkerBenchmarkResult[] = [];

      for (const url of testUrls) {
        console.log(`\nTesting ${url}:`);

        console.log("  Testing markdown worker...");
        const markdownResult = await benchmarkWorker("markdown", url);
        markdownResults.push(markdownResult);
        console.log(
          `    ${markdownResult.outcome} in ${markdownResult.durationMs.toFixed(2)}ms`
        );

        console.log("  Testing hybrid worker...");
        const hybridResult = await benchmarkWorker("hybrid", url);
        hybridResults.push(hybridResult);
        console.log(
          `    ${hybridResult.outcome} in ${hybridResult.durationMs.toFixed(2)}ms`
        );

        const faster =
          markdownResult.durationMs < hybridResult.durationMs
            ? "markdown"
            : "hybrid";
        const speedup = Math.abs(
          markdownResult.durationMs / hybridResult.durationMs
        );
        console.log(`  → ${faster} was ${speedup.toFixed(2)}x faster`);
      }

      const markdownStats = calculateStats(markdownResults);
      const hybridStats = calculateStats(hybridResults);

      console.log(`\n${formatStats(markdownStats)}`);
      console.log(`\n${formatStats(hybridStats)}`);
      console.log(`\n${compareWorkers(markdownStats, hybridStats)}\n`);

      expect(markdownResults.length).toBe(testUrls.length);
      expect(hybridResults.length).toBe(testUrls.length);
    },
    { timeout: TEST_TIMEOUT_MS * testUrls.length * 2 + 5000 }
  );

  test("single url benchmark with detailed timing", async () => {
    const url = "https://bun.sh/docs";
    console.log(`\n📊 Detailed benchmark for ${url}\n`);

    const markdownResult = await benchmarkWorker("markdown", url);
    console.log("Markdown worker:");
    console.log(`  Duration: ${markdownResult.durationMs.toFixed(2)}ms`);
    console.log(`  Outcome: ${markdownResult.outcome}`);
    console.log(`  Links: ${markdownResult.linksDiscovered ?? 0}`);

    const hybridResult = await benchmarkWorker("hybrid", url);
    console.log("\nHybrid worker:");
    console.log(`  Duration: ${hybridResult.durationMs.toFixed(2)}ms`);
    console.log(`  Outcome: ${hybridResult.outcome}`);
    console.log(`  Links: ${hybridResult.linksDiscovered ?? 0}`);

    const speedup =
      markdownResult.durationMs / Math.max(hybridResult.durationMs, 1);
    const faster =
      markdownResult.durationMs < hybridResult.durationMs
        ? "Markdown"
        : "Hybrid";

    console.log(`\n${faster} was ${Math.abs(speedup).toFixed(2)}x faster\n`);

    expect(markdownResult.durationMs).toBeGreaterThan(0);
    expect(hybridResult.durationMs).toBeGreaterThan(0);
  });
});
