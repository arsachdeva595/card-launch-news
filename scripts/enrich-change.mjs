import { webSearch } from "./lib/search.mjs";
import { fetchCardName, fallbackNameFromUrl, slugify } from "./lib/page-meta.mjs";

const BETWEEN_QUERY_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickFirst(results) {
  return results && results.length > 0 ? results[0] : null;
}

/**
 * Given a page whose content-hash changed since last check, derives the card
 * name and searches for community discussion/verification of the change
 * (Reddit specifically, plus a general query for news coverage). There's no
 * single "announcement" for a change the way there is for a launch, so this
 * only returns a community section.
 */
export async function enrichChangeCandidate(change) {
  const fallbackName = fallbackNameFromUrl(change.url, change.issuerName);
  const cardName = await fetchCardName(change.url, fallbackName);
  const query = `${cardName} credit card`;

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const redditResults = await webSearch(`${query} (changed OR revised OR discontinued OR devalued) site:reddit.com`, {
    count: 3
  });

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const generalResults = await webSearch(`${query} changed OR revised OR discontinued OR devalued`, { count: 5 });

  return {
    id: `${change.issuerSlug}-${slugify(cardName)}`,
    cardName,
    issuerName: change.issuerName,
    issuerSlug: change.issuerSlug,
    officialUrl: change.officialUrl,
    productPageUrl: change.url,
    detectedAt: change.detectedAt,
    lastmod: change.lastmod,
    diffHunks: change.diffHunks || [],
    community: {
      reddit: pickFirst(redditResults),
      general: pickFirst(generalResults)
    }
  };
}
