const ENDPOINT = "https://www.googleapis.com/customsearch/v1";

/**
 * Runs a single Google Programmable Search Engine query and returns a flat
 * list of { title, url, description } results. Returns [] (never throws) if
 * credentials are missing or the request fails, so enrichment can degrade
 * gracefully instead of aborting the whole run.
 */
export async function webSearch(query, { count = 5 } = {}) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) {
    console.warn("  ! GOOGLE_SEARCH_API_KEY/GOOGLE_SEARCH_CX not set, skipping search:", query);
    return [];
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(count, 10)));
  url.searchParams.set("gl", "in");

  try {
    const res = await fetch(url);
    if (res.status === 429) {
      console.warn(`  ! Google search rate-limited (daily quota likely exhausted) for "${query}"`);
      return [];
    }
    if (!res.ok) {
      console.warn(`  ! Google search failed (${res.status}) for "${query}"`);
      return [];
    }

    const data = await res.json();
    return (data.items || []).map((r) => ({
      title: r.title,
      url: r.link,
      description: r.snippet
    }));
  } catch (err) {
    console.warn(`  ! Google search error for "${query}": ${err.message}`);
    return [];
  }
}
