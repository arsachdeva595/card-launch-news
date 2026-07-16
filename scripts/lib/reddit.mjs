import { runActorSync, warnIfMappingFailed } from "./apify.mjs";

// trudax/reddit-scraper-lite: keyword-search based, no Reddit login required.
// Override via APIFY_REDDIT_ACTOR_ID if you're using a different actor.
const REDDIT_ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || "trudax~reddit-scraper-lite";

/**
 * Searches Reddit via an Apify actor and returns a flat list of
 * { title, url, description }. Returns [] (never throws) if the token is
 * missing, the actor fails, or its output doesn't map to anything usable.
 */
export async function searchReddit(query, { limit = 3 } = {}) {
  const items = await runActorSync(REDDIT_ACTOR_ID, {
    searches: [query],
    maxItems: limit,
    searchPosts: true,
    searchComments: false,
    searchCommunities: false,
    searchUsers: false
  });

  const results = items
    .map((item) => ({
      title: item.title || item.name,
      url: item.url || item.postUrl || item.link,
      description: item.body || item.text || item.description || ""
    }))
    .filter((r) => r.url)
    .slice(0, limit);

  warnIfMappingFailed("Reddit", items, results);
  return results;
}
