import { fetchContentHash } from "./lib/content-hash.mjs";
import { readJson, writeJson, pageHashPathFor } from "./lib/state.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * For every card-matching page already known from this run's sitemap crawl
 * (new or previously-seen), fetches the page and hashes its content, comparing
 * against the hash stored from the last run. A page whose hash changed since
 * last time is returned as a "change candidate" — most likely a fee, benefit,
 * or terms update on an existing card, or a discontinued card page.
 *
 * A page seen for the first time only establishes a baseline hash; it's never
 * flagged as changed on its first appearance (nothing to diff against yet).
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
      const hash = await fetchContentHash(entry.loc);
      if (!hash) continue; // fetch failed — leave stored state untouched, retry next run

      const previous = stored.pages[entry.loc];
      const nowIso = new Date().toISOString();

      if (!previous) {
        updatedPages[entry.loc] = { hash, lastmod: entry.lastmod, firstSeenAt: nowIso, lastCheckedAt: nowIso };
        continue;
      }

      updatedPages[entry.loc] = { ...previous, hash, lastmod: entry.lastmod, lastCheckedAt: nowIso };

      if (previous.hash !== hash) {
        changes.push({
          issuerSlug: issuer.slug,
          issuerName: issuer.name,
          officialUrl: issuer.officialUrl,
          url: entry.loc,
          lastmod: entry.lastmod,
          previousHash: previous.hash,
          detectedAt: nowIso
        });
      }
    }

    await writeJson(hashPath, { pages: updatedPages, updatedAt: new Date().toISOString() });
  }

  return changes;
}
