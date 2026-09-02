import { crawlAll } from "./crawl.mjs";
import { enrichCandidate } from "./enrich.mjs";
import { detectChanges } from "./detect-changes.mjs";
import { detectPings } from "./detect-pings.mjs";
import { enrichChangeCandidate } from "./enrich-change.mjs";
import { summarizeChange } from "./lib/llm-summary.mjs";
import { groundChangeInReddit } from "./lib/reddit-grounding.mjs";
import { detectsDiscontinuation } from "./lib/discontinuation.mjs";
import { collectRedditBuzz } from "./lib/reddit-buzz.mjs";
import { notifyTelegram } from "./lib/notify.mjs";
import { formatLaunchMessage, formatChangeMessage, formatPingMessage, formatRedditBuzzMessage } from "./lib/telegram-format.mjs";
import { readJson, writeJson, PATHS } from "./lib/state.mjs";

const MAX_LAUNCHES_KEPT = 200;
const MAX_CHANGES_KEPT = 200;
const MAX_BUZZ_KEPT = 200;
const TELEGRAM_SEND_DELAY_MS = 1100; // stay under Telegram's ~1 msg/sec-per-chat guidance

// GitHub Actions' scheduled-cron trigger isn't exact - it commonly drifts by
// minutes to a few hours. Each real run also pushes lastRunAt to its own
// finish time (10-20 min after the nominal cron slot), not the slot itself.
// Without slack, that drift compounds: a run that finishes a bit late makes
// next time's trigger land just under a full frequencyDays later, so it
// skips - then the skip preserves the old lastRunAt, so the day after that
// is comfortably overdue and runs again. Net effect without this buffer:
// "daily" settles into "every other day". This grace period absorbs typical
// cron jitter + run duration so a same-slot trigger still counts as due.
const DUE_GRACE_MS = 6 * 60 * 60 * 1000;

function isDue(settings) {
  if (!settings.lastRunAt) return true;
  const elapsedMs = Date.now() - new Date(settings.lastRunAt).getTime();
  const frequencyMs = (settings.frequencyDays ?? 7) * 24 * 60 * 60 * 1000;
  return elapsedMs >= frequencyMs - DUE_GRACE_MS;
}

function mergeById(existing, incoming, sortKey, maxKept) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values())
    .sort((a, b) => new Date(b[sortKey]) - new Date(a[sortKey]))
    .slice(0, maxKept);
}

async function main() {
  const force = process.argv.includes("--force") || process.env.FORCE_RUN === "true";

  const [issuers, settings, trackedCards] = await Promise.all([
    readJson(PATHS.issuers, []),
    readJson(PATHS.settings, { frequencyDays: 7, lastRunAt: null }),
    readJson(PATHS.trackedCards, [])
  ]);

  const frequencyOverride = Number(process.env.FREQUENCY_DAYS_OVERRIDE);
  if (process.env.FREQUENCY_DAYS_OVERRIDE && Number.isFinite(frequencyOverride) && frequencyOverride > 0) {
    console.log(`Overriding frequencyDays: ${settings.frequencyDays} -> ${frequencyOverride}`);
    settings.frequencyDays = frequencyOverride;
  }

  if (!force && !isDue(settings)) {
    console.log(
      `Not due yet (frequencyDays=${settings.frequencyDays}, lastRunAt=${settings.lastRunAt}). Skipping. Use --force to override.`
    );
    return;
  }

  console.log(`Starting run. issuers=${issuers.length} trackedCards=${trackedCards.length} force=${force}`);
  const { candidates, cardPagesByIssuer } = await crawlAll({ issuers, settings });
  console.log(`Found ${candidates.length} new candidate card page(s) across all issuers.`);

  const newLaunches = [];
  const trackedCardUrlSet = new Set(trackedCards.map((c) => c.url));
  let trackedCardsChanged = false;

  for (const candidate of candidates) {
    console.log(`Enriching new-launch candidate: ${candidate.url}`);
    try {
      const launch = await enrichCandidate(candidate);
      newLaunches.push(launch);
      console.log(`  -> "${launch.cardName}"`);

      // Promote every newly-detected launch straight into the Tier 1
      // curated list, so it gets full fetch+hash+diff treatment from now
      // on instead of falling through to Tier 2's lightweight lastmod ping.
      if (!trackedCardUrlSet.has(launch.productPageUrl)) {
        trackedCards.push({
          cardName: launch.cardName,
          issuerSlug: launch.issuerSlug,
          url: launch.productPageUrl,
          status: "Active"
        });
        trackedCardUrlSet.add(launch.productPageUrl);
        trackedCardsChanged = true;
      }
    } catch (err) {
      console.warn(`  ! enrichment failed for ${candidate.url}: ${err.message}`);
    }
  }

  // Tier 1: full fetch+hash+diff, but only for the curated tracked-cards
  // list - not every card-shaped sitemap URL, which can run into the
  // thousands and take hours (see detect-changes.mjs).
  const changeCandidates = settings.changeDetection?.enabled === false
    ? []
    : await detectChanges({ trackedCards, issuers, settings });
  console.log(`Found ${changeCandidates.length} changed tracked card(s).`);

  const trackedCardByUrl = new Map(trackedCards.map((c) => [c.url, c]));

  const newChanges = [];
  for (const change of changeCandidates) {
    console.log(`Checking change candidate with LLM: ${change.url}`);

    // Deterministic discontinuation check - runs regardless of whether the
    // LLM step below is configured/available, so config/tracked-cards.json's
    // `status` field (and the public All Tracked Cards mirror) never drifts
    // out of sync with what a card's own page now says just because
    // NVIDIA_API_KEY isn't set. Reactivation (Discontinued -> Active) isn't
    // auto-detected - rare enough to handle manually if it ever comes up.
    if (detectsDiscontinuation(change.diffHunks)) {
      const trackedCard = trackedCardByUrl.get(change.url);
      if (trackedCard && trackedCard.status !== "Discontinued") {
        trackedCard.status = "Discontinued";
        trackedCard.discontinuedAt = change.detectedAt;
        trackedCardsChanged = true;
        console.log(`  status updated to Discontinued in tracked-cards.json: "${change.cardName}"`);
      }
    }

    try {
      // LLM judges real-vs-noise before we bother with enrichment. Missing
      // key / call failure returns null ("unknown"), not noise - the change
      // still gets reported without a summary, so this optional step never
      // silently disables change detection when unconfigured.
      const llmResult = await summarizeChange({
        cardName: change.cardName,
        issuerName: change.issuerName,
        diffHunks: change.diffHunks
      });
      if (llmResult?.noise) {
        console.log(`  LLM judged noise, suppressing: "${change.cardName}"`);
        continue;
      }

      const enriched = await enrichChangeCandidate(change);

      if (llmResult?.summary) {
        // A summary that's faithful to the diff can still be wrong if the
        // *page itself* has bad copy (a bank's own FAQ typo, a stale figure
        // left in one section) - no amount of diff-grounding catches that.
        // Only promote it to the confident, headline "summary" field once
        // independent discussion of the same change turns up on
        // r/CreditCardsIndia; otherwise keep it as a clearly-unverified
        // candidate so the site shows the raw diff for manual review
        // instead of repeating an unconfirmed claim as fact.
        const verification = await groundChangeInReddit({ cardName: change.cardName, summary: llmResult.summary });
        if (verification) {
          enriched.summary = llmResult.summary;
          enriched.summaryVerification = { status: "verified", source: verification };
        } else {
          enriched.summaryVerification = { status: "unverified", candidateSummary: llmResult.summary };
        }
      }

      newChanges.push(enriched);
      console.log(
        `  -> "${enriched.cardName}"${
          enriched.summary
            ? ` (${enriched.summary}, verified via Reddit)`
            : enriched.summaryVerification?.candidateSummary
              ? ` (unverified: ${enriched.summaryVerification.candidateSummary})`
              : ""
        }`
      );
    } catch (err) {
      console.warn(`  ! enrichment failed for ${change.url}: ${err.message}`);
    }
  }

  // Tier 2: lightweight lastmod-only ping for everything card-shaped that
  // ISN'T in the curated list - no fetch, no diff, no enrichment. Telegram
  // only, not persisted to the site's data files.
  const trackedCardUrls = new Set(trackedCards.map((c) => c.url));
  const pings = settings.changeDetection?.enabled === false
    ? []
    : await detectPings({ cardPagesByIssuer, issuers, trackedCardUrls });
  console.log(`Found ${pings.length} lightweight lastmod ping(s) outside the tracked-cards list.`);

  // Reddit Buzz: r/CreditCardsIndia posts tied specifically to this run's
  // launches/changes - never general subreddit browsing. Reuses whatever
  // newLaunches/newChanges were already found above, no extra detection step.
  const newBuzz = await collectRedditBuzz({ newLaunches, newChanges });
  console.log(`Found ${newBuzz.length} Reddit Buzz post(s) for this run's launches/changes.`);

  const existingLaunches = await readJson(PATHS.launches, []);
  const mergedLaunches = mergeById(existingLaunches, newLaunches, "discoveredAt", MAX_LAUNCHES_KEPT);
  await writeJson(PATHS.launches, mergedLaunches);

  const existingChanges = await readJson(PATHS.changes, []);
  const mergedChanges = mergeById(existingChanges, newChanges, "detectedAt", MAX_CHANGES_KEPT);
  await writeJson(PATHS.changes, mergedChanges);

  const existingBuzz = await readJson(PATHS.redditBuzz, []);
  const mergedBuzz = mergeById(existingBuzz, newBuzz, "detectedAt", MAX_BUZZ_KEPT);
  await writeJson(PATHS.redditBuzz, mergedBuzz);

  // Single write for every trackedCards mutation this run (new launches
  // promoted to Tier 1, and any status flipped to Discontinued above) -
  // consolidated here rather than writing after each mutation site.
  if (trackedCardsChanged) {
    await writeJson(PATHS.trackedCards, trackedCards);
    console.log("config/tracked-cards.json updated.");
  }

  // Public mirror of the full curated card list (name/issuer/link/status),
  // independent of launches/changes - this is static metadata, not
  // something detected, so it shouldn't only be visible when it happens to
  // coincide with a page diff. Written every run so it never goes stale.
  const issuerNameBySlug = new Map(issuers.map((i) => [i.slug, i.name]));
  const publicTrackedCards = trackedCards.map((c) => ({
    cardName: c.cardName,
    issuerName: issuerNameBySlug.get(c.issuerSlug) || c.issuerSlug,
    issuerSlug: c.issuerSlug,
    url: c.url,
    status: c.status,
    // Only populated for discontinuations this pipeline itself detected (see
    // discontinuation.mjs above) - the ~80 cards seeded as Discontinued from
    // the original spreadsheet import have no known date, so this is left
    // undefined for those rather than guessed.
    discontinuedAt: c.discontinuedAt ?? null
  }));
  await writeJson(PATHS.publicTrackedCards, publicTrackedCards);

  const nowIso = new Date().toISOString();
  await writeJson(PATHS.meta, {
    lastRunAt: nowIso,
    frequencyDays: settings.frequencyDays ?? 7,
    changeDetectionEnabled: settings.changeDetection?.enabled !== false,
    issuerCount: issuers.length,
    trackedCardCount: trackedCards.length,
    totalLaunchesTracked: mergedLaunches.length,
    totalChangesTracked: mergedChanges.length,
    totalRedditBuzzTracked: mergedBuzz.length
  });

  await writeJson(PATHS.settings, { ...settings, lastRunAt: nowIso });

  // One message per item (not a bundled summary) so each notification is a
  // complete, self-contained record of what was found — title, links, and
  // everything else stored for that card.
  for (const launch of newLaunches) {
    await notifyTelegram(formatLaunchMessage(launch, settings.siteUrl));
    await new Promise((resolve) => setTimeout(resolve, TELEGRAM_SEND_DELAY_MS));
  }
  for (const change of newChanges) {
    await notifyTelegram(formatChangeMessage(change, settings.siteUrl));
    await new Promise((resolve) => setTimeout(resolve, TELEGRAM_SEND_DELAY_MS));
  }
  for (const ping of pings) {
    await notifyTelegram(formatPingMessage(ping));
    await new Promise((resolve) => setTimeout(resolve, TELEGRAM_SEND_DELAY_MS));
  }
  for (const buzz of newBuzz) {
    await notifyTelegram(formatRedditBuzzMessage(buzz, settings.siteUrl));
    await new Promise((resolve) => setTimeout(resolve, TELEGRAM_SEND_DELAY_MS));
  }

  console.log(
    `Run complete. ${newLaunches.length} new launch(es), ${newChanges.length} tracked change(s), ${pings.length} ping(s), ` +
      `${newBuzz.length} Reddit Buzz post(s). Tracking ${mergedLaunches.length} launches, ${mergedChanges.length} changes, ` +
      `${mergedBuzz.length} buzz posts total.`
  );
}

main().catch((err) => {
  console.error("Fatal error in run.mjs:", err);
  process.exit(1);
});
