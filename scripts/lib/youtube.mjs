const ENDPOINT = "https://www.googleapis.com/youtube/v3/search";

/**
 * Searches YouTube via the Data API v3 (a separate product from Custom
 * Search JSON API, unaffected by its new-org restriction) and returns a flat
 * list of { title, url, description }. Returns [] (never throws) if the key
 * is missing or the request fails.
 */
export async function searchYouTube(query, { maxResults = 3 } = {}) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.warn("  ! YOUTUBE_API_KEY not set, skipping search:", query);
    return [];
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("regionCode", "IN");

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ! YouTube search failed (${res.status}) for "${query}"`);
      return [];
    }

    const data = await res.json();
    return (data.items || [])
      .filter((item) => item.id?.videoId)
      .map((item) => ({
        title: item.snippet?.title,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        description: item.snippet?.description
      }));
  } catch (err) {
    console.warn(`  ! YouTube search error for "${query}": ${err.message}`);
    return [];
  }
}
