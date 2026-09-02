import { summarizeChange } from "./lib/llm-summary.mjs";
import { groundChange } from "./lib/grounding.mjs";
import { readJson, writeJson, PATHS } from "./lib/state.mjs";

const CALL_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-runs the LLM summarizer (+ Reddit-grounding check) against every
 * changes.json entry that already has an AI summary (verified `.summary`,
 * or an unverified `.summaryVerification.candidateSummary`), using each
 * entry's already-stored diffHunks - no page refetch needed. Meant to be
 * run after a prompt/validation improvement in lib/llm-summary.mjs, to
 * refresh already-published summaries against the improved logic instead
 * of waiting for their cards to change again naturally.
 *
 * Entries with no diffHunks, or no existing summary at all, are left
 * untouched - use backfill-summaries.mjs to fill those in for the first
 * time. An entry the LLM now judges NOISE keeps its current summary as-is
 * (not auto-removed - same conservative call backfill-summaries.mjs makes),
 * only logged. An entry that comes back with no usable result this time
 * (validation rejected it, call failed, key missing) has its summary
 * cleared, since the alternative - leaving a stale/possibly-wrong summary
 * standing - is exactly the failure mode this script exists to fix.
 */
async function main() {
  const changes = await readJson(PATHS.changes, []);
  const targets = changes.filter(
    (c) => (c.summary || c.summaryVerification?.candidateSummary) && (c.diffHunks || []).length
  );
  console.log(`${changes.length} total change(s), ${targets.length} with an existing AI summary to regenerate.`);

  let verified = 0;
  let unverified = 0;
  let cleared = 0;
  let noiseKept = 0;

  for (const change of targets) {
    console.log(`Regenerating: ${change.cardName} (${change.issuerName})...`);

    const result = await summarizeChange({
      cardName: change.cardName,
      issuerName: change.issuerName,
      diffHunks: change.diffHunks
    });

    if (result?.summary) {
      const verification = await groundChange({
        cardName: change.cardName,
        issuerName: change.issuerName,
        summary: result.summary,
        officialUrl: change.officialUrl,
        detectedAt: change.detectedAt
      });
      if (verification) {
        change.summary = result.summary;
        change.summaryVerification = { status: "verified", source: verification.source, via: verification.via };
        console.log(`  -> ${result.summary} (verified via ${verification.via})`);
        verified++;
      } else {
        delete change.summary;
        change.summaryVerification = { status: "unverified", candidateSummary: result.summary };
        console.log(`  -> ${result.summary} (unverified, no corroboration yet)`);
        unverified++;
      }
    } else if (result?.noise) {
      console.log(`  ! LLM now judges this noise - kept previous summary/diff as-is, not auto-removing`);
      noiseKept++;
    } else {
      delete change.summary;
      delete change.summaryVerification;
      console.log(`  ! no valid grounded summary this time - cleared, now diff-only`);
      cleared++;
    }

    await sleep(CALL_DELAY_MS);
  }

  await writeJson(PATHS.changes, changes);
  console.log(
    `\nDone. Verified ${verified}, unverified ${unverified}, cleared ${cleared} (now diff-only), noise-kept-as-is ${noiseKept}.`
  );
}

main().catch((err) => {
  console.error("Fatal error in regenerate-summaries.mjs:", err);
  process.exit(1);
});
