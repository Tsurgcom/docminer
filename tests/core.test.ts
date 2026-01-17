import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args";
import { DEFAULT_OPTIONS } from "../src/constants";
import {
  extractLinks,
  normalizeHrefTarget,
  rewriteLinksInMarkdown,
} from "../src/links";
import { parseRobotsTxt } from "../src/robots";
import {
  buildOutputPaths,
  isHtmlCandidate,
  isPathInScope,
  normalizeForQueue,
  parsePositiveInt,
  sanitizeSegment,
} from "../src/utils";

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
    const { options, showHelp } = parseArgs(["https://example.com"]);
    expect(showHelp).toBe(false);
    expect(options.crawlStart).toBe("https://example.com");
  });

  test("accepts explicit url target keyword", () => {
    const { options, showHelp } = parseArgs(["url", "https://example.com"]);
    expect(showHelp).toBe(false);
    expect(options.url).toBe("https://example.com");
    expect(options.crawlStart).toBeUndefined();
  });

  test("accepts explicit urls file target keyword", () => {
    const { options, showHelp } = parseArgs(["urls", "./urls.txt"]);
    expect(showHelp).toBe(false);
    expect(options.urlsFile).toBe("./urls.txt");
    expect(options.crawlStart).toBeUndefined();
  });

  test("returns help when no targets are provided", () => {
    const { showHelp, options } = parseArgs([]);
    expect(showHelp).toBe(true);
    expect(options.url).toBeUndefined();
    expect(options.urlsFile).toBeUndefined();
    expect(options.crawlStart).toBeUndefined();
  });

  test("returns help flag when --help is provided", () => {
    const { showHelp } = parseArgs(["--help"]);
    expect(showHelp).toBe(true);
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

  test("normalize rule helper always prefixes slash", () => {
    const robots = "User-agent: *\nDisallow: private";
    const policy = parseRobotsTxt(robots, DEFAULT_OPTIONS.userAgent);
    expect(policy.isAllowed("/private")).toBe(false);
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

  test("extractLinks respects scope and blocked extensions", () => {
    const html =
      '<a href="/in-scope/page">in</a><a href="https://other.com">out</a><a href="/skip.png">img</a>';
    const links = extractLinks(
      html,
      new URL("https://example.com/root/index"),
      "https://example.com",
      "/"
    );
    expect(links).toEqual(["https://example.com/in-scope/page"]);
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
});
