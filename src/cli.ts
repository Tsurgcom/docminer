#!/usr/bin/env node
import { parseArgs, printHelp } from "./args";
import { runCliFlow } from "./scraper";

const argv = process.argv.slice(2);

export async function main(): Promise<void> {
  try {
    const { options, showHelp } = parseArgs(argv);
    if (showHelp) {
      printHelp();
      return;
    }
    await runCliFlow(options);
  } catch (error) {
    printHelp();
    console.error(String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
