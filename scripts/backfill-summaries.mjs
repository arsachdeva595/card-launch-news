import { summarizeChange } from "./lib/llm-summary.mjs";
import { groundChange } from "./lib/grounding.mjs";
import { readJson, writeJson, PATHS } from "./lib/state.mjs";

const CALL_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One-off/rerunnable backfill: fills in the `summary` field for entries in
 * docs/data/changes.json that don't have one yet (e.g. changes detected
 * before NVIDIA_API_KEY was configured, or restored from history). Reuses
 * each entry's already-stored diffHunks - no page refetch needed. Skips
 * entries that already have a summary, so it's safe to rerun after adding
 * more changes later.
 */
async function main() {
  const changes = await readJson(PATHS.changes, []);
  const pending = changes.filter((c) => !c.summary);
  console.log(`${changes.length} total change(s), ${pending.length} missing a summary.`);

  let verified = 0;
  let unverified = 0;
  let disagreed = 0;
  let unavailable = 0;

  for (const change of pending) {
    console.log(`Summarizing: ${change.cardName} (${change.issuerName})...`);
    const result = await summarizeChange({
      cardName: change.cardName,
      issuerName: change.issuerName,
      diffHunks: change.diffHunks
    });

    if (result?.summary) {
      // Same verified-vs-unverified split as the daily run.mjs path (see
      // lib/grounding.mjs) - a summary only becomes the confident `summary`
      // field once corroborated (Reddit first, Gemini's paid Google Search
      // grounding as a fallback), otherwise it's kept as an explicitly-
      // unverified candidate so the site never shows an ungrounded AI guess
      // as fact.
      const verification = await groundChange({
        cardName: change.cardName,
        issuerName: change.issuerName,
        summary: result.summary
      });
      if (verification) {
        change.summary = result.summary;
        change.summaryVerification = { status: "verified", source: verification.source, via: verification.via };
        console.log(`  -> ${result.summary} (verified via ${verification.via})`);
        verified++;
      } else {
        change.summaryVerification = { status: "unverified", candidateSummary: result.summary };
        console.log(`  -> ${result.summary} (unverified, no corroboration yet)`);
        unverified++;
      }
    } else if (result?.noise) {
      // These entries were already hand-verified as real from their actual
      // diff content before being published - the LLM disagreeing here is
      // worth knowing about, but isn't reason enough to auto-delete a
      // manually-verified entry, so this only logs, never removes.
      disagreed++;
      console.log(`  ! LLM judged this noise (kept anyway - was manually verified): ${change.cardName}`);
    } else {
      unavailable++;
      console.log(`  ! no result (missing key, empty diff, or call failed) for: ${change.cardName}`);
    }

    await sleep(CALL_DELAY_MS);
  }

  await writeJson(PATHS.changes, changes);
  console.log(`\nDone. Verified ${verified}, unverified ${unverified}, LLM-disagreed ${disagreed}, unavailable ${unavailable}.`);
}

main().catch((err) => {
  console.error("Fatal error in backfill-summaries.mjs:", err);
  process.exit(1);
});
