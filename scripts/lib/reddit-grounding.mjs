// Second line of defense for change summaries, independent of the LLM
// prompt/quote-grounding checks in lib/llm-summary.mjs: even a summary that
// accurately reflects the diff can be wrong if the *source page itself* has
// bad copy (e.g. a bank's own FAQ stating a stale/incorrect fee). No amount
// of prompt engineering against the diff catches that - the diff is telling
// the truth about what the page now says, the page is just wrong. So a
// summary only gets shown as a confident claim once independent discussion
// of the same change turns up on r/CreditCardsIndia; otherwise the change is
// still reported (with its full diff, as always), just without the
// unverified summary presented as fact - see README's "Two-pronged change
// accuracy" section.
//
// Uses Reddit's public search RSS feed rather than the Apify-based
// searchReddit() in lib/reddit.mjs (used elsewhere for community links) -
// RSS search needs no API key/Apify credit, so this accuracy check can never
// be starved by Apify usage limits, and stays on even if APIFY_TOKEN isn't
// configured at all.
const SUBREDDIT = "CreditCardsIndia";
const USER_AGENT = "card-launch-news-grounding/1.0 (+https://github.com/arsachdeva595/card-launch-news)";
const FETCH_TIMEOUT_MS = 15000;
const MAX_DESCRIPTION_LENGTH = 240;

// Reddit's unauthenticated search.rss is rate-limited tightly enough that a
// single request can exhaust the bucket (observed: x-ratelimit-remaining: 0
// after one call, ~45s reset). A run can have many change candidates with a
// summary to ground in sequence, and hammering a 429'd endpoint for each one
// just burns the run's time without ever succeeding - so once a 429 is seen,
// stop attempting further grounding calls for the rest of this process and
// fall back to "unverified" immediately instead of refetching.
let rateLimitedUntil = 0;

// Common words too generic to count as a meaningful keyword match on their
// own (a post mentioning "the card fee" shouldn't count as corroborating
// anything - only specific figures/terms should).
const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "for", "on", "in", "with", "and", "or", "is",
  "are", "was", "were", "this", "that", "card", "credit", "now", "has",
  "have", "been", "from", "per", "will", "be", "its", "your", "you", "as",
  "at", "by", "not", "no", "new", "than", "into", "annual", "fee", "fees"
]);

function stripHtml(html) {
  // Reddit's Atom <content> is HTML-entity-encoded (e.g. "&lt;p&gt;text&lt;/p&gt;"),
  // so entities have to be decoded BEFORE the tag-stripping regex runs, or
  // the tags survive decoding as literal "<p>" text with nothing left to
  // strip them.
  return String(html || "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Minimal Atom-feed entry extraction (Reddit's search.rss is Atom, not
// RSS2, despite the .rss extension) - same regex-block style as
// lib/sitemap.mjs, no XML parser dependency needed for a feed this simple.
function extractEntries(xml) {
  const blockRe = /<entry>([\s\S]*?)<\/entry>/gi;
  const entries = [];
  let match;
  while ((match = blockRe.exec(xml)) !== null) {
    const block = match[1];
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block) || [])[1];
    const content = (/<content[^>]*>([\s\S]*?)<\/content>/i.exec(block) || [])[1];
    const link = (/<link[^>]*href="([^"]*)"/i.exec(block) || [])[1];
    if (!link) continue;
    entries.push({ title: stripHtml(title), content: stripHtml(content), url: link });
  }
  return entries;
}

// Pulls out the specific, distinctive words/numbers from a summary that
// would only show up in a post actually discussing this exact change - not
// generic card-review vocabulary. Numeric tokens need at least 3 digits to
// count - a bare "1" or "20" is not distinctive of anything and matches
// almost any post by chance (live-caught false positive: a summary
// mentioning "Rs.1,200" produced the keyword "1", which then substring-
// matched an unrelated post about ₹2,000/₹1,900 utility bill spending that
// had nothing to do with the actual change).
function extractKeywords(text) {
  const tokens = String(text || "").toLowerCase().match(/[a-z0-9]+%?/g) || [];
  return [...new Set(tokens.filter((t) => (/^\d+%?$/.test(t) && t.replace("%", "").length >= 3) || (t.length >= 5 && !STOPWORDS.has(t))))];
}

// Word-boundary match instead of a plain substring check - otherwise a
// keyword like "200" would match inside an unrelated "2000" or "1200 lakh"
// mentioned in a post about something else entirely.
function containsKeyword(haystack, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

async function fetchRss(query) {
  const url = `https://www.reddit.com/r/${SUBREDDIT}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=on&sort=new&limit=15&t=year`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml,application/xml,text/xml,*/*" },
      signal: controller.signal
    });
    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get("retry-after")) || 60;
      const err = new Error(`HTTP 429`);
      err.retryAfterMs = retryAfterSec * 1000;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Searches r/CreditCardsIndia for independent corroboration of a card
 * change's LLM-written summary. Returns the best-matching post as
 * { title, url, description } if at least a couple of the summary's
 * distinctive keywords (a fee figure, a benefit name, etc.) also show up in
 * a real post about this card, or null if nothing corroborating turns up
 * (including on any fetch/parse error - this is a "boost confidence when
 * found" signal, not a hard dependency, so a Reddit hiccup should never
 * itself suppress a change from being reported).
 */
export async function groundChangeInReddit({ cardName, summary }) {
  const keywords = extractKeywords(summary);
  if (keywords.length === 0) return null;

  if (Date.now() < rateLimitedUntil) return null;

  try {
    const xml = await fetchRss(`"${cardName}"`);
    const entries = extractEntries(xml);
    if (entries.length === 0) return null;

    const required = keywords.length === 1 ? 1 : 2;
    let best = null;
    let bestScore = 0;

    for (const entry of entries) {
      const haystack = `${entry.title} ${entry.content}`.toLowerCase();
      const score = keywords.reduce((count, kw) => count + (containsKeyword(haystack, kw) ? 1 : 0), 0);
      if (score >= required && score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }

    if (!best) return null;
    return {
      title: best.title || best.url,
      url: best.url,
      description: best.content.slice(0, MAX_DESCRIPTION_LENGTH)
    };
  } catch (err) {
    if (err.retryAfterMs) {
      rateLimitedUntil = Date.now() + err.retryAfterMs;
      console.warn(
        `  ! Reddit grounding rate-limited, backing off for the rest of this run (retry after ~${Math.round(err.retryAfterMs / 1000)}s)`
      );
    } else {
      console.warn(`  ! Reddit grounding check failed for "${cardName}": ${err.message}`);
    }
    return null;
  }
}
