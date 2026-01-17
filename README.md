# aidocs

Documentation scraper powered by Bun.

## Install

```bash
bun install
```

## Usage

Scrape a single page:

```bash
bun run index.ts --url https://docs.example.com/path
```

Scrape from a list (one URL per line, `#` for comments):

```bash
bun run index.ts --urls urls.txt --concurrency 4
```

Crawl a documentation site (stays within the starting path):

```bash
bun run index.ts --crawl https://bun.com/docs --maxDepth 3 --maxPages 200 --delay 500
```

The crawler respects `robots.txt` and applies crawl-delay values unless you pass `--no-robots`.

Outputs go to `.docs/<snake_domain>/<path>/page.md` with clutter saved to `clutter.md`. Existing `.llms.md` and `llms-full.md` are left untouched unless you pass `--overwrite-llms`.

Common flags:

- `--outDir <path>` (default `.docs`)
- `--concurrency <n>` (default 4)
- `--timeout <ms>` (default 15000)
- `--retries <n>` (default 2)
- `--userAgent <string>`
- `--verbose`
- `--overwrite-llms`
- `--crawl <url>` to enable crawling mode
- `--maxDepth <n>` (default 3) and `--maxPages <n>` (default 200) to bound crawl size
- `--delay <ms>` (default 500) minimum delay between requests
- `--no-robots` to bypass robots.txt (respected by default)
