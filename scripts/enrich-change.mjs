import { searchReddit } from "./lib/reddit.mjs";
import { searchYouTube } from "./lib/youtube.mjs";
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
 * name and searches for community discussion/verification of the change on
 * Reddit and YouTube. There's no single "announcement" for a change the way
 * there is for a launch, so this only returns a community section - the diff
 * itself (computed in detect-changes.mjs) is the primary signal.
 */
export async function enrichChangeCandidate(change) {
  const fallbackName = fallbackNameFromUrl(change.url, change.issuerName);
  const cardName = await fetchCardName(change.url, fallbackName);
  const query = `${cardName} credit card`;

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const redditResults = await searchReddit(`${query} changed OR revised OR discontinued OR devalued`, { limit: 3 });

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const youtubeResults = await searchYouTube(`${query} update`, { maxResults: 3 });

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
      youtube: pickFirst(youtubeResults)
    }
  };
}
