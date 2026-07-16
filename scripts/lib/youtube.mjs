import { runActorSync, warnIfMappingFailed } from "./apify.mjs";

// streamers/youtube-scraper: keyword-search based. Override via
// APIFY_YOUTUBE_ACTOR_ID if you're using a different actor.
const YOUTUBE_ACTOR_ID = process.env.APIFY_YOUTUBE_ACTOR_ID || "streamers~youtube-scraper";

/**
 * Searches YouTube via an Apify actor and returns a flat list of
 * { title, url, description }. Returns [] (never throws) if the token is
 * missing, the actor fails, or its output doesn't map to anything usable.
 */
export async function searchYouTube(query, { maxResults = 3 } = {}) {
  const items = await runActorSync(YOUTUBE_ACTOR_ID, {
    searchQueries: [query],
    maxResults,
    maxResultsShorts: 0,
    maxResultStreams: 0
  });

  const results = items
    .map((item) => ({
      title: item.title,
      url: item.url || (item.id ? `https://www.youtube.com/watch?v=${item.id}` : undefined),
      description: item.description || item.text || ""
    }))
    .filter((r) => r.url)
    .slice(0, maxResults);

  warnIfMappingFailed("YouTube", items, results);
  return results;
}
