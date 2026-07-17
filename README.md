# Card Launch News

Tracks newly launched credit cards from Indian banks, and flags when an
existing card's page changes (fee/benefit/terms updates, discontinuations).

- **New launches**: detected by diffing each issuer's XML sitemap week over
  week — a new sitemap entry that looks like a card product page is treated
  as a launch signal. The card's own official page *is* the announcement
  (no search needed for that part); each candidate is also enriched with
  Reddit/YouTube community discussion where findable.
- **Card changes, two tiers**:
  - **Tier 1 — full diff**: `config/tracked-cards.json` is a curated,
    hand-maintained list of ~590 known real card product pages (name +
    official URL + issuer + active/discontinued status). Every card in this
    list gets fetched, content-hashed, and diffed on every run — a hash that
    differs from last run means the page's content changed, and a
    line-level diff of what actually changed gets shown.
  - **Tier 2 — lightweight ping**: every *other* card-shaped URL turned up
    by the sitemap crawl (blog posts, FAQ sub-pages, co-brand variants not
    yet in the curated list, etc. — this can run into the thousands) only
    gets its sitemap `<lastmod>` compared across runs, no page fetch at all.
    A moved `lastmod` sends a terse "something changed here" ping to
    Telegram, with no diff/enrichment behind it. This is what keeps daily
    runtime in the minutes rather than hours — see "Why two tiers" below.
- Optional Telegram notification for all three (launches, tier-1 changes,
  tier-2 pings).

### Why two tiers for change detection

Early testing fetched *every* card-shaped sitemap URL across all 24
issuers — 5,756 pages after some pattern bugs were fixed, still ~2,680 after
fixing a locale bug on Amex's global sitemap and excluding common card
sub-pages (fees/features/rewards/FAQ pages that inflate the count without
adding much signal). At roughly a second per page (delay + fetch time),
that's over an hour daily just for change detection. A curated list of
actual card pages (contributed as `inputs/All Banks-Creditcard official
links + Status - *.csv`, converted into `config/tracked-cards.json`) is both
faster (~590 pages, ~10-15 minutes) *and* more complete for issuers whose
URL structure doesn't match the generic patterns at all (e.g. DBS's card
pages don't contain "credit-card" or "card/" anywhere in the URL, so the
generic crawler finds zero of them — only the curated list does). Tier 2
keeps a low-fidelity signal for everything else without the fetch cost.

**Why Apify for Reddit/YouTube search**: general web-search APIs hit wall
after wall — Brave requires a billing card even for the free tier; Google's
Programmable Search Engine stopped supporting whole-web search for
newly-created engines; Google's Custom Search JSON API is being locked down
for new Cloud orgs/accounts entirely (see
[this thread](https://discuss.google.dev/t/custom-search-json-api-returns-403-permission-denied-on-new-org-new-account-restriction/347093)).
Reddit/YouTube's own official APIs worked initially but were replaced with
[Apify](https://apify.com/) actors for a single unified integration across
both. X/Twitter is deliberately *not* covered — there's no free official API
for it, and scraping it (which is what an Apify actor would do) sits in a
ToS gray area we chose not to build on. That field is always left empty
with an honest label rather than something that looks broken.

## How it works

1. **`scripts/crawl.mjs`** fetches every issuer's sitemap (see
   `config/issuers.json`), compares it against the last-seen snapshot in
   `data/sitemap-snapshots/`, and emits new URLs that match card-like path
   patterns (`config/settings.json` → `candidatePatterns`) as new-launch
   candidates. It also returns every currently-live card-matching URL per
   issuer (new or not) — this is the raw material for Tier 2 pings, not
   fetched further at this stage.
2. **`scripts/enrich.mjs`** takes each new-launch candidate, fetches its page
   `<title>` to derive a card name, uses the card's own page as the
   announcement, and searches Reddit/YouTube via Apify actors
   (`scripts/lib/reddit.mjs`, `scripts/lib/youtube.mjs`, both built on the
   generic runner in `scripts/lib/apify.mjs`) for community discussion.
3. **`scripts/detect-changes.mjs`** (Tier 1) fetches every card in
   `config/tracked-cards.json` via `scripts/lib/content-hash.mjs`, which
   extracts the page's visible text (stripping scripts/styles/comments/tags
   so markup churn doesn't cause false positives) and hashes it, comparing
   against the hash stored in `data/page-hashes/`. A changed hash (on a card
   seen before — first sightings just establish a baseline) becomes a change
   candidate. The full extracted text is stored alongside the hash so the
   *next* change has something to diff against.
4. When a change is found, `scripts/lib/text-diff.mjs` computes a line-level
   diff between the old and new text (plain LCS-backtrack, no dependency) and
   trims it down to a unified-diff-style set of hunks — just the changed
   lines plus a little context, capped in size — which is what actually
   renders in the "What changed" section of the detail view.
5. **`scripts/enrich-change.mjs`** takes each Tier 1 change candidate (the
   card name is already known from `tracked-cards.json`, no title fetch
   needed) and searches Reddit/YouTube for discussion confirming what
   changed.
6. **`scripts/detect-pings.mjs`** (Tier 2) takes every card-matching sitemap
   URL from step 1 that *isn't* in `tracked-cards.json`, and compares each
   one's `<lastmod>` (already known from the sitemap, no fetch needed) to
   what was stored in `data/lastmod-snapshots/` last run. A moved `lastmod`
   becomes a lightweight ping — Telegram-only, no diff, no enrichment.
7. **`scripts/run.mjs`** orchestrates all of the above, merges Tier 1 results
   into `docs/data/launches.json` and `docs/data/changes.json`, writes
   `docs/data/meta.json`, and sends Telegram notifications
   (`scripts/lib/notify.mjs`/`scripts/lib/telegram-format.mjs`) for
   launches, Tier 1 changes, and Tier 2 pings, if
   `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are configured.
8. **`docs/`** is a static, dependency-free site (plain HTML/CSS/JS) that
   reads the launches/changes JSON files and renders two tile feeds with a
   shared detail view, including a rendered diff for changes. Tier 2 pings
   don't appear on the site, only in Telegram. Served directly by GitHub
   Pages — no build step.
9. **`.github/workflows/runner.yml`** runs the pipeline on a daily cron, but
   `scripts/run.mjs` only actually does work once `frequencyDays` (in
   `config/settings.json`) has elapsed since the last run. Trigger a run
   immediately (bypassing the frequency gate) from the Actions tab via
   "Run workflow" with the `force` input checked.

## One-time setup

1. **Apify** (free tier: small monthly compute credit, no card required to
   start; real usage beyond that credit does cost money):
   - Sign up at [apify.com](https://apify.com/) and grab your API token from
     [console.apify.com/settings/integrations](https://console.apify.com/settings/integrations).
   - Add it as a repo secret named `APIFY_TOKEN`.
   - Default actors used: `trudax/reddit-scraper-lite` for Reddit,
     `streamers/youtube-scraper` for YouTube (both set in
     `scripts/lib/reddit.mjs`/`scripts/lib/youtube.mjs`). If either actor is
     unavailable, deprecated, or you'd rather use a different one, override
     via the `APIFY_REDDIT_ACTOR_ID`/`APIFY_YOUTUBE_ACTOR_ID` repo secrets —
     but note the input/output field names are actor-specific, so switching
     actors likely means adjusting the mapping code in those two files too.
     If an actor's output doesn't map to any usable result, a warning gets
     logged with a raw sample of what it actually returned, to make that
     fixable rather than silently empty.
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

An issuer can optionally set `pathMustInclude` (e.g. Amex's `"/en-in/"`) if
its sitemap covers multiple countries/locales — without this, every card
pattern match sweeps in every locale's pages too.

## Maintaining the curated tracked-cards list (Tier 1)

Edit `config/tracked-cards.json` directly — each entry needs `cardName`,
`issuerSlug` (must match a slug in `config/issuers.json`), `url`, and
`status` (`Active`/`Discontinued`/anything else you want to track by).
This is the list that gets full fetch+hash+diff treatment every run, so:

- **Add a card** when you notice one missing (e.g. from a Tier 2 ping, or
  just browsing an issuer's site) to start getting full diffs for it instead
  of just a lightweight ping.
- **New launches get added here automatically** — `scripts/run.mjs` appends
  every newly-detected launch straight into `tracked-cards.json` (status
  `Active`) as soon as it's found, in the same run. Its first content-hash
  fetch happens immediately too (as part of that run's Tier 1 pass), so it
  starts getting full diff treatment from day one instead of waiting for the
  next run or falling through to Tier 2's lightweight ping.
- Removing an entry just stops full-diff tracking for it; its
  `data/page-hashes/<issuer>.json` entry is harmlessly orphaned (not
  cleaned up automatically).

The original source list (contributed as a spreadsheet export) lives at
`inputs/All Banks-Creditcard official links + Status - *.csv` for
reference/reprocessing, but isn't read by any script — only
`config/tracked-cards.json` is live.

## Local testing

```bash
npm run run          # runs only if due per frequencyDays
npm run run:force     # runs regardless (useful for local testing)
```

Requires `APIFY_TOKEN` to be set in your shell environment to get real
enrichment results; without it, searches are skipped and card entries are
still created with `community` fields left `null`.

## Known limitations (v1)

- Two noise sources beyond the reordering fix, found from real production
  data (150 "changes" in one run, almost all noise): (1) inherently volatile
  content like live view-counters ("165 Views") and auto-ticking "Last
  Updated On" stamps — stripped entirely from extracted text
  (`scripts/lib/content-hash.mjs` → `VOLATILE_LINE_PATTERNS`) before
  hashing/diffing, since no amount of reorder-tolerance fixes a value that's
  just genuinely different every fetch; (2) shared site-wide footer/banner
  changes (a bank added one new promo link and it rippled across every
  tracked card's page at once) — `scripts/detect-changes.mjs` →
  `suppressSiteWideNoise()` drops any group of ≥3 cards for the same issuer
  sharing an identical added/removed fingerprint in the same run, since
  that's a template change, not per-card content. Both are heuristic and
  tuned to what was actually observed, not exhaustive — new noise patterns
  may still surface as tracking continues.
- Apify's free tier is a small monthly compute credit, not unlimited —
  unlike the official Reddit/YouTube APIs this replaced, real usage beyond
  that credit costs money. Watch usage at
  [console.apify.com/billing](https://console.apify.com/billing) if
  launch/change volume grows.
- The Reddit/YouTube Apify actors' input/output schemas were mapped without
  live verification against real output (see `scripts/lib/reddit.mjs`,
  `scripts/lib/youtube.mjs`) — if community results are always empty despite
  a valid `APIFY_TOKEN`, check the logged warning for a raw output sample
  and adjust the field mapping.
- X/Twitter community sentiment is always empty — there's currently no free
  API path for it (X's API requires a paid tier; Nitter, the old free
  workaround, is mostly dead). The UI is explicit about this rather than
  showing a misleading "not found yet."
- Tier 1 fetches every card in `tracked-cards.json` (~590 pages) on every
  run — a lot more requests to each issuer's servers than launch detection
  alone, though far less than fetching every card-matching sitemap URL
  (2,680+ before scoping to the curated list). Some issuers already show WAF
  sensitivity (see the 403s noted below) — if an issuer starts blocking more
  aggressively, lower it via `config/settings.json` →
  `changeDetection.requestDelayMs`, or set `changeDetection.enabled` to
  `false` to disable both tiers and fall back to launch-only tracking.
- Tier 2 pings are only as good as each issuer's sitemap `<lastmod>` data —
  some issuers don't publish it at all (no signal, silently nothing to
  compare), and some regenerate it inaccurately (e.g. stamping "today" on
  every URL regardless of real changes), which would make Tier 2 noisy for
  that issuer specifically. Tier 1 (content-hash based) isn't affected by
  this since it never looks at `lastmod` at all.
- Change detection shows a line-level text diff of what changed (see "What
  changed" in the detail view), but it's not semantic — it won't say "the
  joining fee went from ₹500 to ₹1000," just show you the raw lines that
  differ, which is usually enough context to tell at a glance.
- `data/page-hashes/` now stores each tracked page's full extracted text
  (not just a hash), so the next detected change has something to diff
  against. This grows the repo more than launch-only tracking did — a few KB
  per page across potentially several hundred pages per issuer — but stays
  well within what a git repo comfortably handles at this scale.
- The comparison hash is computed over *sorted* lines, not original page
  order — several issuer pages embed a "related products" carousel/widget
  that renders in a different order every request with otherwise identical
  content (observed on HDFC's card pages), which a naive order-sensitive
  hash flags as changed on every single run. Sorting first makes the hash
  insensitive to pure reordering while still changing normally when content
  is genuinely added, removed, or edited.
- The diff itself (`scripts/lib/text-diff.mjs`) prefers a plain LCS-backtrack
  line diff (has surrounding context, no external dependency), but falls
  back to a multiset (line-frequency) diff — no context lines, but never
  skipped — if both versions of a page are too large for the LCS diff's
  O(n×m) comparison (500K old-lines × new-lines cells). Either way, "What
  changed" always shows something concrete rather than "not available."
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
