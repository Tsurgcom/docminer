import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/args";
import { DEFAULT_OPTIONS, turndownService } from "../src/constants";
import { extractMarkdownContent } from "../src/content";
import { runLinkCheckCommand } from "../src/link-check";
import {
  extractLinks,
  extractLinksFromMarkdown,
  normalizeHrefTarget,
  rewriteLinksInMarkdown,
  rewriteMarkdownContent,
} from "../src/links";
import { buildMarkdownCandidateUrl } from "../src/network";
import { parseRobotsTxt } from "../src/robots";
import {
  buildOutputPaths,
  ensureDir,
  isHtmlCandidate,
  isPathInScope,
  normalizeForQueue,
  parsePositiveInt,
  sanitizeSegment,
} from "../src/utils";

const HEADING_REGEX = /^#\s+/gm;
const LLMS_LABEL_REGEX = /\[https:\/\/bun\.com\/docs\/llms\.txt\]/g;
const TABLE_HEADER_REGEX = /\|\s*Col\s*\|/;
const TABLE_SEPARATOR_REGEX = /\|\s*-+\s*\|/;
const TABLE_VALUE_REGEX = /\|\s*Val\s*\|/;

const ensureScrape = (
  result: ReturnType<typeof parseArgs>
): Extract<ReturnType<typeof parseArgs>, { command: "scrape" }> => {
  if (result.command !== "scrape") {
    throw new Error(`Expected scrape command, got ${result.command}`);
  }
  return result;
};

describe("utility helpers", () => {
  test("parsePositiveInt falls back on invalid input", () => {
    expect(parsePositiveInt(undefined, 3)).toBe(3);
    expect(parsePositiveInt("abc", 4)).toBe(4);
    expect(parsePositiveInt("10", 1)).toBe(10);
  });

  test("sanitizeSegment cleans and normalizes strings", () => {
    expect(sanitizeSegment("Hello World!")).toBe("hello_world");
    expect(sanitizeSegment("###")).toBe("index");
  });

  test("buildOutputPaths creates deterministic paths", () => {
    const paths = buildOutputPaths(
      "https://example.com/docs/get-started",
      ".docs"
    );
    expect(
      paths.pagePath.endsWith("example_com/docs/get_started/page.md")
    ).toBe(true);
    expect(paths.llmsPath.endsWith(".llms.md")).toBe(true);
  });

  test("normalizeForQueue removes hash and search", () => {
    const normalized = normalizeForQueue(
      new URL("https://example.com/page?x=1#section")
    );
    expect(normalized).toBe("https://example.com/page");
  });

  test("isHtmlCandidate filters blocked extensions", () => {
    expect(isHtmlCandidate(new URL("https://example.com/image.png"))).toBe(
      false
    );
    expect(isHtmlCandidate(new URL("https://example.com/app.js"))).toBe(false);
    expect(isHtmlCandidate(new URL("https://example.com/styles.css"))).toBe(
      false
    );
    expect(isHtmlCandidate(new URL("https://example.com/about"))).toBe(true);
  });

  test("isPathInScope respects trailing slashes", () => {
    expect(isPathInScope("/docs/guide", "/docs")).toBe(true);
    expect(isPathInScope("/blog/post", "/docs")).toBe(false);
    expect(isPathInScope("/docs", "/docs")).toBe(true);
  });
});

describe("argument parsing", () => {
  test("defaults to crawl when a single positional URL is provided", () => {
    const { options, showHelp } = ensureScrape(
      parseArgs(["https://example.com"])
    );
    expect(showHelp).toBe(false);
    expect(options.crawlStart).toBe("https://example.com");
  });

  test("accepts explicit url target keyword", () => {
    const { options, showHelp } = ensureScrape(
      parseArgs(["url", "https://example.com"])
    );
    expect(showHelp).toBe(false);
    expect(options.url).toBe("https://example.com");
    expect(options.crawlStart).toBeUndefined();
  });

  test("accepts explicit urls file target keyword", () => {
    const { options, showHelp } = ensureScrape(
      parseArgs(["urls", "./urls.txt"])
    );
    expect(showHelp).toBe(false);
    expect(options.urlsFile).toBe("./urls.txt");
    expect(options.crawlStart).toBeUndefined();
  });

  test("returns help when no targets are provided", () => {
    const { showHelp, options } = ensureScrape(parseArgs([]));
    expect(showHelp).toBe(true);
    expect(options.url).toBeUndefined();
    expect(options.urlsFile).toBeUndefined();
    expect(options.crawlStart).toBeUndefined();
  });

  test("returns help when target keyword provided without value", () => {
    const { showHelp, options } = ensureScrape(parseArgs(["url"]));
    expect(showHelp).toBe(true);
    expect(options.url).toBeUndefined();
    expect(options.urlsFile).toBeUndefined();
    expect(options.crawlStart).toBeUndefined();
  });

  test("returns help flag when --help is provided", () => {
    const result = parseArgs(["--help"]);
    expect(result.command).toBe("scrape");
    if (result.command === "scrape") {
      expect(result.showHelp).toBe(true);
    }
  });

  test("supports clutter toggle flags", () => {
    const crawlResult = parseArgs([
      "crawl",
      "https://example.com",
      "--clutter",
    ]);
    expect(crawlResult.command).toBe("crawl");
    if (crawlResult.command === "crawl") {
      expect(crawlResult.options.clutter).toBe(true);
    }

    const scrapeResult = parseArgs(["https://example.com", "--no-clutter"]);
    expect(scrapeResult.command).toBe("scrape");
    if (scrapeResult.command === "scrape") {
      expect(scrapeResult.options.clutter).toBe(false);
    }
  });

  test("parses link-check options", () => {
    const result = parseArgs(["link-check", "-o", "./docs", "--verbose"]);
    expect(result.command).toBe("link-check");
    if (result.command === "link-check") {
      expect(result.options.directory).toBe("./docs");
      expect(result.options.verbose).toBe(true);
    }
  });
});

describe("robots parsing", () => {
  test("parseRobotsTxt applies longest match precedence", () => {
    const robots = `
User-agent: *
Disallow: /private
Allow: /private/docs
Crawl-delay: 2
`.trim();
    const policy = parseRobotsTxt(robots, DEFAULT_OPTIONS.userAgent);
    expect(policy.isAllowed("/private/docs/readme")).toBe(true);
    expect(policy.isAllowed("/private/other")).toBe(false);
    expect(policy.crawlDelayMs).toBe(2000);
  });

  test("allows all paths when Disallow is empty", () => {
    const robots = `
User-agent: *
Disallow: 
`.trim();
    const policy = parseRobotsTxt(robots, DEFAULT_OPTIONS.userAgent);
    expect(policy.isAllowed("/")).toBe(true);
    expect(policy.isAllowed("/other")).toBe(true);
    expect(policy.crawlDelayMs).toBeUndefined();
  });

  test("normalize rule helper always prefixes slash", () => {
    const robots = "User-agent: *\nDisallow: private";
    const policy = parseRobotsTxt(robots, DEFAULT_OPTIONS.userAgent);
    expect(policy.isAllowed("/private")).toBe(false);
  });
});

describe("markdown sources", () => {
  test("buildMarkdownCandidateUrl prefers llms.txt for roots", () => {
    expect(buildMarkdownCandidateUrl("https://bun.com/")).toBe(
      "https://bun.com/llms.txt"
    );
    expect(buildMarkdownCandidateUrl("https://bun.com")).toBe(
      "https://bun.com/llms.txt"
    );
  });

  test("buildMarkdownCandidateUrl appends .md when missing", () => {
    expect(buildMarkdownCandidateUrl("https://bun.com/docs")).toBe(
      "https://bun.com/docs.md"
    );
    expect(buildMarkdownCandidateUrl("https://bun.com/docs/")).toBe(
      "https://bun.com/docs.md"
    );
    expect(buildMarkdownCandidateUrl("https://bun.com/docs/readme.md")).toBe(
      "https://bun.com/docs/readme.md"
    );
    expect(buildMarkdownCandidateUrl("https://bun.com/docs/llms.txt")).toBe(
      "https://bun.com/docs/llms.txt"
    );
  });

  test("extractMarkdownContent avoids duplicate headings", () => {
    const result = extractMarkdownContent(
      "# Title\n\nBody",
      "https://example.com/docs"
    );
    const headings = result.markdown.match(HEADING_REGEX) ?? [];
    expect(headings.length).toBe(1);
    expect(result.markdown).toContain("# Title");
  });

  test("extractMarkdownContent adds title when missing", () => {
    const result = extractMarkdownContent(
      "Body only",
      "https://example.com/docs"
    );
    expect(result.markdown).toContain("# https://example.com/docs");
    expect(result.markdown).toContain("Body only");
  });
});

describe("link utilities", () => {
  test("normalizeHrefTarget ignores unsupported protocols", () => {
    expect(
      normalizeHrefTarget("mailto:test@example.com", "https://example.com")
    ).toBeNull();
    expect(
      normalizeHrefTarget("/docs", "https://example.com")?.toString()
    ).toBe("https://example.com/docs");
  });

  test("normalizeHrefTarget drops anchors for queueing", () => {
    expect(
      normalizeHrefTarget(
        "https://example.com/docs/page#section",
        "https://example.com"
      )?.toString()
    ).toBe("https://example.com/docs/page");
  });

  test("extractLinks respects scope and blocked extensions", () => {
    const html =
      '<a href="/in-scope/page">in</a><a href="https://other.com">out</a><a href="/skip.png">img</a><a href="/app.js">js</a>';
    const links = extractLinks(
      html,
      new URL("https://example.com/root/index"),
      "https://example.com",
      "/"
    );
    expect(links).toEqual(["https://example.com/in-scope/page"]);
  });

  test("extractLinksFromMarkdown resolves scoped href attributes", () => {
    const markdown = '<Card href="/runtime">Runtime</Card>';
    const links = extractLinksFromMarkdown(
      markdown,
      new URL("https://bun.com/docs"),
      "https://bun.com",
      "/docs"
    );
    expect(links).toEqual(["https://bun.com/docs/runtime"]);
  });

  test("extractLinksFromMarkdown strips hashes from links", () => {
    const markdown = "[Section](https://example.com/docs/page#anchor)";
    const links = extractLinksFromMarkdown(
      markdown,
      new URL("https://example.com/docs"),
      "https://example.com",
      "/docs"
    );
    expect(links).toEqual(["https://example.com/docs/page"]);
  });

  test("rewriteLinksInMarkdown rewrites known links to relative paths", async () => {
    const options = { ...DEFAULT_OPTIONS, outDir: "out" };
    const knownUrls = new Set<string>([
      normalizeForQueue(new URL("https://example.com/docs/intro/overview")),
    ]);
    const markdown = "[Doc](https://example.com/docs/intro/overview)";
    const rewritten = await rewriteLinksInMarkdown(
      markdown,
      "https://example.com/docs/intro",
      options,
      knownUrls
    );
    expect(rewritten).toBe("[Doc](overview/page.md)");
  });

  test("rewriteMarkdownContent preserves anchors and avoids nested links", async () => {
    const options = { ...DEFAULT_OPTIONS, outDir: "out" };
    const knownUrls = new Set<string>([
      normalizeForQueue(new URL("https://bun.com/docs/llms.txt")),
    ]);
    const markdown = [
      "---",
      "Source: https://bun.com/docs/test/index",
      "Fetched: 2026-01-18T12:00:00.000Z",
      "---",
      "",
      "> To find navigation and other pages, fetch https://bun.com/docs/llms.txt",
      "",
      "[Section](https://bun.com/docs/llms.txt#nav)",
    ].join("\n");

    const rewritten = await rewriteMarkdownContent(
      markdown,
      "https://bun.com/docs/test/index",
      options,
      knownUrls,
      undefined,
      undefined,
      "/docs"
    );

    expect(rewritten).toContain(
      "[https://bun.com/docs/llms.txt](../../llms_txt/page.md)"
    );
    expect(rewritten).toContain("[Section](../../llms_txt/page.md#nav)");
    expect(rewritten).not.toContain("[[[[");
  });

  test("rewriteMarkdownContent keeps Source metadata plain", async () => {
    const options = { ...DEFAULT_OPTIONS, outDir: "out" };
    const markdown = [
      "---",
      "Source: [https://bun.com/docs/index](page.md)",
      "Fetched: 2026-01-18T12:00:00.000Z",
      "---",
      "",
      "Body",
    ].join("\n");

    const rewritten = await rewriteMarkdownContent(
      markdown,
      "https://bun.com/docs/index",
      options,
      new Set<string>()
    );

    expect(rewritten).toContain("Source: https://bun.com/docs/index");
    expect(rewritten).toContain("Body");
    expect(rewritten).not.toContain("Source: [");
  });

  test("rewriteMarkdownContent marks external links and removes marker when linked", async () => {
    const options = { ...DEFAULT_OPTIONS, outDir: "out" };
    const externalMarkdown = "[External](https://other.com/page)";
    const externalRewritten = await rewriteMarkdownContent(
      externalMarkdown,
      "https://bun.com/docs",
      options,
      new Set<string>()
    );
    expect(externalRewritten).toBe("[External ↗](https://other.com/page)");

    const knownUrls = new Set<string>([
      normalizeForQueue(new URL("https://two.com/guide")),
    ]);
    const linkedMarkdown = "[Guide ↗](https://two.com/guide)";
    const linkedRewritten = await rewriteMarkdownContent(
      linkedMarkdown,
      "https://one.com/docs/page",
      options,
      knownUrls
    );
    expect(linkedRewritten).toContain("[Guide](");
    expect(linkedRewritten).not.toContain("↗");
    expect(linkedRewritten).toContain("two_com/guide/page.md");
  });

  test("rewriteMarkdownContent does not re-link already linked URLs", async () => {
    const options = { ...DEFAULT_OPTIONS, outDir: "out" };
    const markdown = [
      "---",
      "Source: https://bun.com/docs/test/index",
      "Fetched: 2026-01-18T12:00:00.000Z",
      "---",
      "",
      "> [https://bun.com/docs/llms.txt](../../llms_txt/page.md)",
    ].join("\n");
    const knownUrls = new Set<string>([
      normalizeForQueue(new URL("https://bun.com/docs/llms.txt")),
    ]);
    const rewritten = await rewriteMarkdownContent(
      markdown,
      "https://bun.com/docs/test/index",
      options,
      knownUrls
    );
    expect(rewritten.match(LLMS_LABEL_REGEX)?.length).toBe(1);
    expect(rewritten).not.toContain("[[[");
  });
});

describe("link-check command", () => {
  test("re-links cross-domain docs and removes external markers", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "docminer-linkcheck-")
    );
    try {
      const firstUrl = "https://one.example.com/docs/page";
      const secondUrl = "https://two.example.com/guide";
      const firstPaths = buildOutputPaths(firstUrl, tempDir);
      const secondPaths = buildOutputPaths(secondUrl, tempDir);

      await ensureDir(firstPaths.dir);
      await ensureDir(secondPaths.dir);

      const firstContent = [
        "---",
        `Source: ${firstUrl}`,
        "Fetched: 2026-01-18T12:00:00.000Z",
        "---",
        "",
        `[Other ↗](${secondUrl})`,
      ].join("\n");

      const secondContent = [
        "---",
        `Source: ${secondUrl}`,
        "Fetched: 2026-01-18T12:00:00.000Z",
        "---",
        "",
        "Body",
      ].join("\n");

      await writeFile(firstPaths.pagePath, firstContent, "utf8");
      await writeFile(secondPaths.pagePath, secondContent, "utf8");

      await runLinkCheckCommand({ directory: tempDir, verbose: false });

      const updated = await readFile(firstPaths.pagePath, "utf8");
      expect(updated).toContain("[Other](");
      expect(updated).not.toContain("↗");
      expect(updated).toContain("two_example_com/guide/page.md");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("turndown formatting", () => {
  test("collapses multiline anchor text into a single line", () => {
    const markdown = turndownService.turndown(
      '<a href="https://example.com">First line<br>Second line</a>'
    );
    expect(markdown).toBe("[First line Second line](https://example.com)");
  });

  test("promotes nested headings inside links to the topmost level", () => {
    const markdown = turndownService.turndown(
      '<a href="https://example.com"><h2>Sub</h2><h1>Main</h1></a>'
    );
    expect(markdown).toBe("# [Sub Main](https://example.com)");
  });

  test("converts tables to markdown", () => {
    const markdown = turndownService.turndown(
      "<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Val</td></tr></tbody></table>"
    );
    expect(markdown).toMatch(TABLE_HEADER_REGEX);
    expect(markdown).toMatch(TABLE_SEPARATOR_REGEX);
    expect(markdown).toMatch(TABLE_VALUE_REGEX);
  });
});
