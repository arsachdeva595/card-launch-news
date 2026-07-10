import { searchReddit } from "./lib/reddit.mjs";
import { searchYouTube } from "./lib/youtube.mjs";
import { fetchCardName, fallbackNameFromUrl, slugify } from "./lib/page-meta.mjs";

const BETWEEN_QUERY_DELAY_MS = 200; // light courtesy delay between queries

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickFirst(results) {
  return results && results.length > 0 ? results[0] : null;
}

/**
 * Given a sitemap-diff candidate, derives a human-readable card name and
 * looks for Reddit/YouTube community discussion. No general web-search API
 * is reliably free right now (Brave needs billing, Google's Custom Search is
 * being locked down for new Cloud orgs) - the card's own official page is
 * itself a legitimate public announcement of the launch, so that's used
 * directly instead of searching for third-party coverage. X/Twitter has no
 * viable free search API, so it's always left null. Never throws — missing
 * pieces are left as null so the frontend can render "not found"/"not
 * available" rather than the whole card disappearing.
 */
export async function enrichCandidate(candidate) {
  const fallbackName = fallbackNameFromUrl(candidate.url, candidate.issuerName);
  const cardName = await fetchCardName(candidate.url, fallbackName);
  const query = `${cardName} credit card`;

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const redditResults = await searchReddit(`${query} launch`, { limit: 3 });

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const youtubeResults = await searchYouTube(`${query} review`, { maxResults: 3 });

  return {
    id: `${candidate.issuerSlug}-${slugify(cardName)}`,
    cardName,
    issuerName: candidate.issuerName,
    issuerSlug: candidate.issuerSlug,
    officialUrl: candidate.officialUrl,
    productPageUrl: candidate.url,
    discoveredAt: candidate.discoveredAt,
    lastmod: candidate.lastmod,
    announcement: {
      title: cardName,
      url: candidate.url,
      description: `Official product page on ${candidate.issuerName}'s site.`
    },
    community: {
      reddit: pickFirst(redditResults),
      twitter: null, // no free API path for X/Twitter search currently
      youtube: pickFirst(youtubeResults)
    }
  };
}
