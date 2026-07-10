import { crawlAll } from "./crawl.mjs";
import { enrichCandidate } from "./enrich.mjs";
import { detectChanges } from "./detect-changes.mjs";
import { enrichChangeCandidate } from "./enrich-change.mjs";
import { notifyTelegram } from "./lib/notify.mjs";
import { readJson, writeJson, PATHS } from "./lib/state.mjs";

const MAX_LAUNCHES_KEPT = 200;
const MAX_CHANGES_KEPT = 200;

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

  const [issuers, settings] = await Promise.all([
    readJson(PATHS.issuers, []),
    readJson(PATHS.settings, { frequencyDays: 7, lastRunAt: null })
  ]);

  if (!force && !isDue(settings)) {
    console.log(
      `Not due yet (frequencyDays=${settings.frequencyDays}, lastRunAt=${settings.lastRunAt}). Skipping. Use --force to override.`
    );
    return;
  }

  console.log(`Starting run. issuers=${issuers.length} force=${force}`);
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

  const changeCandidates = settings.changeDetection?.enabled === false
    ? []
    : await detectChanges({ cardPagesByIssuer, issuers, settings });
  console.log(`Found ${changeCandidates.length} changed card page(s) across all issuers.`);

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
    issuerCount: issuers.length,
    totalLaunchesTracked: mergedLaunches.length,
    totalChangesTracked: mergedChanges.length
  });

  await writeJson(PATHS.settings, { ...settings, lastRunAt: nowIso });

  if (newLaunches.length > 0 || newChanges.length > 0) {
    const lines = ["<b>Card Launch News update</b>"];
    if (newLaunches.length > 0) {
      lines.push("", `<b>${newLaunches.length} new card(s) launched:</b>`);
      for (const l of newLaunches) lines.push(`• ${l.cardName} (${l.issuerName}) — ${l.productPageUrl}`);
    }
    if (newChanges.length > 0) {
      lines.push("", `<b>${newChanges.length} card page(s) changed:</b>`);
      for (const c of newChanges) lines.push(`• ${c.cardName} (${c.issuerName}) — ${c.productPageUrl}`);
    }
    await notifyTelegram(lines.join("\n"));
  }

  console.log(
    `Run complete. ${newLaunches.length} new launch(es), ${newChanges.length} change(s). ` +
      `Tracking ${mergedLaunches.length} launches, ${mergedChanges.length} changes total.`
  );
}

main().catch((err) => {
  console.error("Fatal error in run.mjs:", err);
  process.exit(1);
});
