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

Outputs go to `.docs/<snake_domain>/<path>/page.md` with clutter saved to `clutter.md`. Existing `.llms.md` and `llms-full.md` are left untouched unless you pass `--overwrite-llms`.

Common flags:

- `--outDir <path>` (default `.docs`)
- `--concurrency <n>` (default 4)
- `--timeout <ms>` (default 15000)
- `--retries <n>` (default 2)
- `--userAgent <string>`
- `--verbose`
- `--overwrite-llms`
