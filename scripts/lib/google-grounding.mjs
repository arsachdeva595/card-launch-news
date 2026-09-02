// Second, paid line of grounding for a change summary, tried only after
// the free Reddit RSS check (lib/reddit-grounding.mjs) finds nothing -
// Gemini's Google Search grounding tool is billed per search query, so
// this is a fallback, not a replacement, and stays fully off unless
// GEMINI_API_KEY is configured.
//
// IMPORTANT: this endpoint/request shape is based on Google's current
// public docs (https://ai.google.dev/gemini-api/docs/google-search) for
// the newer "Interactions API" - not live-verified from here, same caveat
// as the NVIDIA integration in lib/llm-summary.mjs. If calls start
// failing or citations never come through, re-check that page for what
// changed and adjust GEMINI_API_URL/the request body/extractCitations()/
// extractCorroboration()
// below - warnIfMappingFailed-style logging is included so that's
// diagnosable rather than silently empty.
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FETCH_TIMEOUT_MS = 20000;

// Hard cap on paid Gemini calls per process run. Reddit's free tier is
// tight enough that a single request can exhaust it for the rest of a run
// (observed live: x-ratelimit-remaining 0 after one call), and GitHub
// Actions runners share IPs across many users/repos - so in the worst
// case, EVERY summarized change in a daily run could fall through to this
// paid fallback, not just an occasional one. This bounds that worst case
// instead of leaving per-run spend unbounded; raise via GEMINI_MAX_CALLS
// if that's intentional for a given run (e.g. a full rescan).
const MAX_CALLS_PER_RUN = Number(process.env.GEMINI_MAX_CALLS) || 20;
let callsThisRun = 0;

function buildPrompt(cardName, issuerName, summary) {
  return `Search the web for recent, independent reporting that corroborates the following claimed change to an Indian credit card. "Independent" means a news article, review site, forum discussion, or the bank's own press release/notification - NOT just the bank's current live product page (that's already the source the claim came from, so it doesn't count as separate corroboration).

Card: "${cardName}" (issuer: ${issuerName})
Claimed change: ${summary}

Only answer true if you find a genuinely independent source discussing this specific change - ideally with a date, so you can judge whether it's about this recent change and not an old, unrelated mention of similar numbers/terms. Answer false if you find nothing independent, or only old/unrelated pages.

Respond with ONLY a single line of JSON, no markdown fences, no other text: {"corroborated": true|false}`;
}

// The model's actual answer (the {"corroborated": true|false} JSON we asked
// for) comes back as a plain string value nested somewhere in the response,
// not as a real nested object - so stringifying the whole response and
// regex-matching would be matching against escaped quotes and silently
// never match. This walks every string value in the response and tries to
// JSON.parse it directly, returning the first `corroborated` boolean found.
function extractCorroboration(data) {
  let found = null;

  function visit(node) {
    if (found !== null) return;
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed.corroborated === "boolean") found = parsed.corroborated;
        } catch {
          // not JSON - just a normal text fragment, ignore
        }
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    Object.values(node).forEach(visit);
  }

  visit(data);
  return found;
}

// Defensive extraction: walks the whole response looking for anything that
// looks like a citation (a url/uri + title pair) rather than assuming one
// fixed field path, since the exact response schema for this endpoint
// hasn't been live-verified against a real account.
function extractCitations(data) {
  const citations = [];
  const seen = new Set();

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const url = node.url || node.uri || node.web?.uri;
    const title = node.title || node.web?.title;
    if (typeof url === "string" && /^https?:\/\//.test(url) && !seen.has(url)) {
      seen.add(url);
      citations.push({ url, title: typeof title === "string" && title ? title : url });
    }
    Object.values(node).forEach(visit);
  }

  visit(data);
  return citations;
}

/**
 * Searches the web via Gemini's Google Search grounding tool for
 * independent corroboration of a card change's summary. Returns the first
 * citation found as { title, url, description } if the model both
 * confirms corroboration AND the response carries at least one real
 * citation (a "true" verdict with zero citations attached isn't trusted),
 * or null otherwise - including on a missing key, a hit MAX_CALLS_PER_RUN
 * cap, or any call/parse error. Never throws - same "boost confidence when
 * found, never block reporting" contract as groundChangeInReddit.
 */
export async function groundChangeInGoogleSearch({ cardName, issuerName, summary }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  if (callsThisRun >= MAX_CALLS_PER_RUN) {
    console.warn(`  ! Gemini grounding call cap (${MAX_CALLS_PER_RUN}) reached this run, skipping for: ${cardName}`);
    return null;
  }
  callsThisRun++;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input: buildPrompt(cardName, issuerName, summary),
        tools: [{ type: "google_search" }]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      console.warn(`  ! Gemini grounding call failed (${res.status}) for ${cardName}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    const citations = extractCitations(data);
    const saysCorroborated = extractCorroboration(data) === true;

    if (!saysCorroborated || citations.length === 0) {
      if (saysCorroborated && citations.length === 0) {
        console.warn(
          `  ! Gemini said corroborated for ${cardName} but no citation URL was found in the response - not trusting it without a source, check extractCitations() against a raw sample: ${JSON.stringify(data).slice(0, 400)}`
        );
      }
      return null;
    }

    return {
      title: citations[0].title,
      url: citations[0].url,
      description: `${citations.length} independent web source(s) found via Google Search grounding`
    };
  } catch (err) {
    console.warn(`  ! Gemini grounding error for ${cardName}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
