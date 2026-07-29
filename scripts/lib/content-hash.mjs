import { createHash } from "node:crypto";

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const HTML_ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'"
};

// Lines matching these are inherently volatile - different on every single
// fetch regardless of any real content change (a live view-counter widget, an
// auto-ticking "last updated" stamp) - so they're dropped entirely rather
// than hashed/diffed. Unlike the reordering fix (order-insensitive hashing),
// no amount of sorting fixes this: the *value* itself differs each time.
const VOLATILE_LINE_PATTERNS = [
  /^[\d,.]+k?\+?\s+views?$/i,
  /^last\s+updated\s+on\s*:?\s*\d{1,2}[\s\-\/]\w+[\s\-\/]\d{2,4}$/i
];

function isVolatileLine(line) {
  return VOLATILE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

// Reduces a page down to its visible text, one line per block-level element,
// so that (a) hashing ignores markup/class-name churn that doesn't affect
// what a visitor actually sees, and (b) the result is meaningful to diff and
// display, unlike raw tag soup.
function extractVisibleText(html) {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(replacement);
  }

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isVolatileLine(line))
    .join("\n");
}

/**
 * Fetches a page and returns its extracted visible text (still in original
 * order). Returns null (never throws) on failure so a single unreachable
 * page doesn't abort a whole change-detection pass. Hashing is a separate
 * step (see hashText) - deferred so callers can strip cross-page boilerplate
 * (shared header/footer/nav/cookie-banner content) first, computed by
 * comparing several pages from the same issuer.
 */
export async function fetchPageText(url) {
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
    return extractVisibleText(html);
  } catch {
    return null;
  }
}

/**
 * Hashes a *sorted* copy of the text's lines, not their original order.
 * Several issuer pages embed a "related products" carousel/widget that
 * renders in a different order on every request with otherwise identical
 * content (observed on HDFC's card pages) - hashing original order flags
 * that as a change every time. Sorting first makes the hash insensitive to
 * pure reordering while still changing normally when content is genuinely
 * added, removed, or edited.
 */
export function hashText(text) {
  const sortedLines = text.split("\n").sort();
  return createHash("sha256").update(sortedLines.join("\n")).digest("hex");
}
