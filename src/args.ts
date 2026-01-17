import { DEFAULT_OPTIONS } from "./constants";
import { logger } from "./logger";
import type { CliOptions } from "./types";
import { parsePositiveInt } from "./utils";

export interface ParseResult {
  options: CliOptions;
  showHelp: boolean;
}

export function printHelp(): void {
  const lines = [
    "Usage:",
    "  aidocs [crawl] <url> [options]   (default)",
    "  aidocs url <url> [options]       (single page)",
    "  aidocs urls <file> [options]     (list of pages)",
    "",
    "Targets can also be provided with legacy flags: --crawl, --url, --urls",
    "Options:",
    "  --maxDepth <n>         Max crawl depth from start (default 3)",
    "  --maxPages <n>         Max pages to fetch during crawl (default 200)",
    "  --delay <ms>           Minimum delay between requests (default 500)",
    "  --no-robots            Ignore robots.txt (respect by default)",
    "  --outDir <path>        Output directory (default .docs)",
    "  --concurrency <n>      Parallel workers (default 4)",
    "  --timeout <ms>         Fetch timeout in ms (default 15000)",
    "  --retries <n>          Retry attempts (default 2)",
    "  --userAgent <string>   Custom User-Agent header",
    "  --verbose              Verbose logging",
    "  --overwrite-llms       Overwrite .llms.md and llms-full.md outputs",
    "  --no-render            Skip headless rendering fallback for SPAs",
    "  --help                 Show this help",
    "",
    "Examples:",
    "  aidocs https://example.com",
    "  aidocs crawl https://example.com/docs",
    "  aidocs url https://example.com/about",
    "  aidocs urls urls.txt",
  ];
  console.info(lines.join("\n"));
}

export function parseArgs(args: string[]): ParseResult {
  const opts: CliOptions = { ...DEFAULT_OPTIONS };

  const iterator = args[Symbol.iterator]();
  const positionalArgs: string[] = [];
  let showHelp = false;

  const consumeNext = (valueFromEq: string | undefined): string | undefined => {
    if (valueFromEq) {
      return valueFromEq;
    }
    const next = iterator.next();
    return next.done ? undefined : next.value;
  };

  const handlers: Record<string, (valueFromEq: string | undefined) => void> = {
    "--url": (valueFromEq) => {
      opts.url = consumeNext(valueFromEq);
    },
    "--urls": (valueFromEq) => {
      opts.urlsFile = consumeNext(valueFromEq);
    },
    "--crawl": (valueFromEq) => {
      opts.crawlStart = consumeNext(valueFromEq);
    },
    "--outDir": (valueFromEq) => {
      opts.outDir = consumeNext(valueFromEq) ?? DEFAULT_OPTIONS.outDir;
    },
    "--concurrency": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.concurrency = parsePositiveInt(raw, DEFAULT_OPTIONS.concurrency);
    },
    "--timeout": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.timeoutMs = parsePositiveInt(raw, DEFAULT_OPTIONS.timeoutMs);
    },
    "--retries": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.retries = parsePositiveInt(raw, DEFAULT_OPTIONS.retries);
    },
    "--userAgent": (valueFromEq) => {
      opts.userAgent = consumeNext(valueFromEq) ?? DEFAULT_OPTIONS.userAgent;
    },
    "--verbose": () => {
      opts.verbose = true;
    },
    "--overwrite-llms": () => {
      opts.overwriteLlms = true;
    },
    "--render": () => {
      opts.render = true;
    },
    "--no-render": () => {
      opts.render = false;
    },
    "--maxDepth": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.maxDepth = parsePositiveInt(raw, DEFAULT_OPTIONS.maxDepth);
    },
    "--maxPages": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.maxPages = parsePositiveInt(raw, DEFAULT_OPTIONS.maxPages);
    },
    "--delay": (valueFromEq) => {
      const raw = consumeNext(valueFromEq);
      opts.delayMs = parsePositiveInt(raw, DEFAULT_OPTIONS.delayMs);
    },
    "--no-robots": () => {
      opts.respectRobots = false;
    },
    "--help": () => {
      showHelp = true;
    },
  };

  for (const arg of iterator) {
    const [flag, valueFromEq] = arg.split("=", 2);
    const handler = handlers[flag as keyof typeof handlers];
    if (handler) {
      handler(valueFromEq);
    } else {
      positionalArgs.push(arg);
    }
  }

  const applyTargetFromPositional = (): void => {
    if (opts.url || opts.urlsFile || opts.crawlStart) {
      return;
    }

    type TargetKeyword = "crawl" | "url" | "urls";

    const keywordErrorMessages: Record<TargetKeyword, string> = {
      url: 'Provide a URL after "url" (e.g. url https://example.com/about)',
      urls: 'Provide a file path after "urls" (e.g. urls ./targets.txt)',
      crawl:
        'Provide a start URL after "crawl" (e.g. crawl https://example.com/docs)',
    };

    const warnExtraArgs = (extras: string[]): void => {
      if (extras.length === 0) {
        return;
      }
      logger.warn(`Ignoring extra positional arguments: ${extras.join(", ")}`);
    };

    const ensureValidUrl = (value: string, errorMessage: string): string => {
      try {
        new URL(value);
        return value;
      } catch {
        throw new Error(errorMessage);
      }
    };

    const setTargetValue = (kind: TargetKeyword, value: string): void => {
      if (kind === "url") {
        opts.url = ensureValidUrl(value, keywordErrorMessages.url);
        return;
      }
      if (kind === "urls") {
        opts.urlsFile = value;
        return;
      }
      opts.crawlStart = ensureValidUrl(value, keywordErrorMessages.crawl);
    };

    const isTargetKeyword = (value: string): value is TargetKeyword =>
      value === "url" || value === "urls" || value === "crawl";

    if (positionalArgs.length === 0) {
      if (!showHelp) {
        showHelp = true;
      }
      return;
    }

    const [first, ...rest] = positionalArgs;
    if (typeof first !== "string") {
      // Defensive: Should not happen, but enhances type safety and avoids undefined errors.
      if (!showHelp) {
        showHelp = true;
      }
      return;
    }
    const normalized = first.toLowerCase();

    if (isTargetKeyword(normalized)) {
      const target = rest[0];
      if (!target) {
        throw new Error(keywordErrorMessages[normalized]);
      }
      setTargetValue(normalized, target);
      warnExtraArgs(rest.slice(1));
      return;
    }

    const errorMessage = `"${first}" is not a valid URL. Provide a start URL, "url <url>", or "urls <file>"`;
    opts.crawlStart = ensureValidUrl(first, errorMessage);
    warnExtraArgs(rest);
  };

  applyTargetFromPositional();

  return { options: opts, showHelp };
}
