#!/usr/bin/env node
import { parseArgs, printHelp } from "./args";
import { logger } from "./logger";
import { runCliFlow } from "./scraper";

const argv = process.argv.slice(2);

export async function main(): Promise<void> {
  try {
    const { options, showHelp } = parseArgs(argv);

    // Configure logger with verbose and progress settings
    logger.configure({
      verbose: options.verbose,
      showProgress: options.progress,
    });

    if (showHelp) {
      printHelp();
      return;
    }

    await runCliFlow(options);
  } catch (error) {
    printHelp();
    logger.error(String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
