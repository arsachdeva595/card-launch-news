import { webSearch } from "./lib/search.mjs";

const PAGE_FETCH_TIMEOUT_MS = 15000;
const BETWEEN_QUERY_DELAY_MS = 200; // light courtesy delay between queries

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchCardName(url, fallback) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": "CardLaunchNewsBot/1.0" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return fallback;

    const html = await res.text();
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (!match) return fallback;

    let title = match[1].replace(/\s+/g, " ").trim();
    // Titles are usually "Card Name | Bank Name" or "Card Name - Apply Now" — keep the first segment.
    title = title.split(/[|–-]/)[0].trim();
    return title || fallback;
  } catch {
    return fallback;
  }
}

function pickFirst(results, { preferHost } = {}) {
  if (!results || results.length === 0) return null;
  if (preferHost) {
    const preferred = results.find((r) => {
      try {
        return new URL(r.url).hostname.includes(preferHost);
      } catch {
        return false;
      }
    });
    if (preferred) return preferred;
  }
  return results[0];
}

/**
 * Given a sitemap-diff candidate, derives a human-readable card name and
 * searches the public web for one announcement post plus reddit/x/youtube
 * community discussion. Never throws — missing pieces are left as null so
 * the frontend can render "not found yet" rather than the whole card
 * disappearing.
 */
export async function enrichCandidate(candidate) {
  const fallbackName = candidate.url
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[-_]/g, " ") || candidate.issuerName;

  const cardName = await fetchCardName(candidate.url, fallbackName);
  const query = `${cardName} credit card`;

  // Quota is precious on Google's free tier (100 queries/day total), so we
  // keep this to 3 queries per candidate: one OR-combined query covers both
  // X and Twitter's legacy domain in a single call.
  await sleep(BETWEEN_QUERY_DELAY_MS);
  const announcementResults = await webSearch(`${query} launch announcement India`, { count: 5 });

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const redditResults = await webSearch(`${query} site:reddit.com`, { count: 3 });

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const xResults = await webSearch(`${query} (site:x.com OR site:twitter.com)`, { count: 3 });

  await sleep(BETWEEN_QUERY_DELAY_MS);
  const youtubeResults = await webSearch(`${query} site:youtube.com`, { count: 3 });

  return {
    id: `${candidate.issuerSlug}-${slugify(cardName)}`,
    cardName,
    issuerName: candidate.issuerName,
    issuerSlug: candidate.issuerSlug,
    officialUrl: candidate.officialUrl,
    productPageUrl: candidate.url,
    discoveredAt: candidate.discoveredAt,
    lastmod: candidate.lastmod,
    announcement: pickFirst(announcementResults, { preferHost: new URL(candidate.officialUrl).hostname }),
    community: {
      reddit: pickFirst(redditResults),
      twitter: pickFirst(xResults),
      youtube: pickFirst(youtubeResults)
    }
  };
}
