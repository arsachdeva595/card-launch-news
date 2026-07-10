const PAGE_FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Fetches a page and derives a human-readable card name from its <title>.
 * Falls back to a slug derived from the URL path if the fetch/parse fails.
 */
export async function fetchCardName(url, fallback) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
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

export function fallbackNameFromUrl(url, issuerName) {
  return (
    url
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/[-_]/g, " ") || issuerName
  );
}
