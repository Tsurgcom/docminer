# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-18

### Added
- Initial release of docminer
- Documentation scraper powered by Bun
- CLI tool for web scraping with markdown output
- Support for crawling, single URLs, and batch URL processing
- Markdown (.md) file detection and prioritization
- robots.txt parsing and respect
- Configurable crawl depth, concurrency, and timeouts
- Hybrid HTML scraping (headless + static parsing)
- Link extraction and rewriting for offline documentation
- Multiple entry points: CLI, scraper module, and utility functions

### Features
- `crawl` command: Crawl and scrape documentation sites
- `url` command: Scrape single pages
- `urls` command: Batch process URLs from files
- `find` command: Search scraped documentation
- `link-check` command: Re-link saved docs
- Respects `robots.txt` and `crawl-delay` directives
- Prefers `.md` versions of URLs when available
- Output to structured markdown files
- Support for clutter removal and overwrite options
- ANSI colored logging output
- Performance optimized with worker pools

### Technical Details
- Built with Bun for fast bundling and testing
- TypeScript for type safety
- ESM module format
- Source maps for debugging
- Node.js >=18.0.0 compatible
- Dependencies: playwright, jsdom, turndown, @mozilla/readability

[0.1.0]: https://github.com/yourusername/docminer/releases/tag/v0.1.0
