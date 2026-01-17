import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  fuzzyMatch,
  highlightMatch,
  highlightSubstring,
  substringMatch,
} from "./fuzzy";
import type { ContentMatch, FindOptions, FindResult } from "./types";

const MD_EXTENSION = ".md";
const CLUTTER_SUFFIX = ".clutter.md";

/**
 * Recursively collects all markdown files in a directory, excluding .clutter.md files.
 */
export async function findFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(MD_EXTENSION) &&
        !entry.name.endsWith(CLUTTER_SUFFIX)
      ) {
        files.push(fullPath);
      }
    }
  }

  await walk(directory);
  return files;
}

/**
 * Searches file paths for fuzzy matches.
 */
export function searchPaths(
  files: string[],
  query: string,
  baseDir: string
): FindResult[] {
  const results: FindResult[] = [];

  for (const file of files) {
    const relativePath = path.relative(baseDir, file);
    const match = fuzzyMatch(query, relativePath);

    if (match) {
      results.push({
        filePath: file,
        relativePath,
        score: match.score,
        matchType: "path",
        pathIndices: match.indices,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Searches file content for matches (uses substring matching for content).
 */
export async function searchContent(
  files: string[],
  query: string,
  baseDir: string,
  contextLines: number
): Promise<FindResult[]> {
  const results: FindResult[] = [];

  for (const file of files) {
    let content: string;

    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const matches: ContentMatch[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = substringMatch(query, line);

      if (match) {
        const startLine = Math.max(0, i - contextLines);
        const endLine = Math.min(lines.length - 1, i + contextLines);

        matches.push({
          lineNumber: i + 1, // 1-indexed
          line,
          matchIndex: match.index,
          matchLength: match.length,
          contextBefore: lines.slice(startLine, i),
          contextAfter: lines.slice(i + 1, endLine + 1),
        });
      }
    }

    if (matches.length > 0) {
      const relativePath = path.relative(baseDir, file);
      // Score based on number of matches and query coverage
      const score = matches.length * 10 + query.length;

      results.push({
        filePath: file,
        relativePath,
        score,
        matchType: "content",
        contentMatches: matches,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Formats a single result for terminal output.
 */
function formatResult(result: FindResult, useColor: boolean): string {
  const lines: string[] = [];

  const DIM = useColor ? "\x1b[2m" : "";
  const CYAN = useColor ? "\x1b[36m" : "";
  const RESET = useColor ? "\x1b[0m" : "";

  if (result.matchType === "path") {
    const displayPath = result.pathIndices
      ? highlightMatch(result.relativePath, result.pathIndices)
      : result.relativePath;
    lines.push(`${CYAN}${displayPath}${RESET}`);
  } else if (result.matchType === "content" && result.contentMatches) {
    lines.push(`${CYAN}${result.relativePath}${RESET}`);

    for (const match of result.contentMatches) {
      // Show context before
      for (let i = 0; i < match.contextBefore.length; i++) {
        const contextLineNum =
          match.lineNumber - match.contextBefore.length + i;
        lines.push(
          `${DIM}  ${contextLineNum}: ${match.contextBefore[i]}${RESET}`
        );
      }

      // Show matching line with highlight
      const highlightedLine = useColor
        ? highlightSubstring(match.line, match.matchIndex, match.matchLength)
        : match.line;
      lines.push(`  ${match.lineNumber}: ${highlightedLine}`);

      // Show context after
      for (let i = 0; i < match.contextAfter.length; i++) {
        const contextLineNum = match.lineNumber + 1 + i;
        lines.push(
          `${DIM}  ${contextLineNum}: ${match.contextAfter[i]}${RESET}`
        );
      }

      lines.push(""); // Empty line between matches
    }
  }

  return lines.join("\n");
}

/**
 * Formats all results for terminal output.
 */
export function formatResults(
  results: FindResult[],
  options: { useColor?: boolean } = {}
): string {
  const useColor = options.useColor ?? process.stdout.isTTY ?? false;

  if (results.length === 0) {
    return "No matches found.";
  }

  const formatted = results.map((r) => formatResult(r, useColor));
  return formatted.join("\n");
}

/**
 * Main entry point for the find command.
 */
export async function runFindCommand(options: FindOptions): Promise<void> {
  const { query, directory, filesOnly, contentOnly, limit, contextLines } =
    options;

  // Check if directory exists
  try {
    const stats = await stat(directory);
    if (!stats.isDirectory()) {
      console.error(`Error: "${directory}" is not a directory`);
      process.exitCode = 1;
      return;
    }
  } catch {
    console.error(`Error: Directory "${directory}" does not exist`);
    process.exitCode = 1;
    return;
  }

  // Collect all markdown files
  const files = await findFiles(directory);

  if (files.length === 0) {
    console.log(`No markdown files found in "${directory}"`);
    return;
  }

  const allResults: FindResult[] = [];

  // Search file paths (unless content-only)
  if (!contentOnly) {
    const pathResults = searchPaths(files, query, directory);
    allResults.push(...pathResults);
  }

  // Search content (unless files-only)
  if (!filesOnly) {
    const contentResults = await searchContent(
      files,
      query,
      directory,
      contextLines
    );
    allResults.push(...contentResults);
  }

  // Sort by score and limit results
  allResults.sort((a, b) => b.score - a.score);
  const limitedResults = allResults.slice(0, limit);

  // Format and print results
  const output = formatResults(limitedResults);
  console.log(output);
}
