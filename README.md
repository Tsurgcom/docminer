# docminer

Documentation scraper powered by Bun.
> ⚠️ **Important: Run docminer with the [Bun runtime](https://bun.com/)! Node.js is not supported.**
> It takes **1** line to install.

## Install

```bash
bun i -g docminer
```

## Usage

Default crawl a site (stays within the starting path):

```bash
bunx docminer https://bun.com/docs
```
Tada!


Scrape a single page:

```bash
bun run index.ts url https://bun.com/docs/installation
```

Scrape from a list (one URL per line, `#` for comments):

```bash
bun run index.ts urls urls.txt --concurrency 4
```
(You can also do `-c 4`)

The crawler respects `robots.txt` and applies crawl-delay values unless you pass `--no-robots`.

Outputs go to `.docs/<snake_domain>/<path>/page.md` with clutter saved to `.clutter.md` when you pass `--clutter`. Existing `.llms.md` and `llms-full.md` are left untouched unless you pass `--overwrite-llms`.

When a `.md` version of a URL is available (for example, `https://example.com/docs.md` for `https://example.com/docs/`), docminer will prefer it and skip headless rendering.

Common flags:

- `--outDir <path>` (default `.docs`)
- `--concurrency <n>` (default 4)
- `--timeout <ms>` (default 15000)
- `--retries <n>` (default 2)
- `--userAgent <string>`
- `--verbose`
- `--overwrite-llms`
- `--maxDepth <n>` (default 3) and `--maxPages <n>` (default 200) to bound crawl size
- `--delay <ms>` (default 500) minimum delay between requests
- `--no-robots` to bypass robots.txt (respected by default)

Targets can be passed as positional commands (`crawl`, `url`, `urls`) or via legacy flags (`--crawl`, `--url`, `--urls`). `crawl` is the default when you provide only a URL.
