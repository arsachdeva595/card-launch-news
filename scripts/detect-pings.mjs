import { readJson, writeJson, lastmodSnapshotPathFor } from "./lib/state.mjs";

/**
 * Lightweight ("Tier 2") change signal for every card-shaped sitemap URL that
 * ISN'T in the curated config/tracked-cards.json list — the broader universe
 * of blog posts, FAQ pages, card sub-pages, etc. that would take hours to
 * fetch and diff individually (see detect-changes.mjs for why that's scoped
 * down to the curated list instead).
 *
 * No page fetch happens here at all: this just compares each URL's <lastmod>
 * from the sitemap (already fetched by crawl.mjs) against what was stored
 * last run. A URL whose lastmod moved is reported as a ping - "something
 * changed here" - with no content/diff, since we never looked at the page
 * itself. A URL seen for the first time only establishes a baseline (it may
 * well be old, just newly observed by us), never a ping.
 *
 * Silently unable to say anything about issuers whose sitemap doesn't
 * publish <lastmod> at all - there's no signal to compare in that case.
 */
export async function detectPings({ cardPagesByIssuer, issuers, trackedCardUrls }) {
  const pings = [];

  for (const issuer of issuers) {
    const pages = (cardPagesByIssuer[issuer.slug] || []).filter((e) => !trackedCardUrls.has(e.loc));
    if (pages.length === 0) continue;

    const snapshotPath = lastmodSnapshotPathFor(issuer.slug);
    const stored = await readJson(snapshotPath, { urls: {} });
    const updatedUrls = { ...stored.urls };

    for (const entry of pages) {
      const previousLastmod = stored.urls[entry.loc];
      updatedUrls[entry.loc] = entry.lastmod ?? null;

      if (previousLastmod !== undefined && entry.lastmod && previousLastmod !== entry.lastmod) {
        pings.push({
          issuerSlug: issuer.slug,
          issuerName: issuer.name,
          url: entry.loc,
          previousLastmod,
          lastmod: entry.lastmod,
          detectedAt: new Date().toISOString()
        });
      }
    }

    await writeJson(snapshotPath, { urls: updatedUrls, updatedAt: new Date().toISOString() });
  }

  return pings;
}
