import { fetchPageSnapshot } from "./lib/content-hash.mjs";
import { computeUnifiedDiff } from "./lib/text-diff.mjs";
import { readJson, writeJson, pageHashPathFor } from "./lib/state.mjs";

const SITE_WIDE_SUPPRESS_THRESHOLD = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fingerprints a change by *only* its added/removed lines (ignoring
// context/ellipsis, and ignoring which card it belongs to) - two changes on
// different cards with the same fingerprint means they share identical
// added/removed content, which is exactly what a shared site-wide
// footer/template update looks like.
function diffFingerprint(diffHunks) {
  return JSON.stringify(
    diffHunks
      .filter((h) => h.type === "added" || h.type === "removed")
      .map((h) => `${h.type}:${h.text}`)
      .sort()
  );
}

/**
 * Given all changes detected for one issuer in one run, drops any group of
 * changes that share an identical added/removed fingerprint across at least
 * `threshold` different cards - a shared footer/template/banner change, not
 * per-card content. Exported standalone (no I/O) so it's unit-testable
 * without needing real page fetches.
 */
export function suppressSiteWideNoise(issuerChanges, threshold = SITE_WIDE_SUPPRESS_THRESHOLD) {
  const groups = new Map();
  for (const change of issuerChanges) {
    const fp = diffFingerprint(change.diffHunks);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(change);
  }

  const kept = [];
  const suppressed = [];
  for (const group of groups.values()) {
    if (group.length >= threshold) suppressed.push(group);
    else kept.push(...group);
  }
  return { kept, suppressed };
}

/**
 * Full-treatment ("Tier 1") change detection: fetches every card in
 * config/tracked-cards.json (a curated, hand-maintained list of known real
 * card product pages — see README) and hashes its visible text, comparing
 * against the hash stored from the last run. A page whose hash changed since
 * last time is returned as a "change candidate" — most likely a fee,
 * benefit, or terms update on an existing card, or a discontinued card page
 * — along with a trimmed unified diff of what actually changed.
 *
 * Deliberately scoped to the curated list rather than every card-shaped URL
 * on every issuer's sitemap (which can run into the thousands and take
 * hours to fetch) — see detect-pings.mjs for the lightweight tier that
 * covers everything else.
 *
 * A card seen for the first time only establishes a baseline (hash + full
 * text, so the *next* change has something to diff against); it's never
 * flagged as changed on its first appearance.
 */
export async function detectChanges({ trackedCards, issuers, settings }) {
  const requestDelayMs = settings.changeDetection?.requestDelayMs ?? 400;
  const changes = [];
  const issuerBySlug = new Map(issuers.map((i) => [i.slug, i]));

  const byIssuer = new Map();
  for (const card of trackedCards) {
    if (!byIssuer.has(card.issuerSlug)) byIssuer.set(card.issuerSlug, []);
    byIssuer.get(card.issuerSlug).push(card);
  }

  for (const [issuerSlug, cards] of byIssuer) {
    const issuer = issuerBySlug.get(issuerSlug);
    console.log(`Checking ${cards.length} tracked card(s) for content changes: ${issuer?.name || issuerSlug}`);
    const hashPath = pageHashPathFor(issuerSlug);
    const stored = await readJson(hashPath, { pages: {} });
    const updatedPages = { ...stored.pages };
    const issuerChanges = [];

    for (const card of cards) {
      await sleep(requestDelayMs);
      const snapshot = await fetchPageSnapshot(card.url);
      if (!snapshot) continue; // fetch failed — leave stored state untouched, retry next run

      const previous = stored.pages[card.url];
      const nowIso = new Date().toISOString();

      if (!previous) {
        updatedPages[card.url] = {
          hash: snapshot.hash,
          text: snapshot.text,
          firstSeenAt: nowIso,
          lastCheckedAt: nowIso
        };
        continue;
      }

      updatedPages[card.url] = {
        hash: snapshot.hash,
        text: snapshot.text,
        firstSeenAt: previous.firstSeenAt,
        lastCheckedAt: nowIso
      };

      if (previous.hash !== snapshot.hash) {
        const diffHunks = computeUnifiedDiff(previous.text || "", snapshot.text);
        issuerChanges.push({
          issuerSlug,
          issuerName: issuer?.name || issuerSlug,
          officialUrl: issuer?.officialUrl,
          cardName: card.cardName,
          status: card.status,
          url: card.url,
          detectedAt: nowIso,
          diffHunks
        });
      }
    }

    await writeJson(hashPath, { pages: updatedPages, updatedAt: new Date().toISOString() });

    // Suppress site-wide noise: if the exact same added/removed content
    // shows up across several cards for this issuer in the same run, it's a
    // shared footer/template/banner change, not a per-card content change -
    // drop all of them rather than reporting the same thing N times (their
    // hash/text state above is still updated regardless, so this doesn't
    // cause them to be re-flagged next run either).
    const { kept, suppressed } = suppressSiteWideNoise(issuerChanges);
    for (const group of suppressed) {
      console.log(
        `  suppressing ${group.length} card(s) sharing an identical site-wide diff (likely a shared footer/template/banner, not card-specific): ${group
          .map((c) => c.cardName)
          .join(", ")}`
      );
    }
    changes.push(...kept);
  }

  return changes;
}
