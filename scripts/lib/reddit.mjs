const USER_AGENT = "web:card-launch-news:v1.0 (by /u/card_launch_news_bot)";

let cachedToken = null;
let tokenExpiresAt = 0;

// Reddit's anonymous `old.reddit.com/*.json` endpoints are increasingly
// rate-limited/blocked for scripted access. A registered "script" app using
// the client_credentials grant is Reddit's current supported free path for
// low-volume read-only access (the 2023 pricing changes targeted high-volume
// third-party apps, not this).
async function getAccessToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT
      },
      body: "grant_type=client_credentials"
    });
    if (!res.ok) {
      console.warn(`  ! Reddit auth failed (${res.status})`);
      return null;
    }
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000;
    return cachedToken;
  } catch (err) {
    console.warn(`  ! Reddit auth error: ${err.message}`);
    return null;
  }
}

/**
 * Searches Reddit via the official OAuth API and returns a flat list of
 * { title, url, description }. Returns [] (never throws) if credentials are
 * missing or the request fails.
 */
export async function searchReddit(query, { limit = 3 } = {}) {
  const token = await getAccessToken();
  if (!token) {
    console.warn("  ! Reddit credentials not set/invalid, skipping search:", query);
    return [];
  }

  try {
    const url = new URL("https://oauth.reddit.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "relevance");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT }
    });
    if (!res.ok) {
      console.warn(`  ! Reddit search failed (${res.status}) for "${query}"`);
      return [];
    }

    const data = await res.json();
    return (data.data?.children || []).map((c) => ({
      title: c.data.title,
      url: `https://www.reddit.com${c.data.permalink}`,
      description: c.data.selftext ? c.data.selftext.slice(0, 200) : `r/${c.data.subreddit}`
    }));
  } catch (err) {
    console.warn(`  ! Reddit search error for "${query}": ${err.message}`);
    return [];
  }
}
