# Card Launch News

Tracks newly launched credit cards from Indian banks, and flags when an
existing card's page changes (fee/benefit/terms updates, discontinuations).

- **New launches**: detected by diffing each issuer's XML sitemap week over
  week — a new sitemap entry that looks like a card product page is treated
  as a launch signal. The card's own official page *is* the announcement
  (no search needed for that part); each candidate is also enriched with
  Reddit/YouTube community discussion where findable.
- **Card changes**: every card-shaped page already known from the sitemap
  crawl gets fetched and content-hashed each run; a hash that differs from
  last run's stored hash means the page's content changed, and a line-level
  diff of what changed gets computed and shown. Enriched with Reddit/YouTube
  discussion of the change.
- Optional Telegram notification when either happens.

**Why Reddit + YouTube specifically, not general web search**: every general
web-search option hit a wall — Brave requires a billing card even for the
free tier; Google's Programmable Search Engine stopped supporting
whole-web search for newly-created engines; and Google's Custom Search JSON
API is being locked down for new Cloud orgs/accounts entirely (see
[this thread](https://discuss.google.dev/t/custom-search-json-api-returns-403-permission-denied-on-new-org-new-account-restriction/347093)).
Reddit (via a registered OAuth app, its current supported free path for
low-volume read access) and YouTube Data API v3 (a separate product,
unaffected by the Custom Search restriction) both have genuinely free tiers
with simple setup, so enrichment is built on those instead. X/Twitter has no
viable free search API right now, so that field is always left empty with
an honest label rather than something that looks broken.

## How it works

1. **`scripts/crawl.mjs`** fetches every issuer's sitemap (see
   `config/issuers.json`), compares it against the last-seen snapshot in
   `data/sitemap-snapshots/`, and emits new URLs that match card-like path
   patterns (`config/settings.json` → `candidatePatterns`). It also returns
   every currently-live card-matching URL per issuer (new or not), for the
   change-detection step to reuse without a second sitemap fetch.
2. **`scripts/enrich.mjs`** takes each new-launch candidate, fetches its page
   `<title>` to derive a card name, uses the card's own page as the
   announcement, and searches Reddit (`scripts/lib/reddit.mjs`) and YouTube
   (`scripts/lib/youtube.mjs`) for community discussion.
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
   Reddit/YouTube for discussion confirming what changed.
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

1. **Reddit** (free, no billing/card required):
   - Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) →
     "create app" → type **script** → name it anything (e.g.
     "card-launch-news") → redirect URI can be anything valid, e.g.
     `https://example.com` (unused for this grant type).
   - After creating it, the client ID is the string under the app name
     (looks like a short random string), and the client secret is labeled
     "secret".
   - Add both as repo secrets: `Settings → Secrets and variables → Actions →
     New repository secret`, named `REDDIT_CLIENT_ID` and
     `REDDIT_CLIENT_SECRET`.
2. **YouTube Data API v3** (free tier: 100 searches/day, no billing/card
   required just to create the key):
   - At [console.cloud.google.com](https://console.cloud.google.com/apis/library/youtube.googleapis.com),
     enable "YouTube Data API v3" for your project.
   - Create an API key at
     [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials).
   - Add it as a repo secret named `YOUTUBE_API_KEY`.
3. **Enable GitHub Pages** — `Settings → Pages → Source: Deploy from a
   branch → Branch: main, folder: /docs`.
4. **Telegram notifications (optional)**:
   - Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`, and
     copy the token it gives you.
   - Message your new bot anything, then visit
     `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser to find
     your `chat.id` in the JSON response (this is `TELEGRAM_CHAT_ID`).
   - Add both as repo secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
   - If these aren't set, the run just skips notification silently — nothing
     else is affected.
5. First run will be a baseline pass per issuer (no candidates are emitted
   the very first time an issuer's sitemap is seen, since there's nothing to
   diff against yet) — expect the feed to start filling in from the *second*
   run onward, once a snapshot exists to compare against. (This repo's
   initial commit already includes baseline snapshots for most issuers from
   local testing, so most of them will start diffing for real on the first
   scheduled run.)

## Changing the check frequency

Two ways, both end up editing the same `frequencyDays` field in
`config/settings.json` (default: `7`):

- **From GitHub's UI** (no file editing): Actions tab → "Card launch runner"
  → Run workflow → fill in the `frequencyDays` input (e.g. `1` for daily) →
  Run workflow. The script persists it, so it becomes the new steady-state
  frequency, not just a one-off override. Leave it blank to keep the current
  value.
- **Directly**: edit `frequencyDays` in `config/settings.json` and commit
  (either locally, or via GitHub's inline file editor at
  `github.com/<you>/<repo>/edit/main/config/settings.json`).

Either way, no workflow YAML changes are needed — the cron always fires
daily, the script itself decides whether enough time has actually passed.
The site's "Settings" panel (collapsed under the search bar) shows the
current frequency and links to both of the above.

## Adding/removing issuers

Edit `config/issuers.json`. Each entry needs `slug`, `name`, `officialUrl`,
and `sitemapUrl`. Sitemap index files (`<sitemapindex>`) are followed
automatically, so you can point `sitemapUrl` at either a sitemap index or a
plain urlset. No search-engine domain list to maintain anymore — Reddit and
YouTube search aren't domain-restricted the way the old Google PSE setup was.

## Local testing

```bash
npm run run          # runs only if due per frequencyDays
npm run run:force     # runs regardless (useful for local testing)
```

Requires `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `YOUTUBE_API_KEY` to
be set in your shell environment to get real enrichment results; without
them, searches are skipped and card entries are still created with
`community` fields left `null`.

## Known limitations (v1)

- YouTube's free tier caps at 100 searches/day (search.list costs 100 quota
  units, daily quota is 10,000); each candidate uses 1 YouTube query, so
  that's ~100 candidates/day of headroom — generous for a normal run.
  Reddit's OAuth app has its own (much higher, effectively non-limiting at
  this volume) free tier for read-only access.
- X/Twitter community sentiment is always empty — there's currently no free
  API path for it (X's API requires a paid tier; Nitter, the old free
  workaround, is mostly dead). The UI is explicit about this rather than
  showing a misleading "not found yet."
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
- Enrichment picks the *first* Reddit/YouTube result per query — it's a
  best-effort signal, not a verified/deduplicated source. Treat "community
  sentiment"/"community verification" as leads to click through, not ground
  truth.
- Candidate filtering (`config/settings.json` → `candidatePatterns`) is a
  simple substring match on the URL path. Issuers with unusual URL
  structures may need custom include/exclude patterns tuned over time.
- No de-duplication across issuers if two banks publish near-identical URL
  slugs for unrelated cards — `id` is scoped per-issuer so this is unlikely
  but not impossible.
