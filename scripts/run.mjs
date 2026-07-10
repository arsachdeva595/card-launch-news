import { crawlAll } from "./crawl.mjs";
import { enrichCandidate } from "./enrich.mjs";
import { detectChanges } from "./detect-changes.mjs";
import { detectPings } from "./detect-pings.mjs";
import { enrichChangeCandidate } from "./enrich-change.mjs";
import { notifyTelegram } from "./lib/notify.mjs";
import { formatLaunchMessage, formatChangeMessage, formatPingMessage } from "./lib/telegram-format.mjs";
import { readJson, writeJson, PATHS } from "./lib/state.mjs";

const MAX_LAUNCHES_KEPT = 200;
const MAX_CHANGES_KEPT = 200;
const TELEGRAM_SEND_DELAY_MS = 1100; // stay under Telegram's ~1 msg/sec-per-chat guidance

function isDue(settings) {
  if (!settings.lastRunAt) return true;
  const elapsedMs = Date.now() - new Date(settings.lastRunAt).getTime();
  const frequencyMs = (settings.frequencyDays ?? 7) * 24 * 60 * 60 * 1000;
  return elapsedMs >= frequencyMs;
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
  for (const candidate of candidates) {
    console.log(`Enriching new-launch candidate: ${candidate.url}`);
    try {
      const launch = await enrichCandidate(candidate);
      newLaunches.push(launch);
      console.log(`  -> "${launch.cardName}"`);
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

  const newChanges = [];
  for (const change of changeCandidates) {
    console.log(`Enriching change candidate: ${change.url}`);
    try {
      const enriched = await enrichChangeCandidate(change);
      newChanges.push(enriched);
      console.log(`  -> "${enriched.cardName}"`);
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

  const existingLaunches = await readJson(PATHS.launches, []);
  const mergedLaunches = mergeById(existingLaunches, newLaunches, "discoveredAt", MAX_LAUNCHES_KEPT);
  await writeJson(PATHS.launches, mergedLaunches);

  const existingChanges = await readJson(PATHS.changes, []);
  const mergedChanges = mergeById(existingChanges, newChanges, "detectedAt", MAX_CHANGES_KEPT);
  await writeJson(PATHS.changes, mergedChanges);

  const nowIso = new Date().toISOString();
  await writeJson(PATHS.meta, {
    lastRunAt: nowIso,
    frequencyDays: settings.frequencyDays ?? 7,
    changeDetectionEnabled: settings.changeDetection?.enabled !== false,
    issuerCount: issuers.length,
    trackedCardCount: trackedCards.length,
    totalLaunchesTracked: mergedLaunches.length,
    totalChangesTracked: mergedChanges.length
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

  console.log(
    `Run complete. ${newLaunches.length} new launch(es), ${newChanges.length} tracked change(s), ${pings.length} ping(s). ` +
      `Tracking ${mergedLaunches.length} launches, ${mergedChanges.length} changes total.`
  );
}

main().catch((err) => {
  console.error("Fatal error in run.mjs:", err);
  process.exit(1);
});
