import { fetchSitemapUrls } from "./lib/sitemap.mjs";
import { readJson, writeJson, snapshotPathFor, PATHS } from "./lib/state.mjs";

// A real launch batch from one issuer in one run has never exceeded single
// digits in practice (see README history) - this is set an order of
// magnitude above that as a hard ceiling, not a tuned-to-the-edge value.
// Anything past it is far more likely to be a sitemap restructuring
// surfacing old/legacy URLs the crawler never saw before (observed on
// ICICI: a legacy microsite path resurfaced ~4,600 new sitemap entries in
// one run, 883 of which matched candidate patterns, producing well over a
// hundred false "new launch" entries - all disclaimer/FAQ/T&C sub-pages and
// old duplicate paths for already-tracked cards, not one real launch).
const MASS_NEW_URL_THRESHOLD = 20;

function matchesPatterns(url, settings, issuer) {
  const lowerPath = url.toLowerCase();

  // Some issuers (e.g. Amex) publish one global sitemap covering every
  // country they operate in - pathMustInclude scopes matches down to the
  // India-specific section instead of sweeping in every other locale.
  if (issuer?.pathMustInclude && !lowerPath.includes(issuer.pathMustInclude.toLowerCase())) {
    return false;
  }

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

    cardPagesByIssuer[issuer.slug] = entries.filter((e) => matchesPatterns(e.loc, settings, issuer));

    const newCardShapedLocs = newLocs.filter((e) => matchesPatterns(e.loc, settings, issuer));

    if (isFirstRun) {
      console.log(`  first run for ${issuer.name}, establishing baseline (no candidates emitted)`);
    } else if (newCardShapedLocs.length > MASS_NEW_URL_THRESHOLD) {
      // Same treatment as isFirstRun: update the snapshot below so this
      // batch is never re-flagged, but emit nothing - see
      // MASS_NEW_URL_THRESHOLD for why.
      console.warn(
        `  ! ${newCardShapedLocs.length} new card-shaped URL(s) for ${issuer.name} in one run ` +
          `(> ${MASS_NEW_URL_THRESHOLD}) - treating as a sitemap anomaly (restructuring/legacy content ` +
          `resurfacing), not ${newCardShapedLocs.length} simultaneous real launches. Suppressing candidates ` +
          `this run; baseline still updated so this doesn't re-trigger.`
      );
    } else {
      for (const entry of newLocs) {
        if (matchesPatterns(entry.loc, settings, issuer)) {
          candidates.push({
            issuerSlug: issuer.slug,
            issuerName: issuer.name,
            officialUrl: issuer.officialUrl,
            url: entry.loc,
            lastmod: entry.lastmod,
            discoveredAt: new Date().toISOString()
          });
        } else {
          // Logged so "N new since last snapshot" vs "found 0 candidates" is
          // never a mystery - every new URL either becomes a candidate or
          // shows up here explaining why it didn't.
          console.log(`  (new but not card-shaped, filtered out): ${entry.loc}`);
        }
      }
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
