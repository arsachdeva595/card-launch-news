import { fetchPageSnapshot } from "./lib/content-hash.mjs";
import { computeUnifiedDiff } from "./lib/text-diff.mjs";
import { readJson, writeJson, pageHashPathFor } from "./lib/state.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        changes.push({
          issuerSlug,
          issuerName: issuer?.name || issuerSlug,
          officialUrl: issuer?.officialUrl,
          cardName: card.cardName,
          status: card.status,
          url: card.url,
          detectedAt: nowIso,
          diffHunks: diffHunks || [] // null means the diff was too large to compute cheaply
        });
      }
    }

    await writeJson(hashPath, { pages: updatedPages, updatedAt: new Date().toISOString() });
  }

  return changes;
}
