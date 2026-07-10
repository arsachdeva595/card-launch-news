const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a single Brave web search query and returns a flat list of
 * { title, url, description } results. Returns [] (never throws) if the API
 * key is missing or the request fails, so enrichment can degrade gracefully
 * instead of aborting the whole run.
 */
export async function braveSearch(query, { count = 5, retries = 2 } = {}) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    console.warn("  ! BRAVE_API_KEY not set, skipping search:", query);
    return [];
  }

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("country", "in");
  url.searchParams.set("search_lang", "en");

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey
        }
      });

      if (res.status === 429) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        console.warn(`  ! Brave search failed (${res.status}) for "${query}"`);
        return [];
      }

      const data = await res.json();
      return (data.web?.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description
      }));
    } catch (err) {
      console.warn(`  ! Brave search error for "${query}": ${err.message}`);
      return [];
    }
  }

  console.warn(`  ! Brave search rate-limited repeatedly for "${query}", giving up`);
  return [];
}
