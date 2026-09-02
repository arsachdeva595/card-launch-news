import { groundChangeInReddit } from "./reddit-grounding.mjs";
import { groundChangeInGoogleSearch } from "./google-grounding.mjs";

/**
 * Tries to independently corroborate a change's AI-written summary -
 * Reddit's free search.rss first, then Gemini's paid Google Search
 * grounding only if Reddit found nothing (see lib/google-grounding.mjs for
 * why it's a fallback, not run in parallel). Returns
 * { source: {title,url,description}, via: "reddit" | "google" } if either
 * found something, or null if neither did (including if GEMINI_API_KEY
 * isn't configured, in which case this is just the Reddit check).
 */
export async function groundChange({ cardName, issuerName, summary }) {
  const redditMatch = await groundChangeInReddit({ cardName, summary });
  if (redditMatch) return { source: redditMatch, via: "reddit" };

  const googleMatch = await groundChangeInGoogleSearch({ cardName, issuerName, summary });
  if (googleMatch) return { source: googleMatch, via: "google" };

  return null;
}
