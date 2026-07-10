import { fetchSitemapUrls } from "./lib/sitemap.mjs";
import { readJson, writeJson, snapshotPathFor, PATHS } from "./lib/state.mjs";

function matchesPatterns(url, settings) {
  const lowerPath = url.toLowerCase();
  const { include = [], exclude = [] } = settings.candidatePatterns || {};

  if (exclude.some((needle) => lowerPath.includes(needle.toLowerCase()))) return false;
  if (include.length === 0) return true;
  return include.some((needle) => lowerPath.includes(needle.toLowerCase()));
}

/**
 * Crawls every configured issuer's sitemap, diffs against the last-seen
 * snapshot, and returns newly-appeared URLs that look like card product pages.
 * Snapshots are updated on disk as a side effect (even for issuers that fail
 * to fetch, previous snapshot is simply left untouched).
 *
 * Also returns cardPagesByIssuer: every currently-live card-matching URL per
 * issuer (new or previously known), so callers like detect-changes.mjs can
 * reuse this sitemap fetch instead of hitting each sitemap a second time.
 */
export async function crawlAll({ issuers, settings }) {
  const candidates = [];
  const cardPagesByIssuer = {};

  for (const issuer of issuers) {
    console.log(`Crawling ${issuer.name} (${issuer.sitemapUrl})`);
    let entries;
    try {
      entries = await fetchSitemapUrls(issuer.sitemapUrl);
    } catch (err) {
      console.warn(`  ! skipping ${issuer.name}: ${err.message}`);
      continue;
    }

    const currentLocs = new Set(entries.map((e) => e.loc));
    const snapshotPath = snapshotPathFor(issuer.slug);
    const previous = await readJson(snapshotPath, { locs: [], updatedAt: null });
    const previousLocs = new Set(previous.locs);
    const isFirstRun = previous.locs.length === 0;

    const newLocs = entries.filter((e) => !previousLocs.has(e.loc));
    console.log(`  ${entries.length} URLs total, ${newLocs.length} new since last snapshot`);

    cardPagesByIssuer[issuer.slug] = entries.filter((e) => matchesPatterns(e.loc, settings));

    if (!isFirstRun) {
      for (const entry of newLocs) {
        if (matchesPatterns(entry.loc, settings)) {
          candidates.push({
            issuerSlug: issuer.slug,
            issuerName: issuer.name,
            officialUrl: issuer.officialUrl,
            url: entry.loc,
            lastmod: entry.lastmod,
            discoveredAt: new Date().toISOString()
          });
        }
      }
    } else {
      console.log(`  first run for ${issuer.name}, establishing baseline (no candidates emitted)`);
    }

    await writeJson(snapshotPath, {
      locs: Array.from(currentLocs),
      updatedAt: new Date().toISOString()
    });
  }

  return { candidates, cardPagesByIssuer };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const issuers = await readJson(PATHS.issuers, []);
  const settings = await readJson(PATHS.settings, {});
  const { candidates } = await crawlAll({ issuers, settings });
  console.log(JSON.stringify(candidates, null, 2));
}
