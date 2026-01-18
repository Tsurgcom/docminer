import { DEFAULT_OPTIONS } from "./constants";
import { logger } from "./logger";
import type { CliOptions, FindOptions, LinkCheckOptions } from "./types";
import { parsePositiveInt } from "./utils";

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  query: "",
  directory: ".docs",
  filesOnly: false,
  contentOnly: false,
  limit: 20,
  contextLines: 2,
};

export interface CrawlParseResult {
  command: "crawl";
  options: CliOptions;
  showHelp: boolean;
}

export interface ScrapeParseResult {
  command: "scrape";
  options: CliOptions;
  showHelp: boolean;
}

export interface FindParseResult {
  command: "find";
  options: FindOptions;
  showHelp: boolean;
}

export interface LinkCheckParseResult {
  command: "link-check";
  options: LinkCheckOptions;
  showHelp: boolean;
}

export type ParseResult =
  | CrawlParseResult
  | ScrapeParseResult
  | FindParseResult
  | LinkCheckParseResult;

export function printHelp(): void {
  const lines = [
    "Usage:",
    "  aidocs [crawl]                   Crawl and scrape documentation (default)",
    "  aidocs url <url> [options]       Scrape a single page",
    "  aidocs urls <file> [options]     Scrape pages from a file",
    "  aidocs find <query> [options]    Search scraped docs",
    "  aidocs link-check [options]      Re-link saved docs",
    "",
    "Run 'aidocs <command> --help' for command-specific options.",
    "",
    "Examples:",
    "  aidocs https://example.com",
    "  aidocs crawl https://example.com/docs -d 5",
    '  aidocs find "hooks"',
  ];
  console.info(lines.join("\n"));
  console.info("\n--------------------------------\n");
  printCrawlHelp();
}

export function printCrawlHelp(): void {
  const lines = [
    "Usage:",
    "  aidocs [crawl] <url> [options]",
    "",
    "Crawl a website starting from the given URL and scrape documentation.",
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
    "      --[no-]clutter       Write .clutter.md output (default: off)",
    "",
    "  -h, --help               Show this help",
    "",
    "Examples:",
    "  aidocs crawl https://example.com",
    "  aidocs crawl https://example.com/docs -d 5 -p 100",
    "  aidocs crawl https://react.dev --no-render -c 8",
  ];
  console.info(lines.join("\n"));
}

export function printScrapeHelp(): void {
  const lines = [
    "Usage:",
    "  aidocs url <url> [options]       (single page)",
    "  aidocs urls <file> [options]     (list of pages)",
    "",
    "Options:",
    "  -o, --output <path>      Output directory (default: .docs)",
    "  -c, --concurrency <n>    Parallel workers (default: 4)",
    "  -t, --timeout <ms>       Fetch timeout in ms (default: 15000)",
    "      --retries <n>        Retry attempts (default: 2)",
    "  -a, --user-agent <str>   Custom User-Agent header",
    "",
    "  -v, --[no-]verbose       Enable/disable verbose logging (default: off)",
    "      --[no-]render        Enable/disable headless rendering for SPAs (default: on)",
    "      --[no-]progress      Show/hide progress bar (default: on)",
    "      --[no-]overwrite     Overwrite existing .llms.md files (default: off)",
    "      --[no-]clutter       Write .clutter.md output (default: off)",
    "",
    "  -h, --help               Show this help",
    "",
    "Examples:",
    "  aidocs url https://example.com/about -v",
    "  aidocs urls urls.txt -c 8 --no-render",
  ];
  console.info(lines.join("\n"));
}

export function printFindHelp(): void {
  const lines = [
    "Usage:",
    "  aidocs find <query> [options]",
    "",
    "Search through scraped documentation using fuzzy matching.",
    "",
    "Options:",
    "  -d, --directory <path>   Directory to search (default: .docs)",
    "      --files-only         Only search file paths",
    "      --content-only       Only search file content",
    "  -l, --limit <n>          Max results to show (default: 20)",
    "  -C, --context <n>        Lines of context around matches (default: 2)",
    "",
    "  -h, --help               Show this help",
    "",
    "Examples:",
    '  aidocs find "catalogs"',
    '  aidocs find "react hooks" --files-only',
    '  aidocs find "api" -l 10 -C 4',
    '  aidocs find "config" -d ./other-docs',
  ];
  console.info(lines.join("\n"));
}

export function printLinkCheckHelp(): void {
  const lines = [
    "Usage:",
    "  aidocs link-check [options]",
    "",
    "Scan saved docs and update links across outputs.",
    "",
    "Options:",
    "  -o, --output <path>      Docs directory (default: .docs)",
    "  -v, --[no-]verbose       Enable/disable verbose logging (default: off)",
    "",
    "  -h, --help               Show this help",
    "",
    "Examples:",
    "  aidocs link-check",
    "  aidocs link-check -o ./other-docs",
  ];
  console.info(lines.join("\n"));
}

type FlagHandler = (valueFromEq: string | undefined) => void;

interface FlagDefinition {
  handler: FlagHandler;
  aliases?: string[];
}

function parseFindArgs(args: string[]): FindParseResult {
  const opts: FindOptions = { ...DEFAULT_FIND_OPTIONS };
  let showHelp = false;

  const iterator = args[Symbol.iterator]();
  const positionalArgs: string[] = [];

  const consumeNext = (valueFromEq: string | undefined): string | undefined => {
    if (valueFromEq) {
      return valueFromEq;
    }
    const next = iterator.next();
    return next.done ? undefined : next.value;
  };

  const flagDefinitions: FlagDefinition[] = [
    {
      handler: (v) => {
        opts.directory = consumeNext(v) ?? DEFAULT_FIND_OPTIONS.directory;
      },
      aliases: ["-d", "--directory", "--dir"],
    },
    {
      handler: () => {
        opts.filesOnly = true;
      },
      aliases: ["--files-only", "--files"],
    },
    {
      handler: () => {
        opts.contentOnly = true;
      },
      aliases: ["--content-only", "--content"],
    },
    {
      handler: (v) => {
        const raw = consumeNext(v);
        opts.limit = parsePositiveInt(raw, DEFAULT_FIND_OPTIONS.limit);
      },
      aliases: ["-l", "--limit"],
    },
    {
      handler: (v) => {
        const raw = consumeNext(v);
        opts.contextLines = parsePositiveInt(
          raw,
          DEFAULT_FIND_OPTIONS.contextLines
        );
      },
      aliases: ["-c", "--context"],
    },
    {
      handler: () => {
        showHelp = true;
      },
      aliases: ["-h", "--help"],
    },
  ];

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

  // First positional arg is the query
  const firstArg = positionalArgs[0];
  if (firstArg) {
    opts.query = firstArg;
  }

  if (positionalArgs.length > 1) {
    logger.warn(
      `Ignoring extra positional arguments: ${positionalArgs.slice(1).join(", ")}`
    );
  }

  // If no query provided, show help
  if (!(opts.query || showHelp)) {
    showHelp = true;
  }

  return { command: "find", options: opts, showHelp };
}

function parseLinkCheckArgs(args: string[]): LinkCheckParseResult {
  const opts: LinkCheckOptions = {
    directory: DEFAULT_OPTIONS.outDir,
    verbose: DEFAULT_OPTIONS.verbose,
  };
  let showHelp = false;

  const iterator = args[Symbol.iterator]();
  const positionalArgs: string[] = [];

  const consumeNext = (valueFromEq: string | undefined): string | undefined => {
    if (valueFromEq) {
      return valueFromEq;
    }
    const next = iterator.next();
    return next.done ? undefined : next.value;
  };

  const flagDefinitions: FlagDefinition[] = [
    {
      handler: (v) => {
        opts.directory = consumeNext(v) ?? DEFAULT_OPTIONS.outDir;
      },
      aliases: [
        "-o",
        "--output",
        "--out-dir",
        "--outdir",
        "-d",
        "--directory",
        "--dir",
      ],
    },
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
        showHelp = true;
      },
      aliases: ["-h", "--help"],
    },
  ];

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

  if (positionalArgs.length > 0) {
    logger.warn(`Ignoring positional arguments: ${positionalArgs.join(", ")}`);
  }

  return { command: "link-check", options: opts, showHelp };
}

function parseCrawlArgs(args: string[]): CrawlParseResult {
  const opts: CliOptions = { ...DEFAULT_OPTIONS };
  let showHelp = false;

  const iterator = args[Symbol.iterator]();
  const positionalArgs: string[] = [];

  const consumeNext = (valueFromEq: string | undefined): string | undefined => {
    if (valueFromEq) {
      return valueFromEq;
    }
    const next = iterator.next();
    return next.done ? undefined : next.value;
  };

  const flagDefinitions: FlagDefinition[] = [
    {
      handler: (v) => {
        opts.outDir = consumeNext(v) ?? DEFAULT_OPTIONS.outDir;
      },
      aliases: ["-o", "--output", "--out-dir", "--outdir"],
    },
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
    {
      handler: () => {
        opts.clutter = true;
      },
      aliases: ["--clutter"],
    },
    {
      handler: () => {
        opts.clutter = false;
      },
      aliases: ["--no-clutter"],
    },
    {
      handler: () => {
        showHelp = true;
      },
      aliases: ["-h", "--help"],
    },
  ];

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

  // First positional arg is the URL
  const firstArg = positionalArgs[0];
  if (firstArg) {
    try {
      new URL(firstArg);
      opts.crawlStart = firstArg;
    } catch {
      throw new Error(
        `"${firstArg}" is not a valid URL. Provide a URL (e.g. crawl https://example.com/docs)`
      );
    }
  }

  if (positionalArgs.length > 1) {
    logger.warn(
      `Ignoring extra positional arguments: ${positionalArgs.slice(1).join(", ")}`
    );
  }

  // If no URL provided, show help
  if (!(opts.crawlStart || showHelp)) {
    showHelp = true;
  }

  return { command: "crawl", options: opts, showHelp };
}

export function parseArgs(args: string[]): ParseResult {
  const firstArg = args[0];
  const normalizedFirst = firstArg?.toLowerCase();

  // Check if first argument is "find" command
  if (normalizedFirst === "find") {
    return parseFindArgs(args.slice(1));
  }

  if (normalizedFirst === "link-check" || normalizedFirst === "linkcheck") {
    return parseLinkCheckArgs(args.slice(1));
  }

  // Check if first argument is "crawl" command
  if (normalizedFirst === "crawl") {
    return parseCrawlArgs(args.slice(1));
  }

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
    {
      handler: () => {
        opts.clutter = true;
      },
      aliases: ["--clutter"],
    },
    {
      handler: () => {
        opts.clutter = false;
      },
      aliases: ["--no-clutter"],
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

  return { command: "scrape", options: opts, showHelp };
}
