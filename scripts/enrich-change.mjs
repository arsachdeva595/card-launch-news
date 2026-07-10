import { searchReddit } from "./lib/reddit.mjs";
import { searchYouTube } from "./lib/youtube.mjs";
import { slugify } from "./lib/page-meta.mjs";

const BETWEEN_QUERY_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickFirst(results) {
  return results && results.length > 0 ? results[0] : null;
}

/**
 * Given a tracked card whose content-hash changed since last check, searches
 * for community discussion/verification of the change on Reddit and
 * YouTube. The card name is already known (from config/tracked-cards.json),
 * so unlike enrich.mjs there's no page-title fetch needed here. There's no
 * single "announcement" for a change the way there is for a launch, so this
 * only returns a community section - the diff itself (computed in
 * detect-changes.mjs) is the primary signal.
 */
export async function enrichChangeCandidate(change) {
  const query = `${change.cardName} credit card`;

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const redditResults = await searchReddit(`${query} changed OR revised OR discontinued OR devalued`, { limit: 3 });

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const youtubeResults = await searchYouTube(`${query} update`, { maxResults: 3 });

  return {
    id: `${change.issuerSlug}-${slugify(change.cardName)}`,
    cardName: change.cardName,
    issuerName: change.issuerName,
    issuerSlug: change.issuerSlug,
    officialUrl: change.officialUrl,
    productPageUrl: change.url,
    status: change.status,
    detectedAt: change.detectedAt,
    diffHunks: change.diffHunks || [],
    community: {
      reddit: pickFirst(redditResults),
      youtube: pickFirst(youtubeResults)
    }
  };
}
