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
    "Targets can also be provided with flags: --crawl, --url, --urls",
    "",
    "Options:",
    "  -d, --max-depth <n>      Max crawl depth from start (default: 3)",
    "  -p, --max-pages <n>      Max pages to fetch during crawl (default: 200)",
    "      --delay <ms>         Minimum delay between requests (default: 500)",
    "  -o, --output <path>      Output directory (default: .docs)",
    "  -c, --concurrency <n>    Parallel workers (default: 4)",
    "  -t, --timeout <ms>       Fetch timeout in ms (default: 15000)",
    "      --retries <n>        Retry attempts (default: 2)",
    "  -a, --user-agent <str>   Custom User-Agent header",
    "",
    "  -v, --[no-]verbose       Enable/disable verbose logging (default: off)",
    "  -r, --[no-]robots        Respect/ignore robots.txt (default: on)",
    "      --[no-]render        Enable/disable headless rendering for SPAs (default: on)",
    "      --[no-]progress      Show/hide progress bar (default: on)",
    "      --[no-]overwrite     Overwrite existing .llms.md files (default: off)",
    "",
    "  -h, --help               Show this help",
    "",
    "Examples:",
    "  aidocs https://example.com",
    "  aidocs crawl https://example.com/docs -d 5 -p 100",
    "  aidocs url https://example.com/about -v",
    "  aidocs urls urls.txt -c 8 --no-render",
  ];
  console.info(lines.join("\n"));
}

type FlagHandler = (valueFromEq: string | undefined) => void;

interface FlagDefinition {
  handler: FlagHandler;
  aliases?: string[];
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

  // Define all flag handlers with their primary flag and aliases
  const flagDefinitions: FlagDefinition[] = [
    // Target flags
    {
      handler: (v) => {
        opts.url = consumeNext(v);
      },
      aliases: ["--url"],
    },
    {
      handler: (v) => {
        opts.urlsFile = consumeNext(v);
      },
      aliases: ["--urls"],
    },
    {
      handler: (v) => {
        opts.crawlStart = consumeNext(v);
      },
      aliases: ["--crawl"],
    },

    // Output directory
    {
      handler: (v) => {
        opts.outDir = consumeNext(v) ?? DEFAULT_OPTIONS.outDir;
      },
      aliases: ["-o", "--output", "--out-dir", "--outdir"],
    },

    // Crawl settings
    {
      handler: (v) => {
        const raw = consumeNext(v);
        opts.maxDepth = parsePositiveInt(raw, DEFAULT_OPTIONS.maxDepth);
      },
      aliases: ["-d", "--max-depth", "--maxdepth"],
    },
    {
      handler: (v) => {
        const raw = consumeNext(v);
        opts.maxPages = parsePositiveInt(raw, DEFAULT_OPTIONS.maxPages);
      },
      aliases: ["-p", "--max-pages", "--maxpages"],
    },
    {
      handler: (v) => {
        const raw = consumeNext(v);
        opts.delayMs = parsePositiveInt(raw, DEFAULT_OPTIONS.delayMs);
      },
      aliases: ["--delay"],
    },

    // Network settings
    {
      handler: (v) => {
        const raw = consumeNext(v);
        opts.concurrency = parsePositiveInt(raw, DEFAULT_OPTIONS.concurrency);
      },
      aliases: ["-c", "--concurrency"],
    },
    {
      handler: (v) => {
        const raw = consumeNext(v);
        opts.timeoutMs = parsePositiveInt(raw, DEFAULT_OPTIONS.timeoutMs);
      },
      aliases: ["-t", "--timeout"],
    },
    {
      handler: (v) => {
        const raw = consumeNext(v);
        opts.retries = parsePositiveInt(raw, DEFAULT_OPTIONS.retries);
      },
      aliases: ["--retries"],
    },
    {
      handler: (v) => {
        opts.userAgent = consumeNext(v) ?? DEFAULT_OPTIONS.userAgent;
      },
      aliases: ["-a", "--user-agent", "--useragent"],
    },

    // Boolean flags with --no- variants
    {
      handler: () => {
        opts.verbose = true;
      },
      aliases: ["-v", "--verbose"],
    },
    {
      handler: () => {
        opts.verbose = false;
      },
      aliases: ["--no-verbose"],
    },

    {
      handler: () => {
        opts.respectRobots = true;
      },
      aliases: ["-r", "--robots"],
    },
    {
      handler: () => {
        opts.respectRobots = false;
      },
      aliases: ["--no-robots"],
    },

    {
      handler: () => {
        opts.render = true;
      },
      aliases: ["--render"],
    },
    {
      handler: () => {
        opts.render = false;
      },
      aliases: ["--no-render"],
    },

    {
      handler: () => {
        opts.progress = true;
      },
      aliases: ["--progress"],
    },
    {
      handler: () => {
        opts.progress = false;
      },
      aliases: ["--no-progress"],
    },

    {
      handler: () => {
        opts.overwriteLlms = true;
      },
      aliases: ["--overwrite", "--overwrite-llms"],
    },
    {
      handler: () => {
        opts.overwriteLlms = false;
      },
      aliases: ["--no-overwrite", "--no-overwrite-llms"],
    },

    // Help
    {
      handler: () => {
        showHelp = true;
      },
      aliases: ["-h", "--help"],
    },
  ];

  // Build a lookup map from all aliases to their handlers
  const handlers = new Map<string, FlagHandler>();
  for (const def of flagDefinitions) {
    if (def.aliases) {
      for (const alias of def.aliases) {
        handlers.set(alias, def.handler);
      }
    }
  }

  for (const arg of iterator) {
    const [flag, valueFromEq] = arg.split("=", 2);
    const normalizedFlag = flag?.toLowerCase();
    const handler = handlers.get(normalizedFlag ?? "");

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
