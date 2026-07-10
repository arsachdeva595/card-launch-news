# Card Launch News

Tracks newly launched credit cards from Indian banks, and flags when an
existing card's page changes (fee/benefit/terms updates, discontinuations).

- **New launches**: detected by diffing each issuer's XML sitemap week over
  week — a new sitemap entry that looks like a card product page is treated
  as a launch signal. Each candidate is enriched with a public announcement
  link and community discussion (Reddit / X / YouTube) found via web search.
- **Card changes**: every card-shaped page already known from the sitemap
  crawl gets fetched and content-hashed each run; a hash that differs from
  last run's stored hash means the page's content changed. Enriched with
  Reddit/news discussion of the change (no single "announcement" exists for
  a change the way it does for a launch).
- Optional Telegram notification when either happens.

## How it works

1. **`scripts/crawl.mjs`** fetches every issuer's sitemap (see
   `config/issuers.json`), compares it against the last-seen snapshot in
   `data/sitemap-snapshots/`, and emits new URLs that match card-like path
   patterns (`config/settings.json` → `candidatePatterns`). It also returns
   every currently-live card-matching URL per issuer (new or not), for the
   change-detection step to reuse without a second sitemap fetch.
2. **`scripts/enrich.mjs`** takes each new-launch candidate, fetches its page
   `<title>` to derive a card name, then queries a [Google Programmable
   Search Engine](https://programmablesearchengine.google.com/) for an
   announcement post plus Reddit/X/YouTube mentions.
3. **`scripts/detect-changes.mjs`** fetches every card-matching page via
   `scripts/lib/content-hash.mjs`, which extracts the page's visible text
   (stripping scripts/styles/comments/tags so markup churn doesn't cause
   false positives) and hashes it, comparing against the hash stored in
   `data/page-hashes/`. A changed hash (on a page seen before — first
   sightings just establish a baseline) becomes a change candidate. The full
   extracted text is stored alongside the hash (not just the hash) so the
   *next* change has something to diff against.
4. When a change is found, `scripts/lib/text-diff.mjs` computes a line-level
   diff between the old and new text (plain LCS-backtrack, no dependency) and
   trims it down to a unified-diff-style set of hunks — just the changed
   lines plus a little context, capped in size — which is what actually
   renders in the "What changed" section of the detail view.
6. **`scripts/enrich-change.mjs`** takes each change candidate and searches
   for Reddit/news discussion confirming what changed.
7. **`scripts/run.mjs`** orchestrates all of the above, merges results into
   `docs/data/launches.json` and `docs/data/changes.json`, writes
   `docs/data/meta.json`, and sends a Telegram notification
   (`scripts/lib/notify.mjs`) summarizing anything new/changed, if
   `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are configured.
8. **`docs/`** is a static, dependency-free site (plain HTML/CSS/JS) that
   reads those JSON files and renders two tile feeds (launches, changes) with
   a shared detail view, including a rendered diff for changes. It's served
   directly by GitHub Pages — no build step.
9. **`.github/workflows/runner.yml`** runs the pipeline on a daily cron, but
   `scripts/run.mjs` only actually does work once `frequencyDays` (in
   `config/settings.json`) has elapsed since the last run. Trigger a run
   immediately (bypassing the frequency gate) from the Actions tab via
   "Run workflow" with the `force` input checked.

## One-time setup

1. **Google Programmable Search Engine** (free, no billing/card required for
   the 100 queries/day tier):
   - Create a search engine at
     [programmablesearchengine.google.com](https://programmablesearchengine.google.com/controlpanel/create).
     As of a Google policy change (2026-01-20), new engines can no longer
     search the entire web — they must specify "Sites to search" (max 50
     domains). Enter any single placeholder site to get past creation (e.g.
     `www.sbicard.com/*`).
   - After creating it, go to that engine's **Setup → Basics** page and
     replace the site list with the domains in
     [`config/search-domains.json`](config/search-domains.json) (24 issuer
     domains + reddit/x/twitter/youtube + 8 Indian financial news/card-review
     sites — 36 total, using the "Entire domain" pattern, e.g.
     `*.sbicard.com`). This is a curated stand-in for whole-web search; add
     more domains later if a source you care about is missing (cap is 50).
   - Copy the **Search engine ID** from that page (this is `cx`).
   - Create an API key at
     [console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
     (enable the "Custom Search API" for the project first), and copy the
     key.
   - Add both as repo secrets: `Settings → Secrets and variables → Actions →
     New repository secret`, named `GOOGLE_SEARCH_API_KEY` and
     `GOOGLE_SEARCH_CX`.
2. **Enable GitHub Pages** — `Settings → Pages → Source: Deploy from a
   branch → Branch: main, folder: /docs`.
3. **Telegram notifications (optional)**:
   - Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`, and
     copy the token it gives you.
   - Message your new bot anything, then visit
     `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser to find
     your `chat.id` in the JSON response (this is `TELEGRAM_CHAT_ID`).
   - Add both as repo secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
   - If these aren't set, the run just skips notification silently — nothing
     else is affected.
4. First run will be a baseline pass per issuer (no candidates are emitted
   the very first time an issuer's sitemap is seen, since there's nothing to
   diff against yet) — expect the feed to start filling in from the *second*
   run onward, once a snapshot exists to compare against. (This repo's
   initial commit already includes baseline snapshots for most issuers from
   local testing, so most of them will start diffing for real on the first
   scheduled run.)

## Changing the check frequency

Edit `frequencyDays` in `config/settings.json` (default: `7`) and commit. No
workflow YAML changes needed — the cron always fires daily, the script
itself decides whether enough time has passed.

## Adding/removing issuers

Edit `config/issuers.json`. Each entry needs `slug`, `name`, `officialUrl`,
and `sitemapUrl`. If you add an issuer, also add its domain to the "Sites to
search" list in the Google PSE control panel (and to
`config/search-domains.json` for reference) — otherwise its announcement
pages won't be found by enrichment, since the search engine is restricted to
the configured domain list. Sitemap index files (`<sitemapindex>`) are followed
automatically, so you can point `sitemapUrl` at either a sitemap index or a
plain urlset.

## Local testing

```bash
npm run run          # runs only if due per frequencyDays
npm run run:force     # runs regardless (useful for local testing)
```

Requires `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` to be set in your
shell environment to get real enrichment results; without them, searches are
skipped and card entries are still created with `announcement`/`community`
left `null`.

## Known limitations (v1)

- Google's free tier caps at 100 queries/day, and each *new-launch* candidate
  uses 4 queries while each *change* candidate uses 2 (see `scripts/enrich.mjs`
  and `scripts/enrich-change.mjs`) — both draw from the same daily quota.
  That's generous for a typical weekly run but would need a paid Google Cloud
  billing tier if launch/change volume ever spikes heavily in one run.
- Change detection fetches every card-matching page on every run (not just
  one sitemap.xml per issuer), which is a lot more requests to each issuer's
  servers than launch detection alone. Some issuers already show WAF
  sensitivity (see the 403s noted below) — if an issuer starts blocking more
  aggressively after this rolls out, lower it via
  `config/settings.json` → `changeDetection.requestDelayMs`, or set
  `changeDetection.enabled` to `false` to fall back to launch-only tracking.
- Change detection shows a line-level text diff of what changed (see "What
  changed" in the detail view), but it's not semantic — it won't say "the
  joining fee went from ₹500 to ₹1000," just show you the raw lines that
  differ, which is usually enough context to tell at a glance.
- `data/page-hashes/` now stores each tracked page's full extracted text
  (not just a hash), so the next detected change has something to diff
  against. This grows the repo more than launch-only tracking did — a few KB
  per page across potentially several hundred pages per issuer — but stays
  well within what a git repo comfortably handles at this scale.
- The diff engine (`scripts/lib/text-diff.mjs`) is a plain LCS-backtrack line
  diff with no external dependency; it skips diffing (falls back to "visit
  the page directly") if both versions of a page are too large to diff
  cheaply (500K old-lines × new-lines cells), which in practice should only
  happen on unusually huge pages.
- Enrichment picks the *first* search result per query — it's a best-effort
  signal, not a verified/deduplicated source. Treat "announcement" and
  "community sentiment" as leads to click through, not ground truth.
- Candidate filtering (`config/settings.json` → `candidatePatterns`) is a
  simple substring match on the URL path. Issuers with unusual URL
  structures may need custom include/exclude patterns tuned over time.
- No de-duplication across issuers if two banks publish near-identical URL
  slugs for unrelated cards — `id` is scoped per-issuer so this is unlikely
  but not impossible.
