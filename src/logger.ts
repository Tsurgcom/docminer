/**
 * Centralized logging module with progress bar support using Bun APIs.
 *
 * Features:
 * - Consistent colored output for different log levels
 * - Progress bar with current task status
 * - Verbose mode for detailed debugging
 * - Non-blocking terminal updates
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",

  // Foreground colors
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Cursor control
  clearLine: "\x1b[2K",
  cursorUp: "\x1b[1A",
  cursorToStart: "\x1b[0G",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
} as const;

export type LogLevel = "debug" | "info" | "success" | "warn" | "error";

interface LoggerConfig {
  verbose: boolean;
}

interface ProgressState {
  current: number;
  total: number;
  currentUrl: string;
  failures: number;
  startTime: number;
  isActive: boolean;
}

const PROGRESS_BAR_WIDTH = 30;
const MIN_TERMINAL_WIDTH = 80;

const levelStyles: Record<LogLevel, { color: string; prefix: string }> = {
  debug: { color: ANSI.gray, prefix: "DEBUG" },
  info: { color: ANSI.blue, prefix: "INFO" },
  success: { color: ANSI.green, prefix: "OK" },
  warn: { color: ANSI.yellow, prefix: "WARN" },
  error: { color: ANSI.red, prefix: "ERROR" },
};

class Logger {
  private config: LoggerConfig = { verbose: false };
  private progress: ProgressState | null = null;
  private lastProgressLine = "";
  private readonly isTerminal = process.stdout.isTTY ?? false;
  private signalHandlerRegistered = false;

  constructor() {
    this.registerSignalHandler();
  }

  /**
   * Register SIGINT handler to restore cursor on Ctrl+C.
   */
  private registerSignalHandler(): void {
    if (this.signalHandlerRegistered) {
      return;
    }

    const cleanup = (): void => {
      this.clearProgressLine();
      if (this.isTerminal) {
        process.stdout.write(ANSI.showCursor);
      }
    };

    process.on("SIGINT", () => {
      cleanup();
      process.exit(130); // Standard exit code for SIGINT
    });

    process.on("SIGTERM", () => {
      cleanup();
      process.exit(143); // Standard exit code for SIGTERM
    });

    // Also handle uncaught exceptions to restore cursor
    process.on("exit", () => {
      if (this.isTerminal && this.progress?.isActive) {
        process.stdout.write(ANSI.showCursor);
      }
    });

    this.signalHandlerRegistered = true;
  }

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  get verbose(): boolean {
    return this.config.verbose;
  }

  private formatMessage(level: LogLevel, message: string): string {
    const style = levelStyles[level];
    const timestamp = this.config.verbose
      ? `${ANSI.dim}[${this.getTimestamp()}]${ANSI.reset} `
      : "";
    return `${timestamp}${style.color}${ANSI.bold}[${style.prefix}]${ANSI.reset} ${message}`;
  }

  private getTimestamp(): string {
    const now = new Date();
    return now.toISOString().slice(11, 23);
  }

  private getTerminalWidth(): number {
    return process.stdout.columns ?? MIN_TERMINAL_WIDTH;
  }

  private clearProgressLine(): void {
    if (this.isTerminal && this.lastProgressLine) {
      process.stdout.write(`${ANSI.cursorToStart}${ANSI.clearLine}`);
      this.lastProgressLine = "";
    }
  }

  private writeLog(level: LogLevel, message: string): void {
    this.clearProgressLine();
    const formatted = this.formatMessage(level, message);

    if (level === "error") {
      console.error(formatted);
    } else if (level === "warn") {
      console.warn(formatted);
    } else {
      console.info(formatted);
    }

    this.renderProgress();
  }

  debug(message: string): void {
    if (this.config.verbose) {
      this.writeLog("debug", message);
    }
  }

  info(message: string): void {
    this.writeLog("info", message);
  }

  success(message: string): void {
    this.writeLog("success", message);
  }

  warn(message: string): void {
    this.writeLog("warn", message);
  }

  error(message: string): void {
    this.writeLog("error", message);
  }

  /**
   * Start tracking progress for a batch operation.
   */
  startProgress(total: number): void {
    this.progress = {
      current: 0,
      total,
      currentUrl: "",
      failures: 0,
      startTime: Date.now(),
      isActive: true,
    };

    if (this.isTerminal) {
      process.stdout.write(ANSI.hideCursor);
    }

    this.renderProgress();
  }

  /**
   * Update progress with the current item being processed.
   */
  updateProgress(current: number, url: string, total?: number): void {
    if (!this.progress) {
      return;
    }

    this.progress.current = current;
    this.progress.currentUrl = url;
    if (total !== undefined) {
      this.progress.total = total;
    }
    this.renderProgress();
  }

  /**
   * Update the total count for the progress bar (for dynamic totals).
   */
  setProgressTotal(total: number): void {
    if (!this.progress) {
      return;
    }

    this.progress.total = total;
    this.renderProgress();
  }

  /**
   * Increment the current progress count.
   */
  incrementProgress(url?: string): void {
    if (!this.progress) {
      return;
    }

    this.progress.current += 1;
    if (url) {
      this.progress.currentUrl = url;
    }
    this.renderProgress();
  }

  /**
   * Record a failure in the progress tracking.
   */
  recordFailure(): void {
    if (!this.progress) {
      return;
    }

    this.progress.failures += 1;
    this.renderProgress();
  }

  /**
   * Complete and remove the progress bar.
   */
  endProgress(): void {
    this.clearProgressLine();

    if (this.isTerminal) {
      process.stdout.write(ANSI.showCursor);
    }

    if (this.progress) {
      const elapsed = this.formatDuration(Date.now() - this.progress.startTime);
      const { current, failures } = this.progress;

      const successCount = current - failures;
      const summary =
        failures > 0
          ? `${ANSI.green}${successCount} saved${ANSI.reset}, ${ANSI.red}${failures} failed${ANSI.reset}`
          : `${ANSI.green}${successCount} saved${ANSI.reset}`;

      this.progress = null;
      console.info(
        `${ANSI.cyan}${ANSI.bold}[DONE]${ANSI.reset} Completed in ${ANSI.bold}${elapsed}${ANSI.reset} (${summary})`
      );
    }

    this.progress = null;
  }

  private renderProgress(): void {
    if (!(this.progress?.isActive && this.isTerminal)) {
      return;
    }

    const { current, total, currentUrl, failures } = this.progress;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    const filled = Math.round((current / total) * PROGRESS_BAR_WIDTH);
    const empty = PROGRESS_BAR_WIDTH - filled;

    const bar = `${ANSI.green}${"█".repeat(filled)}${ANSI.gray}${"░".repeat(empty)}${ANSI.reset}`;
    const stats = `${current}/${total}`;
    const failureText =
      failures > 0 ? ` ${ANSI.red}(${failures} failed)${ANSI.reset}` : "";

    const elapsed = this.formatDuration(Date.now() - this.progress.startTime);
    const eta = this.calculateEta();

    // Truncate URL to fit terminal
    const termWidth = this.getTerminalWidth();
    const fixedPartLength = 60; // Approximate length of fixed parts
    const maxUrlLength = Math.max(20, termWidth - fixedPartLength);
    const displayUrl = this.truncateUrl(currentUrl, maxUrlLength);

    const progressLine = `${ANSI.cursorToStart}${ANSI.clearLine}${bar} ${ANSI.bold}${percent}%${ANSI.reset} ${ANSI.dim}(${stats})${ANSI.reset}${failureText} ${ANSI.dim}${elapsed}${eta ? ` ETA: ${eta}` : ""}${ANSI.reset} ${ANSI.cyan}${displayUrl}${ANSI.reset}`;

    this.lastProgressLine = progressLine;
    process.stdout.write(progressLine);
  }

  private truncateUrl(url: string, maxLength: number): string {
    if (!url || url.length <= maxLength) {
      return url;
    }

    try {
      const parsed = new URL(url);
      const path = parsed.pathname + parsed.search;

      if (path.length > maxLength - 3) {
        return `...${path.slice(-(maxLength - 3))}`;
      }

      return `${`${parsed.hostname}${path}`.slice(0, maxLength - 3)}...`;
    } catch {
      return `${url.slice(0, maxLength - 3)}...`;
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }

    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  private calculateEta(): string {
    if (!this.progress || this.progress.current === 0) {
      return "";
    }

    const { current, total, startTime } = this.progress;
    const elapsed = Date.now() - startTime;
    const remaining = total - current;

    if (remaining <= 0) {
      return "";
    }

    const msPerItem = elapsed / current;
    const etaMs = msPerItem * remaining;

    return this.formatDuration(etaMs);
  }

  /**
   * Log a fetch attempt (verbose only).
   */
  logFetch(url: string, attempt: number, maxAttempts: number): void {
    this.debug(`Fetching (${attempt}/${maxAttempts}): ${url}`);
  }

  /**
   * Log a fetch failure (verbose only).
   */
  logFetchError(url: string, attempt: number, error: unknown): void {
    this.debug(`Fetch attempt ${attempt} failed for ${url}: ${String(error)}`);
  }

  /**
   * Log a successful page save.
   */
  logPageSaved(url: string, depth?: number): void {
    const depthInfo =
      depth !== undefined ? ` ${ANSI.dim}(depth ${depth})${ANSI.reset}` : "";
    this.success(`Saved ${ANSI.cyan}${url}${ANSI.reset}${depthInfo}`);
  }

  /**
   * Log a blocked URL.
   */
  logBlocked(url: string, reason: string): void {
    this.info(
      `${ANSI.yellow}Blocked${ANSI.reset} ${url} ${ANSI.dim}(${reason})${ANSI.reset}`
    );
  }

  /**
   * Log a skipped operation.
   */
  logSkipped(message: string): void {
    this.debug(`Skipped: ${message}`);
  }

  /**
   * Log a fallback operation (verbose only).
   */
  logFallback(message: string): void {
    this.debug(`Fallback: ${message}`);
  }

  /**
   * Print a summary of failures.
   */
  printFailureSummary(failures: string[]): void {
    if (failures.length === 0) {
      return;
    }

    console.warn(
      `\n${ANSI.yellow}${ANSI.bold}Failures (${failures.length}):${ANSI.reset}`
    );
    for (const failure of failures) {
      console.warn(`  ${ANSI.dim}•${ANSI.reset} ${failure}`);
    }
  }

  /**
   * Print crawl configuration (verbose only).
   */
  logCrawlStart(startUrl: string, config: Record<string, unknown>): void {
    if (!this.config.verbose) {
      return;
    }

    console.info(`\n${ANSI.cyan}${ANSI.bold}Crawl Configuration:${ANSI.reset}`);
    console.info(`  ${ANSI.dim}Start URL:${ANSI.reset} ${startUrl}`);
    for (const [key, value] of Object.entries(config)) {
      console.info(`  ${ANSI.dim}${key}:${ANSI.reset} ${value}`);
    }
    console.info("");
  }
}

// Export a singleton instance
export const logger = new Logger();
