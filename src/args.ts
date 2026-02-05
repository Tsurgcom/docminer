import { DEFAULT_OPTIONS } from "./constants";
import { logger } from "./logger";
import { packageVersion } from "./package-info";
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

export const DEFAULT_LINK_CHECK_OPTIONS: LinkCheckOptions = {
  directory: DEFAULT_OPTIONS.outDir,
  verbose: DEFAULT_OPTIONS.verbose,
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

export interface VersionParseResult {
  command: "version";
  showVersion: true;
}

export interface InstallPlaywrightParseResult {
  command: "install-playwright";
  showHelp: boolean;
  args: string[];
}

export type ParseResult =
  | CrawlParseResult
  | ScrapeParseResult
  | FindParseResult
  | LinkCheckParseResult
  | VersionParseResult
  | InstallPlaywrightParseResult;

// ============================================================================
// COMMANDS DEFINITION
// ============================================================================

interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  examples: string[];
  optionsType: "CliOptions" | "FindOptions" | "LinkCheckOptions";
  subcommands?: string[];
  positionalArgs?: {
    name: string;
    required: boolean;
    description: string;
  }[];
}

const COMMANDS: Record<string, CommandDefinition> = {
  crawl: {
    name: "crawl",
    description:
      "Crawl a website starting from the given URL and scrape documentation.",
    usage: "docminer [crawl] <url> [options]",
    examples: [
      "docminer crawl https://example.com",
      "docminer crawl https://example.com/docs -d 5 -p 100",
      "docminer crawl https://react.dev --no-render -c 8",
    ],
    optionsType: "CliOptions",
    positionalArgs: [
      {
        name: "url",
        required: true,
        description: "Start URL for crawling",
      },
    ],
  },
  scrape: {
    name: "scrape",
    description: "Scrape documentation pages.",
    usage: "docminer <command> <target> [options]",
    examples: [
      "docminer url https://example.com/about -v",
      "docminer urls urls.txt -c 8 --no-render",
    ],
    optionsType: "CliOptions",
    subcommands: ["url", "urls"],
  },
  find: {
    name: "find",
    description: "Search through scraped documentation using fuzzy matching.",
    usage: "docminer find <query> [options]",
    examples: [
      'docminer find "catalogs"',
      'docminer find "react hooks" --files-only',
      'docminer find "api" -l 10 -C 4',
      'docminer find "config" -d ./other-docs',
    ],
    optionsType: "FindOptions",
    positionalArgs: [
      {
        name: "query",
        required: true,
        description: "Search query",
      },
    ],
  },
  "link-check": {
    name: "link-check",
    description: "Scan saved docs and update links across outputs.",
    usage: "docminer link-check [options]",
    examples: ["docminer link-check", "docminer link-check -o ./other-docs"],
    optionsType: "LinkCheckOptions",
  },
};

// ============================================================================
// FLAGS DEFINITION
// ============================================================================

interface FlagDefinition {
  name: string;
  aliases: string[];
  description: string;
  type: "string" | "number" | "boolean" | "boolean-toggle";
  commands: string[];
  defaultValue: string | number | boolean | undefined;
  group: string;
}

const FLAGS: FlagDefinition[] = [
  // ============================================================================
  // TARGET FLAGS (scrape commands)
  // ============================================================================
  {
    name: "url",
    aliases: ["--url"],
    description: "Single URL to scrape",
    type: "string",
    commands: ["scrape"],
    defaultValue: undefined,
    group: "target",
  },
  {
    name: "urls-file",
    aliases: ["--urls"],
    description: "File containing URLs to scrape",
    type: "string",
    commands: ["scrape"],
    defaultValue: undefined,
    group: "target",
  },
  {
    name: "crawl-start",
    aliases: ["--crawl"],
    description: "Start URL for crawling",
    type: "string",
    commands: ["scrape"],
    defaultValue: undefined,
    group: "target",
  },

  // ============================================================================
  // OUTPUT SETTINGS
  // ============================================================================
  {
    name: "outDir",
    aliases: ["-o", "--output", "--out-dir", "--outdir"],
    description: "Output directory",
    type: "string",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.outDir,
    group: "output",
  },
  {
    name: "directory",
    aliases: ["-o", "--output"],
    description: "Docs directory",
    type: "string",
    commands: ["link-check"],
    defaultValue: DEFAULT_LINK_CHECK_OPTIONS.directory,
    group: "output",
  },
  {
    name: "directory",
    aliases: ["-d", "--directory", "--dir"],
    description: "Directory to search",
    type: "string",
    commands: ["find"],
    defaultValue: DEFAULT_FIND_OPTIONS.directory,
    group: "output",
  },

  // ============================================================================
  // CRAWL SETTINGS
  // ============================================================================
  {
    name: "maxDepth",
    aliases: ["-d", "--max-depth", "--maxdepth"],
    description: "Max crawl depth from start",
    type: "number",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.maxDepth,
    group: "crawl",
  },
  {
    name: "maxPages",
    aliases: ["-p", "--max-pages", "--maxpages"],
    description: "Max pages to fetch during crawl",
    type: "number",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.maxPages,
    group: "crawl",
  },
  {
    name: "delayMs",
    aliases: ["--delay"],
    description: "Minimum delay between requests",
    type: "number",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.delayMs,
    group: "crawl",
  },

  // ============================================================================
  // NETWORK SETTINGS
  // ============================================================================
  {
    name: "concurrency",
    aliases: ["-c", "--concurrency"],
    description: "Parallel workers",
    type: "number",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.concurrency,
    group: "network",
  },
  {
    name: "timeoutMs",
    aliases: ["-t", "--timeout"],
    description: "Fetch timeout in ms",
    type: "number",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.timeoutMs,
    group: "network",
  },
  {
    name: "retries",
    aliases: ["--retries"],
    description: "Retry attempts",
    type: "number",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.retries,
    group: "network",
  },
  {
    name: "userAgent",
    aliases: ["-a", "--user-agent", "--useragent"],
    description: "Custom User-Agent header",
    type: "string",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.userAgent,
    group: "network",
  },

  // ============================================================================
  // SEARCH SETTINGS (find command)
  // ============================================================================
  {
    name: "filesOnly",
    aliases: ["--files-only", "--files"],
    description: "Only search file paths",
    type: "boolean",
    commands: ["find"],
    defaultValue: DEFAULT_FIND_OPTIONS.filesOnly,
    group: "search",
  },
  {
    name: "contentOnly",
    aliases: ["--content-only", "--content"],
    description: "Only search file content",
    type: "boolean",
    commands: ["find"],
    defaultValue: DEFAULT_FIND_OPTIONS.contentOnly,
    group: "search",
  },
  {
    name: "limit",
    aliases: ["-l", "--limit"],
    description: "Max results to show",
    type: "number",
    commands: ["find"],
    defaultValue: DEFAULT_FIND_OPTIONS.limit,
    group: "search",
  },
  {
    name: "contextLines",
    aliases: ["-C", "--context"],
    description: "Lines of context around matches",
    type: "number",
    commands: ["find"],
    defaultValue: DEFAULT_FIND_OPTIONS.contextLines,
    group: "search",
  },

  // ============================================================================
  // BOOLEAN TOGGLE FLAGS
  // ============================================================================
  {
    name: "verbose",
    aliases: ["-v", "--verbose", "--no-verbose"],
    description: "Enable/disable verbose logging",
    type: "boolean-toggle",
    commands: ["crawl", "scrape", "link-check"],
    defaultValue: DEFAULT_OPTIONS.verbose,
    group: "behavior",
  },
  {
    name: "respectRobots",
    aliases: ["-r", "--robots", "--no-robots"],
    description: "Respect/ignore robots.txt",
    type: "boolean-toggle",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.respectRobots,
    group: "behavior",
  },
  {
    name: "render",
    aliases: ["--render", "--no-render"],
    description: "Enable/disable headless rendering for SPAs",
    type: "boolean-toggle",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.render,
    group: "behavior",
  },
  {
    name: "progress",
    aliases: ["--progress", "--no-progress"],
    description: "Show/hide progress bar",
    type: "boolean-toggle",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.progress,
    group: "behavior",
  },
  {
    name: "overwriteLlms",
    aliases: [
      "--overwrite",
      "--overwrite-llms",
      "--no-overwrite",
      "--no-overwrite-llms",
    ],
    description: "Overwrite existing .llms.md files",
    type: "boolean-toggle",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.overwriteLlms,
    group: "behavior",
  },
  {
    name: "clutter",
    aliases: ["--clutter", "--no-clutter"],
    description: "Write .clutter.md output",
    type: "boolean-toggle",
    commands: ["crawl", "scrape"],
    defaultValue: DEFAULT_OPTIONS.clutter,
    group: "behavior",
  },

  // ============================================================================
  // HELP
  // ============================================================================
  {
    name: "help",
    aliases: ["-h", "--help"],
    description: "Show this help",
    type: "boolean",
    commands: ["crawl", "scrape", "find", "link-check"],
    defaultValue: false,
    group: "help",
  },

  // ============================================================================
  // VERSION (hidden)
  // ============================================================================
  {
    name: "version",
    aliases: ["--version"],
    description: "Show version",
    type: "boolean",
    commands: [], // Empty to hide from help
    defaultValue: false,
    group: "help",
  },
];

// ============================================================================
// HELP GENERATION
// ============================================================================

export function printHelp(): void {
  const lines = [
    "",
    "┌───────────────────────────────┐",
    (() => {
      const label = `Docminer ${packageVersion}`;
      const totalWidth = 31;
      const padding = Math.floor((totalWidth - label.length) / 2);
      const padded = `${" ".repeat(padding)}${label}${" ".repeat(totalWidth - label.length - padding)}`;
      return `│${padded}│`;
    })(),
    "└───────────────────────────────┘",
    "",
    "Usage:",
    "  docminer [crawl]                   Crawl and scrape documentation (default)",
    "  docminer url <url> [options]       Scrape a single page",
    "  docminer urls <file> [options]     Scrape pages from a file",
    "  docminer find <query> [options]    Search scraped docs",
    "  docminer link-check [options]      Re-link saved docs",
    "  docminer install-playwright        Install Playwright browsers",
    "",
    "Run 'docminer <command> --help' for command-specific options.",
    "",
    "Run docminer crawl -h for crawl help.",
  ];
  console.info(lines.join("\n"));
}

export function printCommandHelp(commandName: string): void {
  const command = COMMANDS[commandName];
  if (!command) {
    throw new Error(`Unknown command: ${commandName}`);
  }

  const lines = ["Usage:", `  ${command.usage}`, "", command.description, ""];

  // Get flags for this command
  const commandFlags = FLAGS.filter((flag) =>
    flag.commands.includes(commandName)
  );

  if (commandFlags.length > 0) {
    lines.push("Options:");
    lines.push(...generateFlagLines(commandFlags));
    lines.push("");
  }

  lines.push("  -h, --help               Show this help");

  if (command.examples.length > 0) {
    lines.push("");
    lines.push("Examples:");
    for (const example of command.examples) {
      lines.push(`  ${example}`);
    }
  }

  console.info(lines.join("\n"));
}

// ============================================================================
// HELP GENERATION HELPERS
// ============================================================================

function groupFlagsByGroup(
  flags: FlagDefinition[]
): Record<string, FlagDefinition[]> {
  return flags.reduce(
    (acc, flag) => {
      const group = flag.group;
      if (!acc[group]) {
        acc[group] = [];
      }
      acc[group].push(flag);
      return acc;
    },
    {} as Record<string, FlagDefinition[]>
  );
}

function formatFlagAliases(aliases: string[]): {
  short: string[];
  long: string[];
} {
  const processed = aliases.map((alias) => {
    if (alias.startsWith("--")) {
      return alias;
    }
    return alias;
  });

  return {
    short: processed.filter(
      (alias) => alias.startsWith("-") && alias.length === 2
    ),
    long: processed.filter(
      (alias) => alias.startsWith("--") || alias.length > 2
    ),
  };
}

function formatFlagLine(flag: FlagDefinition, maxFlagWidth: number): string {
  const { short, long } = formatFlagAliases(flag.aliases);

  let flagStr = "";
  if (short.length > 0) {
    flagStr += short.join(", ");
  }
  if (long.length > 0) {
    if (flagStr) {
      flagStr += ", ";
    }
    flagStr += long.join(", ");
  }

  let typeStr = "";
  if (flag.type === "boolean-toggle") {
    typeStr = "";
  } else if (flag.type === "boolean") {
    typeStr = "";
  } else {
    typeStr = flag.type === "string" ? "<str>" : "<n>";
  }

  // Calculate the full flag part (flag names + type)
  const fullFlagPart = typeStr ? `${flagStr} ${typeStr}` : flagStr;
  const padding = " ".repeat(Math.max(0, maxFlagWidth - fullFlagPart.length));

  // Format the line with proper alignment
  let line = `  ${fullFlagPart}${padding}  ${flag.description}`;

  // Add default value
  let defaultValue = flag.defaultValue;
  if (typeof defaultValue === "string" && defaultValue.length > 20) {
    defaultValue = `"${defaultValue.substring(0, 17)}..."`;
  } else if (typeof defaultValue === "string") {
    defaultValue = `"${defaultValue}"`;
  }
  line += ` (default: ${defaultValue})`;

  return line;
}

function calculateMaxFlagWidth(flags: FlagDefinition[]): number {
  let maxWidth = 0;

  for (const flag of flags) {
    const { short, long } = formatFlagAliases(flag.aliases);

    let flagStr = "";
    if (short.length > 0) {
      flagStr += short.join(", ");
    }
    if (long.length > 0) {
      if (flagStr) {
        flagStr += ", ";
      }
      flagStr += long.join(", ");
    }

    let typeStr = "";
    if (flag.type !== "boolean-toggle" && flag.type !== "boolean") {
      typeStr = flag.type === "string" ? "<str>" : "<n>";
    }

    const fullFlagPart = typeStr ? `${flagStr} ${typeStr}` : flagStr;
    maxWidth = Math.max(maxWidth, fullFlagPart.length);
  }

  return maxWidth;
}

function generateFlagLines(commandFlags: FlagDefinition[]): string[] {
  const lines: string[] = [];
  const flagsByGroup = groupFlagsByGroup(commandFlags);
  const groupOrder = [
    "target",
    "output",
    "crawl",
    "network",
    "search",
    "behavior",
    "help",
  ];

  // Calculate the maximum width for proper alignment
  const maxFlagWidth = calculateMaxFlagWidth(commandFlags);

  for (const group of groupOrder) {
    const groupFlags = flagsByGroup[group];
    if (!groupFlags) {
      continue;
    }

    // Add a blank line between groups (except for the first group)
    if (lines.length > 0) {
      lines.push("");
    }

    for (const flag of groupFlags) {
      lines.push(formatFlagLine(flag, maxFlagWidth));
    }
  }

  return lines;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

type FlagHandler = (valueFromEq: string | undefined) => void;

function createConsumeNext(
  iterator: Iterator<string>
): (valueFromEq: string | undefined) => string | undefined {
  return (valueFromEq: string | undefined): string | undefined => {
    if (valueFromEq) {
      return valueFromEq;
    }
    const next = iterator.next();
    return next.done ? undefined : next.value;
  };
}

function createHandlersMap(
  flagDefinitions: { aliases: string[]; handler: FlagHandler }[]
): Map<string, FlagHandler> {
  const handlers = new Map<string, FlagHandler>();
  for (const def of flagDefinitions) {
    for (const alias of def.aliases) {
      handlers.set(alias, def.handler);
    }
  }
  return handlers;
}

// ============================================================================
// UNIFIED ARGUMENT PARSER
// ============================================================================

export function parseArgs(args: string[]): ParseResult {
  // Check for version flag
  if (args.includes("--version")) {
    return { command: "version", showVersion: true };
  }

  const firstArg = args[0];
  const normalizedFirst = firstArg?.toLowerCase();

  if (
    normalizedFirst === "install-playwright" ||
    normalizedFirst === "playwright-install"
  ) {
    const helpFlags = new Set(["-h", "--help"]);
    const restArgs = args.slice(1);
    const showHelp = restArgs.some((arg) => helpFlags.has(arg));
    const extraArgs = restArgs.filter((arg) => !helpFlags.has(arg));
    return { command: "install-playwright", showHelp, args: extraArgs };
  }

  // Check if first argument is a command
  if (normalizedFirst === "find") {
    return parseCommandArgs("find", args.slice(1));
  }

  if (normalizedFirst === "link-check" || normalizedFirst === "linkcheck") {
    return parseCommandArgs("link-check", args.slice(1));
  }

  if (normalizedFirst === "crawl") {
    return parseCommandArgs("crawl", args.slice(1));
  }

  // Default to scrape command (url/urls/crawl-start logic)
  return parseCommandArgs("scrape", args);
}

function initializeOptions(
  command: CommandDefinition
): CliOptions | FindOptions | LinkCheckOptions {
  switch (command.optionsType) {
    case "CliOptions":
      return { ...DEFAULT_OPTIONS };
    case "FindOptions":
      return { ...DEFAULT_FIND_OPTIONS };
    case "LinkCheckOptions":
      return { ...DEFAULT_LINK_CHECK_OPTIONS };
    default:
      throw new Error(`Unknown options type: ${command.optionsType}`);
  }
}

function setOptionValue(
  opts: CliOptions | FindOptions | LinkCheckOptions,
  flagName: string,
  value: string | number | boolean | undefined
): void {
  // Type-safe property assignment - check if property exists on the interface
  if (flagName in opts) {
    (opts as unknown as Record<string, unknown>)[flagName] = value;
  }
}

function createFlagHandler(
  flag: FlagDefinition,
  opts: CliOptions | FindOptions | LinkCheckOptions,
  showHelp: { value: boolean },
  consumeNext: (valueFromEq: string | undefined) => string | undefined,
  args: string[]
): (valueFromEq: string | undefined) => void {
  return (valueFromEq: string | undefined) => {
    switch (flag.type) {
      case "string":
      case "number": {
        const value = consumeNext(valueFromEq);
        if (value !== undefined) {
          if (flag.type === "number") {
            const parsed = parsePositiveInt(value, flag.defaultValue as number);
            setOptionValue(opts, flag.name, parsed);
          } else {
            setOptionValue(opts, flag.name, value);
          }
        }
        break;
      }
      case "boolean": {
        if (flag.name === "help") {
          showHelp.value = true;
        } else {
          setOptionValue(opts, flag.name, true);
        }
        break;
      }
      case "boolean-toggle": {
        const isNoVariant = flag.aliases.some(
          (alias) => args.includes(alias) && alias.startsWith("--no-")
        );
        setOptionValue(opts, flag.name, !isNoVariant);
        break;
      }
      default:
        throw new Error(`Unknown flag type: ${flag.type}`);
    }
  };
}

function hasValidPositionalArgs(
  commandName: string,
  positionalArgs: string[]
): boolean {
  switch (commandName) {
    case "find":
      return positionalArgs.length > 0 && positionalArgs[0] !== undefined;
    case "crawl":
      return positionalArgs.length > 0 && positionalArgs[0] !== undefined;
    case "scrape": {
      // For scrape, check if positional args form a valid command
      if (positionalArgs.length === 0) {
        return false;
      }
      const first = positionalArgs[0]?.toLowerCase();
      if (first === "url" || first === "urls" || first === "crawl") {
        // Target keyword provided - need a value after it
        return positionalArgs.length > 1 && positionalArgs[1] !== undefined;
      }
      // Otherwise, treat as URL for crawling
      return true;
    }
    case "link-check":
      return true; // link-check doesn't require positional args
    default:
      return false;
  }
}

function handlePositionalArgs(
  commandName: string,
  positionalArgs: string[],
  opts: CliOptions | FindOptions | LinkCheckOptions,
  showHelp: boolean
): void {
  switch (commandName) {
    case "find": {
      const query = positionalArgs[0];
      if (query) {
        (opts as FindOptions).query = query;
      }
      if (positionalArgs.length > 1) {
        logger.warn(
          `Ignoring extra positional arguments: ${positionalArgs.slice(1).join(", ")}`
        );
      }
      if (!(query || showHelp)) {
        return; // We'll set showHelp later
      }
      break;
    }
    case "crawl": {
      const url = positionalArgs[0];
      if (url) {
        try {
          new URL(url);
          (opts as CliOptions).crawlStart = url;
        } catch {
          throw new Error(
            `"${url}" is not a valid URL. Provide a URL (e.g. crawl https://example.com/docs)`
          );
        }
      }
      if (positionalArgs.length > 1) {
        logger.warn(
          `Ignoring extra positional arguments: ${positionalArgs.slice(1).join(", ")}`
        );
      }
      if (!(url || showHelp)) {
        return; // We'll set showHelp later
      }
      break;
    }
    case "scrape":
      applyScrapeTargetFromPositional(opts as CliOptions, positionalArgs, {
        value: showHelp,
      });
      break;
    case "link-check":
      if (positionalArgs.length > 0) {
        logger.warn(
          `Ignoring positional arguments: ${positionalArgs.join(", ")}`
        );
      }
      break;
    default:
      break;
  }
}

function parseCommandArgs(commandName: string, args: string[]): ParseResult {
  const command = COMMANDS[commandName];
  if (!command) {
    throw new Error(`Unknown command: ${commandName}`);
  }

  const opts = initializeOptions(command);
  const showHelp = { value: false };

  const iterator = args[Symbol.iterator]();
  const positionalArgs: string[] = [];
  const consumeNext = createConsumeNext(iterator);

  // Get flags for this command
  const commandFlags = FLAGS.filter((flag) =>
    flag.commands.includes(commandName)
  );

  // Create flag handlers
  const flagDefinitions = commandFlags.map((flag) => ({
    aliases: flag.aliases,
    handler: createFlagHandler(flag, opts, showHelp, consumeNext, args),
  }));

  const handlers = createHandlersMap(flagDefinitions);

  // Parse arguments
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

  handlePositionalArgs(commandName, positionalArgs, opts, showHelp.value);

  // Set showHelp if no valid positional args and not already set
  if (
    !(showHelp.value || hasValidPositionalArgs(commandName, positionalArgs))
  ) {
    showHelp.value = true;
  }

  // Type-safe return based on command
  switch (commandName) {
    case "crawl":
    case "scrape":
      return {
        command: commandName,
        options: opts as CliOptions,
        showHelp: showHelp.value,
      };
    case "find":
      return {
        command: commandName,
        options: opts as FindOptions,
        showHelp: showHelp.value,
      };
    case "link-check":
      return {
        command: commandName,
        options: opts as LinkCheckOptions,
        showHelp: showHelp.value,
      };
    default:
      throw new Error(`Unknown command: ${commandName}`);
  }
}

function applyScrapeTargetFromPositional(
  opts: CliOptions,
  positionalArgs: string[],
  showHelpRef: { value: boolean }
): void {
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
    if (!showHelpRef.value) {
      showHelpRef.value = true;
    }
    return;
  }

  const [first, ...rest] = positionalArgs;
  if (typeof first !== "string") {
    if (!showHelpRef.value) {
      showHelpRef.value = true;
    }
    return;
  }
  const normalized = first.toLowerCase();

  if (isTargetKeyword(normalized)) {
    const target = rest[0];
    if (!target) {
      // If target keyword provided but no value, show help instead of erroring
      showHelpRef.value = true;
      return;
    }
    setTargetValue(normalized, target);
    warnExtraArgs(rest.slice(1));
    return;
  }

  const errorMessage = `"${first}" is not a valid URL. Provide a start URL, "url <url>", or "urls <file>"`;
  opts.crawlStart = ensureValidUrl(first, errorMessage);
  warnExtraArgs(rest);
}

// ============================================================================
// LEGACY HELP FUNCTIONS (for backward compatibility)
// ============================================================================

export function printCrawlHelp(): void {
  printCommandHelp("crawl");
}

export function printScrapeHelp(): void {
  printCommandHelp("scrape");
}

export function printFindHelp(): void {
  printCommandHelp("find");
}

export function printLinkCheckHelp(): void {
  printCommandHelp("link-check");
}

export function printInstallPlaywrightHelp(): void {
  const lines = [
    "Usage:",
    "  docminer install-playwright [options] [browser...]",
    "",
    "Install Playwright browsers for headless rendering.",
    "",
    "Options:",
    "  -h, --help               Show this help",
    "",
    "Examples:",
    "  docminer install-playwright",
    "  docminer install-playwright chromium",
  ];
  console.info(lines.join("\n"));
}
