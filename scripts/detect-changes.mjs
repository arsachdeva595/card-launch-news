import { fetchPageSnapshot } from "./lib/content-hash.mjs";
import { computeUnifiedDiff } from "./lib/text-diff.mjs";
import { readJson, writeJson, pageHashPathFor } from "./lib/state.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * For every card-matching page already known from this run's sitemap crawl
 * (new or previously-seen), fetches the page and hashes its visible text,
 * comparing against the hash stored from the last run. A page whose hash
 * changed since last time is returned as a "change candidate" — most likely a
 * fee, benefit, or terms update on an existing card, or a discontinued card
 * page — along with a trimmed unified diff of what actually changed.
 *
 * A page seen for the first time only establishes a baseline (hash + full
 * text, so the *next* change has something to diff against); it's never
 * flagged as changed on its first appearance.
 */
export async function detectChanges({ cardPagesByIssuer, issuers, settings }) {
  const requestDelayMs = settings.changeDetection?.requestDelayMs ?? 400;
  const changes = [];

  for (const issuer of issuers) {
    const pages = cardPagesByIssuer[issuer.slug] || [];
    if (pages.length === 0) continue;

    console.log(`Checking ${pages.length} card page(s) for content changes: ${issuer.name}`);
    const hashPath = pageHashPathFor(issuer.slug);
    const stored = await readJson(hashPath, { pages: {} });
    const updatedPages = { ...stored.pages };

    for (const entry of pages) {
      await sleep(requestDelayMs);
      const snapshot = await fetchPageSnapshot(entry.loc);
      if (!snapshot) continue; // fetch failed — leave stored state untouched, retry next run

      const previous = stored.pages[entry.loc];
      const nowIso = new Date().toISOString();

      if (!previous) {
        updatedPages[entry.loc] = {
          hash: snapshot.hash,
          text: snapshot.text,
          lastmod: entry.lastmod,
          firstSeenAt: nowIso,
          lastCheckedAt: nowIso
        };
        continue;
      }

      updatedPages[entry.loc] = {
        hash: snapshot.hash,
        text: snapshot.text,
        lastmod: entry.lastmod,
        firstSeenAt: previous.firstSeenAt,
        lastCheckedAt: nowIso
      };

      if (previous.hash !== snapshot.hash) {
        const diffHunks = computeUnifiedDiff(previous.text || "", snapshot.text);
        changes.push({
          issuerSlug: issuer.slug,
          issuerName: issuer.name,
          officialUrl: issuer.officialUrl,
          url: entry.loc,
          lastmod: entry.lastmod,
          detectedAt: nowIso,
          diffHunks: diffHunks || [] // null means the diff was too large to compute cheaply
        });
      }
    }

    await writeJson(hashPath, { pages: updatedPages, updatedAt: new Date().toISOString() });
  }

  return changes;
}
