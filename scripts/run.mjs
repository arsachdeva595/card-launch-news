import { crawlAll } from "./crawl.mjs";
import { enrichCandidate } from "./enrich.mjs";
import { readJson, writeJson, PATHS } from "./lib/state.mjs";

const MAX_LAUNCHES_KEPT = 200;

function isDue(settings) {
  if (!settings.lastRunAt) return true;
  const elapsedMs = Date.now() - new Date(settings.lastRunAt).getTime();
  const frequencyMs = (settings.frequencyDays ?? 7) * 24 * 60 * 60 * 1000;
  return elapsedMs >= frequencyMs;
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
  const candidates = await crawlAll({ issuers, settings });
  console.log(`Found ${candidates.length} new candidate card page(s) across all issuers.`);

  const newLaunches = [];
  for (const candidate of candidates) {
    console.log(`Enriching candidate: ${candidate.url}`);
    try {
      const launch = await enrichCandidate(candidate);
      newLaunches.push(launch);
      console.log(`  -> "${launch.cardName}"`);
    } catch (err) {
      console.warn(`  ! enrichment failed for ${candidate.url}: ${err.message}`);
    }
  }

  const existingLaunches = await readJson(PATHS.launches, []);
  const byId = new Map(existingLaunches.map((l) => [l.id, l]));
  for (const launch of newLaunches) byId.set(launch.id, launch);

  const mergedLaunches = Array.from(byId.values())
    .sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt))
    .slice(0, MAX_LAUNCHES_KEPT);

  await writeJson(PATHS.launches, mergedLaunches);

  const nowIso = new Date().toISOString();
  await writeJson(PATHS.meta, {
    lastRunAt: nowIso,
    frequencyDays: settings.frequencyDays ?? 7,
    issuerCount: issuers.length,
    totalLaunchesTracked: mergedLaunches.length
  });

  await writeJson(PATHS.settings, { ...settings, lastRunAt: nowIso });

  console.log(`Run complete. ${newLaunches.length} new launch(es) added, ${mergedLaunches.length} tracked total.`);
}

main().catch((err) => {
  console.error("Fatal error in run.mjs:", err);
  process.exit(1);
});
