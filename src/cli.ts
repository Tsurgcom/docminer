#!/usr/bin/env node
import { parseArgs, printFindHelp, printHelp, printScrapeHelp } from "./args";
import { runFindCommand } from "./find";
import { logger } from "./logger";
import { runCliFlow } from "./scraper";

const argv = process.argv.slice(2);

export async function main(): Promise<void> {
  try {
    const result = parseArgs(argv);

    if (result.command === "find") {
      if (result.showHelp) {
        printFindHelp();
        return;
      }
      await runFindCommand(result.options);
      return;
    }

    // Scrape command
    if (result.showHelp) {
      // Show general help if no target was provided, scrape help if --help was explicit
      const hasExplicitHelpFlag = argv.some(
        (arg) => arg === "-h" || arg === "--help"
      );
      if (hasExplicitHelpFlag) {
        printScrapeHelp();
      } else {
        printHelp();
      }
      return;
    }

    // Configure logger with verbose and progress settings for scrape commands
    logger.configure({
      verbose: result.options.verbose,
      showProgress: result.options.progress,
    });

    await runCliFlow(result.options);
  } catch (error) {
    printHelp();
    logger.error(String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
