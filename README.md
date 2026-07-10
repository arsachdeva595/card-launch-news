# Card Launch News

Tracks newly launched credit cards from Indian banks. Detection works by
diffing each issuer's XML sitemap week over week — a new sitemap entry that
looks like a card product page is treated as a launch signal. Each candidate
is then enriched with a public announcement link and community discussion
(Reddit / X / YouTube) found via web search.

## How it works

1. **`scripts/crawl.mjs`** fetches every issuer's sitemap (see
   `config/issuers.json`), compares it against the last-seen snapshot in
   `data/sitemap-snapshots/`, and emits new URLs that match card-like path
   patterns (`config/settings.json` → `candidatePatterns`).
2. **`scripts/enrich.mjs`** takes each candidate, fetches its page `<title>`
   to derive a card name, then queries the [Brave Search
   API](https://brave.com/search/api/) for an announcement post plus
   Reddit/X/YouTube mentions.
3. **`scripts/run.mjs`** orchestrates both steps, merges results into
   `docs/data/launches.json`, and writes `docs/data/meta.json`.
4. **`docs/`** is a static, dependency-free site (plain HTML/CSS/JS) that
   reads those two JSON files and renders the tile feed + detail view. It's
   served directly by GitHub Pages — no build step.
5. **`.github/workflows/runner.yml`** runs the pipeline on a daily cron, but
   `scripts/run.mjs` only actually does work once `frequencyDays` (in
   `config/settings.json`) has elapsed since the last run. Trigger a run
   immediately (bypassing the frequency gate) from the Actions tab via
   "Run workflow" with the `force` input checked.

## One-time setup

1. **Brave Search API key** — sign up at
   [brave.com/search/api](https://brave.com/search/api/) (free tier: 2,000
   queries/month), then add it as a repo secret:
   `Settings → Secrets and variables → Actions → New repository secret` named
   `BRAVE_API_KEY`.
2. **Enable GitHub Pages** — `Settings → Pages → Source: Deploy from a
   branch → Branch: main, folder: /docs`.
3. First run will be a baseline pass per issuer (no candidates are emitted
   the very first time an issuer's sitemap is seen, since there's nothing to
   diff against yet) — expect the feed to start filling in from the *second*
   run onward, once a snapshot exists to compare against.

## Changing the check frequency

Edit `frequencyDays` in `config/settings.json` (default: `7`) and commit. No
workflow YAML changes needed — the cron always fires daily, the script
itself decides whether enough time has passed.

## Adding/removing issuers

Edit `config/issuers.json`. Each entry needs `slug`, `name`, `officialUrl`,
and `sitemapUrl`. Sitemap index files (`<sitemapindex>`) are followed
automatically, so you can point `sitemapUrl` at either a sitemap index or a
plain urlset.

## Local testing

```bash
npm run run          # runs only if due per frequencyDays
npm run run:force     # runs regardless (useful for local testing)
```

Requires `BRAVE_API_KEY` to be set in your shell environment to get real
enrichment results; without it, searches are skipped and card entries are
still created with `announcement`/`community` left `null`.

## Known limitations (v1)

- Enrichment picks the *first* search result per query — it's a best-effort
  signal, not a verified/deduplicated source. Treat "announcement" and
  "community sentiment" as leads to click through, not ground truth.
- Candidate filtering (`config/settings.json` → `candidatePatterns`) is a
  simple substring match on the URL path. Issuers with unusual URL
  structures may need custom include/exclude patterns tuned over time.
- No de-duplication across issuers if two banks publish near-identical URL
  slugs for unrelated cards — `id` is scoped per-issuer so this is unlikely
  but not impossible.
