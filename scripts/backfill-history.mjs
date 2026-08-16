// One-off (re-runnable) backfill: for every Active tracked card, compares
// the Wayback Machine's closest archived snapshot to TARGET_DATE against
// today's live page, and records what changed in between. Unlike the daily
// runner, this doesn't care *when* within that window something changed -
// only old-state vs new-state (see README/conversation context: requested
// as an April-1-to-today reference, not a change timeline).
//
// Resumable: re-running skips cards already recorded with a stable status
// ("changed"/"unchanged"/"no-coverage") and only retries ones that errored
// transiently. Pass --force to wipe and redo everything. Pass --limit=N to
// process only the first N cards (for a quick pilot run).
import { readJson, PATHS, ROOT } from "./lib/state.mjs";
import { fetchPageText } from "./lib/content-hash.mjs";
import { computeUnifiedDiff } from "./lib/text-diff.mjs";
import { findClosestSnapshot, rawSnapshotUrl, viewableSnapshotUrl, fetchArchivedPageText } from "./lib/wayback.mjs";
import { summarizeBackfillDiff } from "./lib/backfill-summary.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";

const TARGET_DATE = new Date("2026-04-01T00:00:00Z");
const OUTPUT_PATH = PATHS.backfill;
const REQUEST_DELAY_MS = 300;
const CONCURRENCY = 3;
const RETRYABLE_STATUSES = new Set(["fetch-error", "error"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseRecord(card, issuer) {
  return {
    cardName: card.cardName,
    issuerSlug: card.issuerSlug,
    issuerName: issuer?.name || card.issuerSlug,
    url: card.url,
    trackedStatus: card.status,
    checkedAt: new Date().toISOString()
  };
}

async function processCard(card, issuer) {
  const snapshot = await findClosestSnapshot(card.url, TARGET_DATE);
  if (!snapshot) {
    return { ...baseRecord(card, issuer), status: "no-coverage" };
  }

  const [oldText, newText] = await Promise.all([
    fetchArchivedPageText(fetchPageText, rawSnapshotUrl(snapshot.timestamp, card.url)),
    fetchPageText(card.url)
  ]);

  if (oldText === null || newText === null) {
    return {
      ...baseRecord(card, issuer),
      status: "fetch-error",
      snapshotDate: snapshot.snapshotDate.toISOString()
    };
  }

  const diffHunks = computeUnifiedDiff(oldText, newText);
  const oldSnapshotUrl = viewableSnapshotUrl(snapshot.timestamp, card.url);

  if (diffHunks.length === 0) {
    return {
      ...baseRecord(card, issuer),
      status: "unchanged",
      snapshotDate: snapshot.snapshotDate.toISOString(),
      oldSnapshotUrl
    };
  }

  const summary = await summarizeBackfillDiff({
    cardName: card.cardName,
    issuerName: issuer?.name || card.issuerSlug,
    diffHunks
  });

  return {
    ...baseRecord(card, issuer),
    status: "changed",
    snapshotDate: snapshot.snapshotDate.toISOString(),
    oldSnapshotUrl,
    summary,
    diffHunks
  };
}

// Writes are chained through this so concurrent workers never call
// fs.writeFile on the same path at the same time (which could interleave
// and corrupt the file) - each checkpoint waits for the previous one.
let writeChain = Promise.resolve();
function scheduleWrite(data) {
  writeChain = writeChain.then(async () => {
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  });
  return writeChain;
}

async function main() {
  const force = process.argv.includes("--force");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

  const [issuers, trackedCards] = await Promise.all([
    readJson(PATHS.issuers, []),
    readJson(PATHS.trackedCards, [])
  ]);
  const issuerBySlug = new Map(issuers.map((i) => [i.slug, i]));
  const activeCards = trackedCards.filter((c) => c.status === "Active").slice(0, limit);

  const existing = force ? [] : await readJson(OUTPUT_PATH, []);
  const kept = existing.filter((e) => !RETRYABLE_STATUSES.has(e.status));
  const doneUrls = new Set(kept.map((e) => e.url));
  const results = [...kept];

  const queue = activeCards.filter((c) => !doneUrls.has(c.url));
  console.log(
    `Backfill target date: ${TARGET_DATE.toISOString().slice(0, 10)}. ` +
      `${activeCards.length} active card(s), ${kept.length} already done, ${queue.length} to process.`
  );

  let nextIdx = 0;
  let completed = 0;

  async function worker() {
    while (nextIdx < queue.length) {
      const card = queue[nextIdx++];
      await sleep(REQUEST_DELAY_MS);
      let record;
      try {
        record = await processCard(card, issuerBySlug.get(card.issuerSlug));
      } catch (err) {
        record = { ...baseRecord(card, issuerBySlug.get(card.issuerSlug)), status: "error", error: err.message };
      }
      results.push(record);
      completed++;
      console.log(`  (${completed}/${queue.length}) [${record.status}] ${card.issuerSlug} - ${card.cardName}`);
      if (completed % 5 === 0) await scheduleWrite(results);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  await scheduleWrite(results);

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`Backfill complete. ${results.length} card(s) recorded:`, counts);
}

main().catch((err) => {
  console.error("Fatal error in backfill-history.mjs:", err);
  process.exit(1);
});
