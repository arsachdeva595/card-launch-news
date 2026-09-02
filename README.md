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
- **All Tracked Cards**: a always-visible, searchable/filterable reference
  list of every card in `config/tracked-cards.json` (name, issuer, official
  link, `Active`/`Discontinued` status), mirrored to
  `docs/data/tracked-cards.json` on every run. This is static metadata, not a
  detection feed — a card's `Discontinued` status shows up here regardless of
  whether anything on its page happened to change in a given run.
- Optional LLM-generated one-line summary per detected change (e.g. "Airport
  lounge access vouchers increased from 2 to 3 per quarter"), shown on the
  site and in Telegram, and used to gate out noise before it's ever reported
  — see "Optional: LLM change summaries" below.

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
   `config/tracked-cards.json` for one issuer, extracts each page's visible
   text (`scripts/lib/content-hash.mjs` — strips scripts/styles/comments/tags,
   plus inherently volatile lines like live view-counters and auto-ticking
   "Last Updated On" stamps), then compares all of that issuer's pages
   against each other: any line appearing on at least half of them is
   necessarily shared header/footer/nav/cookie-banner/widget chrome (real
   card content differs card to card; template chrome doesn't), and gets
   stripped before hashing — so a bank updating its site-wide footer never
   registers as a per-card "change" in the first place. This boilerplate set
   is also persisted per issuer (`data/boilerplate-lines/`) and accumulated
   across runs rather than recomputed fresh each time, so a widget that
   shows a randomized subset of promo links per fetch (crossing the
   ≥50%-of-cards threshold on some runs, falling under it on others) can't
   flip in and out of being stripped and cause a fake diff purely from that
   inconsistency — see "Known limitations" below for the incident that
   prompted this. What's left gets
   hashed (order-insensitive - see `hashText`) and compared against the hash
   stored in `data/page-hashes/`. A changed hash (on a card seen before —
   first sightings just establish a baseline) becomes a change candidate,
   with the full post-stripping text stored alongside the hash so the *next*
   change has something to diff against. As a second layer of defense, if
   the exact same added/removed diff still shows up across ≥3 cards for the
   same issuer in one run (`suppressSiteWideNoise`), all of them are dropped
   too, in case something shared changes mid-run before it's "common"
   enough to have been caught by the cross-card comparison above.
4. When a change is found, `scripts/lib/text-diff.mjs` computes a line-level
   diff between the old and new text (plain LCS-backtrack, no dependency) and
   trims it down to a unified-diff-style set of hunks — just the changed
   lines plus a little context, capped in size — which is what actually
   renders in the "What changed" section of the detail view.
5. **`scripts/lib/llm-summary.mjs`** (optional — only runs if `NVIDIA_API_KEY`
   is set) reviews each Tier 1 change candidate's diff hunks and either
   returns a one-line summary of what genuinely changed about the card
   (fees, benefits, eligibility, discontinuation, etc.) or judges it noise
   and suppresses it from being reported at all — a second line of defense
   on top of the deterministic stripping in step 3, for noise that's
   contextual rather than structural (e.g. a cross-sell widget advertising a
   *different* card, which no fixed pattern can catch generically). The
   model is required to respond with structured JSON that includes a
   `direction` (`added`/`removed`/`modified`) and a verbatim `quote` copied
   from the diff supporting its summary; the code then cross-checks that
   quote against the actual diff hunks (not just its own say-so) — a claimed
   `direction: "added"` whose quote only appears in a `removed` line, or a
   quote that isn't found in the diff at all (a fabricated number/fact), is
   rejected and the change falls back to reporting without a summary rather
   than publishing an ungrounded one. This is what catches a model getting a
   diff's +/- direction backwards (e.g. describing a *removed* benefit as
   newly *added*). If the key isn't set, the call fails, or the response
   doesn't ground in the diff, the change is still reported as normal, just
   without a summary — this step never silently disables change detection.
6. **`scripts/lib/reddit-grounding.mjs`** is a second, independent accuracy
   check that a diff-grounded summary alone can't cover: the diff can be
   completely faithful to the page and still be *wrong*, if the page itself
   has bad copy (a bank's own FAQ stating a stale or incorrect fee, a
   copy-paste error). No amount of validating the summary against the diff
   catches that, since the diff is correctly reporting what the page now
   says. So a change's summary is only promoted to a confident, headline
   claim once independent discussion of the same change turns up on
   r/CreditCardsIndia, searched via Reddit's free, unauthenticated
   `search.rss` feed (no Apify credit spent) for the card name, then scored
   for keyword overlap (fee figures, distinctive benefit terms) against the
   LLM's summary. If nothing corroborating is found — which, given how
   sparse and lagged subreddit discussion is for most cards, will be the
   common case — the change is still reported in full (diff included, as
   always), just with the LLM's summary kept as a clearly-labeled
   *unverified* candidate instead of a stated fact, so the diff is what gets
   checked manually instead of an unconfirmed claim. Reddit's unauthenticated
   RSS rate limit is tight enough that one request can exhaust it; a 429
   trips a same-run circuit breaker so the rest of that run's change
   candidates fail straight to "unverified" instead of retrying a doomed
   request per card.

   **`scripts/lib/google-grounding.mjs`** (optional — only runs if
   `GEMINI_API_KEY` is set) is a paid fallback tried only when Reddit finds
   nothing, via Gemini's Google Search grounding tool: it asks the model to
   search the web for independent reporting (news, review sites, forums,
   the bank's own press release — not just the bank's own current product
   page, which is already the source the claim came from) corroborating
   the summary, and only counts it as verified if the response both says
   so *and* carries at least one real citation URL. `scripts/lib/grounding.mjs`
   wires the two together (Reddit first, Gemini fallback) — see
   `groundChange()`, the single entry point every caller (`run.mjs`,
   `backfill-summaries.mjs`, `regenerate-summaries.mjs`) uses instead of
   calling either grounding source directly. Since Reddit's free tier can
   realistically be exhausted on the very first request of a run (see
   above), and GitHub Actions runners share IPs across many repos, this
   fallback could end up firing far more often than "rarely" — so
   `GEMINI_MAX_CALLS` (default 20) caps how many paid calls happen in one
   process run, after which remaining candidates just fall back to
   unverified rather than spending unboundedly. `summaryVerification.via`
   records which source ("reddit" or "google") actually verified a given
   summary, shown on the site and in Telegram. This integration's exact
   request/response shape is based on Google's public docs
   (ai.google.dev/gemini-api/docs/google-search) for the newer
   "Interactions API", not live-verified against a real account from here
   — if it stops finding citations, check that page for what changed.
7. **`scripts/enrich-change.mjs`** takes each Tier 1 change candidate that
   survived the LLM noise check (the card name is already known from
   `tracked-cards.json`, no title fetch needed) and searches Reddit/YouTube
   for discussion confirming what changed.
8. **`scripts/detect-pings.mjs`** (Tier 2) takes every card-matching sitemap
   URL from step 1 that *isn't* in `tracked-cards.json`, and compares each
   one's `<lastmod>` (already known from the sitemap, no fetch needed) to
   what was stored in `data/lastmod-snapshots/` last run. A moved `lastmod`
   becomes a lightweight ping — Telegram-only, no diff, no enrichment.
9. **`scripts/lib/reddit-buzz.mjs`** ("Reddit Buzz") takes this run's newly
   detected launches and Tier 1 changes and searches r/CreditCardsIndia
   specifically (via Reddit's own `subreddit:name` search qualifier) for
   each one - deliberately separate from the general (unscoped) Reddit
   search already shown on each card's own detail page. Cards with no
   matching post contribute nothing, so this is only ever "real discussion
   found tied to an actual launch/change," never general subreddit
   browsing.
10. **`scripts/run.mjs`** orchestrates all of the above, merges Tier 1
   results into `docs/data/launches.json`, `docs/data/changes.json`, and
   `docs/data/reddit-buzz.json`, writes a full mirror of
   `config/tracked-cards.json` to `docs/data/tracked-cards.json` every run
   (regardless of whether anything changed), writes `docs/data/meta.json`,
   and sends Telegram notifications (`scripts/lib/notify.mjs`/
   `scripts/lib/telegram-format.mjs`) for launches, Tier 1 changes, Tier 2
   pings, and Reddit Buzz posts, if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
   are configured.
11. **`docs/`** is a static, dependency-free site (plain HTML/CSS/JS) that
   reads those JSON files and renders four sections: launches and changes
   as tile grids with a shared detail view (including a rendered diff, and
   a change's summary when available — with a green "Verified" badge and a
   link to the corroborating Reddit post when `lib/reddit-grounding.mjs`
   found one, or an amber "Unverified" badge and italicized text when it
   didn't), Reddit Buzz as a simpler list (title/snippet/link, no detail
   view needed), and All Tracked Cards — every card in
   `docs/data/tracked-cards.json` (a run-time mirror of
   `config/tracked-cards.json`) as a filterable/searchable list, independent
   of whether anything was detected this run. Tier 2 pings don't appear on
   the site, only in Telegram. Served directly by GitHub Pages — no build
   step.
12. **`.github/workflows/runner.yml`** runs the pipeline on a daily cron, but
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
4. **LLM change summaries (optional)**:
   - Sign up at [build.nvidia.com](https://build.nvidia.com/) (free tier
     available) and generate an API key from your account/API keys page.
   - Add it as a repo secret named `NVIDIA_API_KEY`.
   - Default model is `openai/gpt-oss-20b`; override via the
     `NVIDIA_LLM_MODEL` repo secret if you want a different hosted model from
     the same catalog.
   - If `NVIDIA_API_KEY` isn't set, every detected change is still reported
     as normal — just without a one-line summary and without the extra
     LLM-based noise check (see `scripts/lib/llm-summary.mjs`).
5. **Google Search grounding fallback (optional)**:
   - Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
     and add it as a repo secret named `GEMINI_API_KEY`.
   - Default model is `gemini-2.5-flash`; override via `GEMINI_MODEL` if you
     want a different tier. This is billed per search query (unlike the free
     Reddit check), so a fast/cheap model is the sane default for a yes/no
     corroboration check.
   - Optionally set `GEMINI_MAX_CALLS` (default 20) to change the per-run
     cap on paid calls — see `scripts/lib/google-grounding.mjs` in the
     pipeline description above for why that cap exists.
   - If `GEMINI_API_KEY` isn't set, grounding is just the free Reddit check,
     same as before this was added — this is a fallback, never a
     requirement.
6. First run will be a baseline pass per issuer (no candidates are emitted
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
- **Discontinuations flip `status` here automatically too** —
  `scripts/lib/discontinuation.mjs` scans each detected change's *added*
  diff lines for phrases like "has been discontinued" / "no longer
  available" / "withdrawn from sale"; a match flips that card's `status` to
  `Discontinued` (and stamps `discontinuedAt` with the change's detection
  timestamp) in the same run, so the Changes feed and the All Tracked Cards
  list never disagree about a card that was just discontinued. This runs
  regardless of whether `NVIDIA_API_KEY` is configured (deterministic, not
  LLM-based). Reactivation (`Discontinued` → `Active`) isn't auto-detected —
  edit the file directly if that ever comes up.
- `discontinuedAt` is only ever set by the automatic detection above — the
  ~80 cards seeded as `Discontinued` from the original spreadsheet import
  have no known discontinuation date, so the site shows "date unknown" for
  those rather than a fabricated one. Set it by hand in
  `config/tracked-cards.json` if you happen to know the real date for one of
  them.
- Removing an entry just stops full-diff tracking for it; its
  `data/page-hashes/<issuer>.json` entry is harmlessly orphaned (not
  cleaned up automatically).

The original source list (contributed as a spreadsheet export) lives at
`inputs/All Banks-Creditcard official links + Status - *.csv` for
reference/reprocessing, but isn't read by any script — only
`config/tracked-cards.json` is live.

`config/tracked-cards.json` itself isn't published (it's an internal
config file, not under `docs/`) — every run mirrors it to
`docs/data/tracked-cards.json` (name/issuer/link/status only, no internal
detection state), which is what powers the "All Tracked Cards" section on
the site. Edits here show up there on the next run.

## Local testing

```bash
npm run run          # runs only if due per frequencyDays
npm run run:force     # runs regardless (useful for local testing)
npm run backfill-summaries   # fills in `summary` for changes that don't have one yet
```

Requires `APIFY_TOKEN` to be set in your shell environment to get real
enrichment results; without it, searches are skipped and card entries are
still created with `community` fields left `null`.

`backfill-summaries` (`scripts/backfill-summaries.mjs`) re-runs the LLM step
against every change in `docs/data/changes.json` that's missing a `summary`,
reusing its already-stored `diffHunks` (no page refetch) - useful after
adding/fixing `NVIDIA_API_KEY`, or after restoring older changes from
history that predate the LLM feature. Safe to rerun; skips entries that
already have a summary. Requires `NVIDIA_API_KEY` in your shell environment;
commit and push `docs/data/changes.json` afterward to publish the results.

## Known limitations (v1)

- **If you ever change how pages get hashed/extracted again** (a new
  `VOLATILE_LINE_PATTERNS` entry, a new stripping rule, etc.), wipe
  `data/page-hashes/*.json` (the internal comparison baseline - genuinely
  stale under a new algorithm) but do **not** wipe `docs/data/changes.json`
  wholesale. That file is the published history of already-detected,
  already-surfaced changes; the algorithm change doesn't retroactively
  invalidate real findings that happened to also get published alongside
  noise. This bit once - a full reset discarded 6 genuine "card
  discontinued" notices along with 17 real noise entries, recovered
  afterward from git history. If cleanup of published noise is needed,
  remove those specific entries (by URL/cardName), not the whole file.
- Reddit Buzz only searches for posts tied to launches/changes detected in
  *that same run* - it doesn't retroactively search for older discussion
  about a card that launched/changed days ago, and it relies on Reddit's
  `subreddit:name` search qualifier working the way the underlying Apify
  actor passes queries through (unverified live, same caveat as the rest of
  the Apify integration - see the enrichment section above).
- Change detection went through three rounds of noise-fixing against real
  production data before landing on a general approach, worth knowing the
  history of in case new noise ever surfaces again:
  1. A reordering-only "related products" carousel (same content, different
     order every fetch) → fixed by hashing sorted lines instead of original
     order (`hashText` in `content-hash.mjs`).
  2. Inherently volatile content - live view-counters ("165 Views"),
     auto-ticking "Last Updated On" stamps → fixed by stripping lines
     matching known patterns entirely (`VOLATILE_LINE_PATTERNS`).
  3. Whole-category shared chrome - cookie-consent banners, accessibility
     toolbar controls, rotating "latest articles" widgets, nav/footer
     fragments (150+ "changes" in one run, almost all this) → fixed
     generally rather than pattern-by-pattern: `computeBoilerplateLines`
     compares all of one issuer's cards against each other in the same run
     and strips any line common to at least half of them, since real card
     content necessarily differs card-to-card while template chrome
     necessarily doesn't. `suppressSiteWideNoise` (≥3 cards sharing an
     identical diff) remains as a second layer of defense for anything that
     changes mid-run before it's "common" enough to be caught by #3.
     Approach #3 is general (adapts per-issuer automatically) rather than
     needing a new regex every time a bank adds a new widget, but it's still
     a heuristic (half-of-cards threshold) — if a genuine change happens to
     also appear on ≥50% of an issuer's cards simultaneously (rare, but
     possible for something like a company-wide rebrand), it would be
     stripped as if it were boilerplate too.
  4. A variant of #3 that slipped through initially: HDFC's cross-sell
     widget shows a *randomized* subset of promo links per fetch rather
     than a fixed set, so a given line (e.g. "DigiPassBook", "Better Money
     Choices®") would cross the ≥50%-of-cards threshold on some runs and
     fall just under it on others, purely by chance. Since each run's
     boilerplate set was recomputed fresh and baked directly into that
     run's stored baseline text, this inconsistency between runs showed up
     as fake added/removed diff lines on cards that hadn't actually
     changed. Fixed by making the boilerplate-line set persistent and
     monotonic per issuer (`data/boilerplate-lines/<issuer>.json`) - once a
     line is ever identified as shared/widget content, it's excluded in
     every future run too, unioned with whatever that run's fresh
     comparison additionally finds, so it never flips back and forth.
- Launch-candidate filtering had a similar issue: HDFC's `/campaign/how-to-*`
  FAQ pages (e.g. "How to Check Credit Card Summary") were flagged as new
  card launches since their URLs contain "credit-card". Added `how-to-` and
  `/campaign/` to `config/settings.json` → `candidatePatterns.exclude`.
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

## Newsletter Editions

A separate, additive persistence layer for the daily newsletter edition
(currently authored by a scheduled Cowork task and sent to subscribers via a
Pabbly webhook). This layer does not touch the pipeline above; it turns each
sent edition into a durable, queryable JSON artifact under `docs/data`, plus
a small static viewer page.

### File structure

- `docs/data/newsletters.json`: the master feed, an append-only array of
  every published edition, newest first. Metadata only (subject, summary,
  permalink, issuers, items), no `body_html`, so it stays lean to fetch in
  full.
- `docs/data/editions/{YYYY-MM-DD}.json`: one file per edition, the full
  record including `body_html` (and `body_markdown` when available).
- `docs/data/by-issuer/{issuer-slug}.json`: a flat array of every item
  (card mention) across all editions that named this issuer, newest first
  by `edition_date`. Each item carries its parent edition's number, date,
  and permalink inline (`edition_number`, `edition_date`,
  `edition_permalink`, the latter pointing straight at that card's anchor
  within the edition), so a Payload CMS block on monzy.co can render a
  per-card news list for one issuer without a second fetch. Issuer slugs
  are the canonical short form, one per issuer in `config/issuers.json`:

  | Source slug (`config/issuers.json`) | Canonical |
  | --- | --- |
  | `amex` | `amex` |
  | `au-sfb` | `au-sfb` |
  | `axis-bank` | `axis` |
  | `bank-of-baroda` | `bob` |
  | `bank-of-india` | `boi` |
  | `canara-bank` | `canara` |
  | `dbs-bank` | `dbs` |
  | `equitas-sfb` | `equitas-sfb` |
  | `federal-bank` | `federal` |
  | `hdfc-bank` | `hdfc` |
  | `hsbc-india` | `hsbc` |
  | `icici-bank` | `icici` |
  | `idbi-bank` | `idbi` |
  | `idfc-first-bank` | `idfc-first` |
  | `indusind-bank` | `indusind` |
  | `karur-vysya-bank` | `kvb` |
  | `kotak-mahindra-bank` | `kotak` |
  | `punjab-national-bank` | `pnb` |
  | `rbl-bank` | `rbl` |
  | `sbi-card` | `sbi` |
  | `south-indian-bank` | `sib` |
  | `standard-chartered-india` | `standard-chartered` |
  | `union-bank-of-india` | `union-bank` |
  | `yes-bank` | `yes-bank` |

  `scripts/publish-edition.js` applies this mapping automatically to every
  incoming item's `issuer` field, so a Cowork payload can send either form
  and the published data always lands in canonical slugs. This table lives
  in that script (`CANONICAL_ISSUER_SLUGS`); update it there if
  `config/issuers.json` ever gains a new issuer.

All dates are derived in the `Asia/Kolkata` timezone, matching when the
Cowork task actually sends the edition.

### Edition viewer

`docs/edition/index.html` is a single static page, no build step. It reads
`?date=YYYY-MM-DD` from the URL, fetches the matching file from
`docs/data/editions/`, and renders the edition's subject, metadata, and
body. The URL pattern for any published edition is:

```
https://arsachdeva595.github.io/card-launch-news/edition/?date=2026-08-20
```

If the `date` param is missing, the page renders an in-page archive of
every edition (pulled from `newsletters.json`), newest first. If a
specific edition file can't be found, it shows a friendly error with a
link back to that archive.

### Publishing an edition manually

`scripts/publish-edition.js` is the CLI the Cowork task calls after it
authors an edition. It takes one argument, a path to a JSON payload file,
validates it, derives `permalink`/`issuers`/`anchor` fields, writes the
per-edition file, upserts the master feed, and re-derives every per-issuer
feed. It uses only Node built-ins, no `npm install` needed, and is
idempotent: rerunning the same edition overwrites cleanly rather than
duplicating.

**Verified news only**: before anything is written, every item is
cross-checked against this repo's own pipeline data — `docs/data/changes.json`,
`docs/data/launches.json`, and `config/tracked-cards.json` — matched by
(card name, canonical issuer):

- A launch match is trusted directly (a launch's announcement is the
  card's own official page, not an LLM's reading of a diff, so there's no
  hallucination-prone summarization step to distrust).
- A `discontinued` item is trusted if `config/tracked-cards.json` actually
  shows that card as `Discontinued` (set deterministically by regex on the
  page's own diff — see `lib/discontinuation.mjs` — not an LLM guess).
- Anything else needs a matching `changes.json` entry whose
  `summaryVerification.status` is `"verified"` — i.e. the same
  Reddit-grounding check described in "Two-pronged change accuracy" above
  already found independent corroboration for that exact summary.

An item that doesn't check out is **dropped from the edition** (not the
whole publish) with the reason logged; the rest of the edition still
publishes. If every item in a payload fails the check, the whole publish
is refused rather than shipping an empty edition. Pass `--allow-unverified`
to skip this gate entirely — only meant for backfilling **historical**
editions that were already reviewed and sent before this check (or before
`summaryVerification`) existed, where there's nothing meaningful left to
check items against; see `scripts/backfill-editions.js`, which always
passes it. Never pass it for a new edition.

```bash
node scripts/publish-edition.js --input path/to/edition-payload.json
node scripts/publish-edition.js --input path/to/edition-payload.json --allow-unverified  # historical backfills only
```

The input payload shape:

```json
{
  "number": 3,
  "date": "2026-08-21",
  "subject": "Newsletter subject line",
  "summary": "One-line teaser",
  "body_html": "<div>...</div>",
  "body_markdown": "optional source markdown",
  "items": [
    {
      "card_slug": "hdfc-diners-black",
      "card_name": "HDFC Diners Club Black",
      "issuer": "hdfc",
      "change_type": "devaluation",
      "summary": "Milestone spend requirement raised from X to Y"
    }
  ]
}
```

The script writes only the files listed above; it never runs `git add` or
`git commit` itself, that's left to the calling environment (the Cowork
task commits everything in one shot after the script exits).

`scripts/backfill-editions.js` seeded Edition 1 and Edition 2, which were
already sent via Pabbly before this layer existed; it holds their real
payloads and calls the same publish logic, so rerunning it is a harmless
no-op against the current data.

`scripts/regenerate-issuer-feeds.js` is a one-off maintenance script: it
deletes every file in `docs/data/by-issuer/` and rewrites all of them from
`newsletters.json` using the current flat-item schema. Use it after
renaming an issuer slug, or any time the per-issuer feeds need to be
rebuilt from scratch rather than incrementally.

```bash
node scripts/regenerate-issuer-feeds.js
```

### Raw endpoint URLs (for Payload CMS API Blocks)

Payload CMS blocks on monzy.co can point directly at the raw JSON on
GitHub Pages, or at `raw.githubusercontent.com` for the unrendered file.
A few example issuer feeds:

```
https://arsachdeva595.github.io/card-launch-news/data/newsletters.json
https://arsachdeva595.github.io/card-launch-news/data/by-issuer/hdfc.json
https://arsachdeva595.github.io/card-launch-news/data/by-issuer/axis.json
https://arsachdeva595.github.io/card-launch-news/data/by-issuer/hsbc.json
```
