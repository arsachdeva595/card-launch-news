import { createHash } from "node:crypto";

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Strips the parts of a page most likely to change on every load regardless
// of real content edits (scripts, styles, comments, inline SVGs) so the hash
// tracks actual page content rather than cache-busting query strings, CSRF
// tokens, or ever-changing ad/analytics payloads embedded in <script> tags.
function normalizeHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetches a page and returns a content hash suitable for detecting real
 * changes across runs. Returns null (never throws) on failure so a single
 * unreachable page doesn't abort a whole change-detection pass.
 */
export async function fetchContentHash(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const html = await res.text();
    const normalized = normalizeHtml(html);
    return createHash("sha256").update(normalized).digest("hex");
  } catch {
    return null;
  }
}
