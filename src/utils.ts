import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { BLOCKED_EXTENSIONS_REGEX } from "./constants";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function parsePositiveInt(
  raw: string | undefined,
  fallback: number
): number {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeSegment(segment: string): string {
  const clean = segment.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  return clean.length > 0 ? clean.toLowerCase() : "index";
}

export function toSnakeDomain(hostname: string): string {
  return sanitizeSegment(hostname);
}

export function buildOutputPaths(
  targetUrl: string,
  outDir: string
): {
  dir: string;
  pagePath: string;
  clutterPath: string;
  llmsPath: string;
  llmsFullPath: string;
} {
  const parsed = new URL(targetUrl);
  const domainPart = toSnakeDomain(parsed.hostname);
  const pathSegments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map(sanitizeSegment);
  const finalSegments = pathSegments.length > 0 ? pathSegments : ["root"];
  const dir = path.join(outDir, domainPart, ...finalSegments);
  return {
    dir,
    pagePath: path.join(dir, "page.md"),
    clutterPath: path.join(dir, "clutter.md"),
    llmsPath: path.join(dir, ".llms.md"),
    llmsFullPath: path.join(dir, "llms-full.md"),
  };
}

export function normalizeForQueue(target: URL): string {
  const clone = new URL(target.toString());
  clone.hash = "";
  clone.search = "";
  return clone.toString();
}

export function isHtmlCandidate(url: URL): boolean {
  return !BLOCKED_EXTENSIONS_REGEX.test(url.pathname);
}

export function isPathInScope(pathname: string, scopePath: string): boolean {
  if (scopePath === "/") {
    return true;
  }
  const bareScope = scopePath.endsWith("/")
    ? scopePath.slice(0, -1) || "/"
    : scopePath;
  const normalizedScope = bareScope === "/" ? "/" : `${bareScope}/`;
  return (
    pathname === bareScope ||
    pathname === normalizedScope ||
    pathname.startsWith(normalizedScope)
  );
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
