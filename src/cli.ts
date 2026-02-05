#!/usr/bin/env node
import {
  parseArgs,
  printCrawlHelp,
  printFindHelp,
  printHelp,
  printLinkCheckHelp,
  printScrapeHelp,
} from "./args";
import { runFindCommand } from "./find";
import { runLinkCheckCommand } from "./link-check";
import { logger } from "./logger";
import { packageVersion } from "./package-info";
import { isMainModule } from "./runtime";
import { runCliFlow } from "./scraper";

const argv = process.argv.slice(2);

export async function main(): Promise<void> {
  try {
    const result = parseArgs(argv);

    if (result.command === "version") {
      console.log(packageVersion);
      return;
    }

    if (result.command === "find") {
      if (result.showHelp) {
        printFindHelp();
        return;
      }
      await runFindCommand(result.options);
      return;
    }

    if (result.command === "link-check") {
      if (result.showHelp) {
        printLinkCheckHelp();
        return;
      }
      logger.configure({
        verbose: result.options.verbose,
        showProgress: false,
      });
      await runLinkCheckCommand(result.options);
      return;
    }

    if (result.command === "crawl") {
      if (result.showHelp) {
        printCrawlHelp();
        return;
      }
      logger.configure({
        verbose: result.options.verbose,
        showProgress: result.options.progress,
      });
      await runCliFlow(result.options);
      return;
    }

    // Scrape command (url/urls)
    if (result.showHelp) {
      // Show scrape help only if a target was provided, otherwise show general help
      const hasTarget =
        result.options.url ||
        result.options.urlsFile ||
        result.options.crawlStart;
      if (hasTarget) {
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

if (isMainModule(import.meta.url)) {
  main();
}
