/**
 * Centralized logging module with progress bar support using Node.js APIs.
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
  showProgress: boolean;
}

interface ProgressState {
  current: number;
  total: number;
  currentUrl: string;
  failures: number;
  startTime: number;
  isActive: boolean;
  workerInfo: string;
}

// Minimum widths for different display modes
const MIN_TERMINAL_WIDTH = 80; // Default terminal width fallback
const MIN_WIDTH_FULL = 60; // Full two-line display
const MIN_WIDTH_COMPACT = 40; // Compact single-line display
const MIN_WIDTH_MINIMAL = 20; // Minimal bar only

// ANSI escape sequence pattern for stripping colors
// biome-ignore lint/suspicious/noControlCharactersInRegex: Required for ANSI stripping
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const levelStyles: Record<LogLevel, { color: string; prefix: string }> = {
  debug: { color: ANSI.gray, prefix: "DEBUG" },
  info: { color: ANSI.blue, prefix: "INFO" },
  success: { color: ANSI.green, prefix: "OK" },
  warn: { color: ANSI.yellow, prefix: "WARN" },
  error: { color: ANSI.red, prefix: "ERROR" },
};

class Logger {
  private config: LoggerConfig = { verbose: false, showProgress: true };
  private progress: ProgressState | null = null;
  private progressLineCount = 0; // Number of lines used by progress display
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
      this.clearProgressLines();
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

  private clearProgressLines(): void {
    if (!this.isTerminal || this.progressLineCount === 0) {
      return;
    }

    // Clear all progress lines from bottom to top
    for (let i = 0; i < this.progressLineCount; i++) {
      process.stdout.write(`${ANSI.cursorToStart}${ANSI.clearLine}`);
      if (i < this.progressLineCount - 1) {
        process.stdout.write(ANSI.cursorUp);
      }
    }
    this.progressLineCount = 0;
  }

  private writeLog(level: LogLevel, message: string): void {
    this.clearProgressLines();
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
      workerInfo: "",
    };

    if (this.isTerminal && this.config.showProgress) {
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

  setWorkerCounts(total: number, markdown: number, hybrid: number): void {
    if (!this.progress) {
      return;
    }
    this.progress.workerInfo =
      total > 0
        ? `${ANSI.dim}Workers:${ANSI.reset} ${total} (md ${markdown}, hybrid ${hybrid})`
        : "";
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
    this.clearProgressLines();

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
    if (
      !(this.progress?.isActive && this.isTerminal && this.config.showProgress)
    ) {
      return;
    }

    // Clear previous progress lines first
    this.clearProgressLines();

    const termWidth = this.getTerminalWidth();
    const { current, total, currentUrl, failures, workerInfo } = this.progress;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    const elapsed = this.formatDuration(Date.now() - this.progress.startTime);
    const eta = this.calculateEta();
    const showWorkers = Boolean(workerInfo);

    // Different display modes based on terminal width
    if (termWidth >= MIN_WIDTH_FULL) {
      this.renderFullProgress(
        termWidth,
        current,
        total,
        percent,
        failures,
        elapsed,
        eta,
        currentUrl,
        workerInfo
      );
    } else if (termWidth >= MIN_WIDTH_COMPACT) {
      this.renderCompactProgress(
        termWidth,
        current,
        total,
        percent,
        elapsed,
        showWorkers ? workerInfo : ""
      );
    } else if (termWidth >= MIN_WIDTH_MINIMAL) {
      this.renderMinimalProgress(
        termWidth,
        percent,
        showWorkers ? workerInfo : ""
      );
    }
    // Skip rendering entirely if terminal is too narrow (< MIN_WIDTH_MINIMAL)
  }

  /**
   * Full two-line progress display for wide terminals.
   * Line 1: Stats, elapsed, ETA, failures, URL
   * Line 2: Full-width progress bar with percentage
   */
  private renderFullProgress(
    termWidth: number,
    current: number,
    total: number,
    percent: number,
    failures: number,
    elapsed: string,
    eta: string,
    currentUrl: string,
    workerInfo: string
  ): void {
    // Build info line components
    const stats = `${current}/${total}`;
    const failureText =
      failures > 0 ? ` ${ANSI.red}✗${failures}${ANSI.reset}` : "";
    const etaText = eta ? ` ${ANSI.dim}ETA: ${eta}${ANSI.reset}` : "";
    const timeInfo = `${ANSI.dim}${elapsed}${ANSI.reset}${etaText}`;

    // Calculate space for URL (info line)
    const infoPrefix = `${stats}${failureText} ${elapsed}${eta ? ` ETA: ${eta}` : ""} `;
    const infoPrefixLen = this.stripAnsi(infoPrefix).length;
    const maxUrlLen = Math.max(10, termWidth - infoPrefixLen - 1);
    const displayUrl = this.truncateUrl(currentUrl, maxUrlLen);

    // Info line
    const infoLine = `${ANSI.dim}(${stats})${ANSI.reset}${failureText} ${timeInfo} ${ANSI.cyan}${displayUrl}${ANSI.reset}`;

    // Progress bar line - stretches to fill terminal width
    // Format: [████████████████░░░░░░░░░░░░░░] 100%
    const percentText = `${percent}%`;
    const percentWidth = percentText.length;
    const bracketSpace = 2; // [ and ]
    const spaceBetween = 1; // space between bar and percent
    const barWidth = Math.max(
      10,
      termWidth - percentWidth - bracketSpace - spaceBetween
    );

    const filledWidth = Math.round((percent / 100) * barWidth);
    const emptyWidth = barWidth - filledWidth;

    const barLine = `${ANSI.dim}[${ANSI.reset}${ANSI.green}${"█".repeat(filledWidth)}${ANSI.gray}${"░".repeat(emptyWidth)}${ANSI.reset}${ANSI.dim}]${ANSI.reset} ${ANSI.bold}${percentText}${ANSI.reset}`;

    if (workerInfo) {
      const workerLine = `${workerInfo}`;
      process.stdout.write(`${workerLine}\n${infoLine}\n${barLine}`);
      this.progressLineCount = 3;
      return;
    }

    process.stdout.write(`${infoLine}\n${barLine}`);
    this.progressLineCount = 2;
  }

  /**
   * Compact single-line progress for medium terminals.
   * Shows: [████░░░░] 50% (5/10) 1m 30s
   */
  private renderCompactProgress(
    termWidth: number,
    current: number,
    total: number,
    percent: number,
    elapsed: string,
    workerInfo: string
  ): void {
    const stats = `(${current}/${total})`;
    const percentText = `${percent}%`;
    const suffix = ` ${percentText} ${stats} ${elapsed}`;
    const suffixLen = this.stripAnsi(suffix).length;

    const bracketSpace = 2;
    const barWidth = Math.max(8, termWidth - suffixLen - bracketSpace);

    const filledWidth = Math.round((percent / 100) * barWidth);
    const emptyWidth = barWidth - filledWidth;

    const line = `${ANSI.dim}[${ANSI.reset}${ANSI.green}${"█".repeat(filledWidth)}${ANSI.gray}${"░".repeat(emptyWidth)}${ANSI.reset}${ANSI.dim}]${ANSI.reset} ${ANSI.bold}${percentText}${ANSI.reset} ${ANSI.dim}${stats} ${elapsed}${ANSI.reset}`;

    if (workerInfo) {
      process.stdout.write(`${workerInfo}\n${line}`);
      this.progressLineCount = 2;
      return;
    }

    process.stdout.write(line);
    this.progressLineCount = 1;
  }

  /**
   * Minimal progress for very small terminals.
   * Shows just: [████░░░░] 50%
   */
  private renderMinimalProgress(
    termWidth: number,
    percent: number,
    workerInfo: string
  ): void {
    const percentText = `${percent}%`;
    const percentWidth = percentText.length;
    const bracketSpace = 2;
    const spaceBetween = 1;
    const barWidth = Math.max(
      5,
      termWidth - percentWidth - bracketSpace - spaceBetween
    );

    const filledWidth = Math.round((percent / 100) * barWidth);
    const emptyWidth = barWidth - filledWidth;

    const line = `${ANSI.dim}[${ANSI.reset}${ANSI.green}${"█".repeat(filledWidth)}${ANSI.gray}${"░".repeat(emptyWidth)}${ANSI.reset}${ANSI.dim}]${ANSI.reset} ${ANSI.bold}${percentText}${ANSI.reset}`;

    if (workerInfo) {
      process.stdout.write(`${workerInfo}\n${line}`);
      this.progressLineCount = 2;
      return;
    }

    process.stdout.write(line);
    this.progressLineCount = 1;
  }

  /**
   * Strip ANSI escape codes to get actual visible string length.
   */
  private stripAnsi(str: string): string {
    return str.replace(ANSI_PATTERN, "");
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
    const seconds = Math.max(1, Math.round(ms / 1000));
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
  logPageSaved(url: string, depth?: number, agent?: string): void {
    const depthInfo =
      depth !== undefined ? ` ${ANSI.dim}(depth ${depth})${ANSI.reset}` : "";
    const agentInfo =
      this.config.verbose && agent
        ? ` ${ANSI.dim}[${agent}]${ANSI.reset}`
        : undefined;
    this.success(
      `Saved ${ANSI.cyan}${url}${ANSI.reset}${depthInfo}${agentInfo ?? ""}`
    );
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
