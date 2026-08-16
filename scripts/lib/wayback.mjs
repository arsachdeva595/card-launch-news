// Looks up an archived snapshot of a URL from the Wayback Machine, closest
// to a given target date - used to establish a historical baseline for
// pages this project never itself observed (see backfill-history.mjs).
const CDX_TIMEOUT_MS = 30000;
const CDX_MAX_ATTEMPTS = 3;

function pad(n) {
  return String(n).padStart(2, "0");
}

function toWaybackStamp(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

function parseWaybackTimestamp(ts) {
  const y = ts.slice(0, 4);
  const mo = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const h = ts.slice(8, 10) || "00";
  const mi = ts.slice(10, 12) || "00";
  const s = ts.slice(12, 14) || "00";
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

async function fetchCdxRows(cdxUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDX_TIMEOUT_MS);
  try {
    const res = await fetch(cdxUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`CDX lookup failed: HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds the archived snapshot of `url` whose capture date is closest to
 * `targetDate`, searching from `fromDate` to today. Returns null ONLY when
 * the CDX query itself succeeded and confirmed zero snapshots exist in that
 * window - a real, unavoidable gap (not every page gets crawled by the
 * Internet Archive). A network error, timeout, or non-200 response *throws*
 * instead of returning null, after one retry - so a transient failure (or
 * archive.org rate-limiting under concurrency) is distinguishable from
 * "confirmed no coverage" by the caller, and can be retried on a later run
 * rather than being permanently misfiled as unrecoverable.
 */
export async function findClosestSnapshot(url, targetDate, fromDate = new Date("2025-01-01T00:00:00Z")) {
  const cdxUrl =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}` +
    `&output=json&filter=statuscode:200&collapse=timestamp:8` +
    `&from=${toWaybackStamp(fromDate)}&to=${toWaybackStamp(new Date())}`;

  // archive.org's CDX endpoint is slow and occasionally rate-limits under
  // concurrency - a couple of backed-off retries absorbs that instead of
  // immediately giving up and forcing a whole separate script re-run later.
  let rows;
  let lastErr;
  for (let attempt = 1; attempt <= CDX_MAX_ATTEMPTS; attempt++) {
    try {
      rows = await fetchCdxRows(cdxUrl);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < CDX_MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  if (lastErr) throw lastErr;

  if (!Array.isArray(rows) || rows.length < 2) return null;

  const targetMs = targetDate.getTime();
  let best = null;
  let bestDiffMs = Infinity;
  for (const row of rows.slice(1)) {
    const timestamp = row[1];
    const snapshotDate = parseWaybackTimestamp(timestamp);
    const diffMs = Math.abs(snapshotDate.getTime() - targetMs);
    if (diffMs < bestDiffMs) {
      bestDiffMs = diffMs;
      best = { timestamp, snapshotDate };
    }
  }
  return best;
}

// "id_" suffix returns the raw, unmodified archived HTML - no Wayback
// toolbar/link-rewriting injected - so text extraction sees the same shape
// of markup as a normal live fetch.
export function rawSnapshotUrl(timestamp, originalUrl) {
  return `https://web.archive.org/web/${timestamp}id_/${originalUrl}`;
}

// Human-viewable snapshot URL (with Wayback's toolbar) - for linking out to
// from the site so a reader can see the archived page themselves.
export function viewableSnapshotUrl(timestamp, originalUrl) {
  return `https://web.archive.org/web/${timestamp}/${originalUrl}`;
}

/**
 * Fetches an archived snapshot's page text via `fetchFn` (expected to be
 * content-hash.mjs's fetchPageText, passed in rather than imported to avoid
 * a circular dependency), retrying a couple of times on failure -
 * archive.org routinely returns a transient 503 under load, which
 * fetchPageText surfaces as null exactly like a permanent failure. Still
 * returns null (never throws) after exhausting attempts, since the caller
 * already treats a null fetch result as a retryable "fetch-error" record.
 */
export async function fetchArchivedPageText(fetchFn, snapshotUrl, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const text = await fetchFn(snapshotUrl);
    if (text !== null) return text;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  return null;
}
