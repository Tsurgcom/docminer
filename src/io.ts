import { readFile, writeFile } from "node:fs/promises";
import { LINE_SPLIT_REGEX } from "./constants";
import { logger } from "./logger";
import type { CliOptions, ScrapeResult } from "./types";
import { buildOutputPaths, ensureDir, fileExists } from "./utils";

export async function writeOutputs(
  targetUrl: string,
  options: CliOptions,
  result: ScrapeResult
): Promise<void> {
  const { dir, pagePath, clutterPath, llmsPath, llmsFullPath } =
    buildOutputPaths(targetUrl, options.outDir);
  await ensureDir(dir);

  await writeFile(pagePath, result.markdown, "utf8");
  if (options.clutter && result.clutterMarkdown) {
    await writeFile(clutterPath, result.clutterMarkdown, "utf8");
  }

  if (options.overwriteLlms) {
    await writeFile(llmsPath, result.llmsMarkdown, "utf8");
    await writeFile(llmsFullPath, result.llmsFullMarkdown, "utf8");
  } else {
    const llmsExists = await fileExists(llmsPath);
    const llmsFullExists = await fileExists(llmsFullPath);
    if (llmsExists || llmsFullExists) {
      logger.logSkipped(`llms files already exist in ${dir}`);
    }
  }
}

export async function loadUrls(opts: CliOptions): Promise<string[]> {
  const urls: string[] = [];

  if (opts.url) {
    urls.push(opts.url);
  }

  if (opts.urlsFile) {
    const content = await readFile(opts.urlsFile, "utf8");
    const lines = content
      .split(LINE_SPLIT_REGEX)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    urls.push(...lines);
  }

  const unique = Array.from(new Set(urls));
  if (unique.length === 0) {
    throw new Error("No URLs provided to scrape");
  }
  return unique;
}
