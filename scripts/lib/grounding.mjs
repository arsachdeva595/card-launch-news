import { groundChangeInReddit } from "./reddit-grounding.mjs";
import { groundChangeInGoogleSearch } from "./google-grounding.mjs";

/**
 * Tries to independently corroborate a change's AI-written summary -
 * Reddit's free search.rss first, then Gemini's paid Google Search
 * grounding only if Reddit found nothing (see lib/google-grounding.mjs for
 * why it's a fallback, not run in parallel). `detectedAt` (the change's own
 * detection timestamp) is required for both sources to reject stale
 * "corroboration" that's actually about an old, unrelated instance of the
 * same card/terms rather than this recent change - see MAX_POST_AGE_DAYS
 * in lib/reddit-grounding.mjs and MAX_CITATION_AGE_DAYS in
 * lib/google-grounding.mjs. Returns
 * { source: {title,url,description}, via: "reddit" | "google" } if either
 * found something, or null if neither did (including if GEMINI_API_KEY
 * isn't configured, in which case this is just the Reddit check).
 */
export async function groundChange({ cardName, issuerName, summary, officialUrl, detectedAt }) {
  const redditMatch = await groundChangeInReddit({ cardName, summary, detectedAt });
  if (redditMatch) return { source: redditMatch, via: "reddit" };

  const googleMatch = await groundChangeInGoogleSearch({ cardName, issuerName, summary, officialUrl, detectedAt });
  if (googleMatch) return { source: googleMatch, via: "google" };

  return null;
}
