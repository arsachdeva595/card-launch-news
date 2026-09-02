// Second, paid line of grounding for a change summary, tried only after
// the free Reddit RSS check (lib/reddit-grounding.mjs) finds nothing -
// Gemini's Google Search grounding tool is billed per search query, so
// this is a fallback, not a replacement, and stays fully off unless
// GEMINI_API_KEY is configured.
//
// This endpoint/request shape and the response parsing below (steps[],
// model_output, url_citation annotations) were live-verified against a
// real account and a real key on 2 Sept 2026 - both the "model answers
// from its own guess, zero search calls made" failure mode and the
// "model actually searches and returns real citations" success mode were
// directly observed, which is what shaped the prompt/parsing design below
// (see buildPrompt's comment). If Google changes this schema later, re-check
// https://ai.google.dev/gemini-api/docs/google-search and adjust
// GEMINI_API_URL/extractCitations()/extractAnswerText() accordingly.
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// A real multi-step interaction (thought -> search call -> search result ->
// model_output) genuinely takes longer than a single-shot completion -
// live-caught during a bulk rescan: 20s was aborting roughly half of all
// calls mid-search, burning through MAX_CALLS_PER_RUN on timeouts instead
// of real answers. 45s gives the search step room to actually finish.
const FETCH_TIMEOUT_MS = 45000;

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

// Framing this as a terse yes/no classification (the original design here)
// turned out to actively discourage the model from invoking the search
// tool at all - live-tested: asked to answer ONLY {"corroborated":
// true|false}, the model answered "true" from its own guess with zero
// search calls made, for a specific real card-fee claim it had no way of
// actually knowing. Rephrasing as an open research question ("search the
// web right now and cite what you find") reliably gets it to actually
// search - live-tested on the same claim, it then made real search calls
// and returned real citations. So this asks an open question and lets
// extractCitations()/textIndicatesNoCorroboration() below judge the
// answer, instead of trusting a self-reported boolean the model can (and
// did) produce without ever looking anything up.
function buildPrompt(cardName, issuerName, summary, detectedAt) {
  const detected = new Date(detectedAt);
  const recencyHint = Number.isNaN(detected.getTime())
    ? ""
    : ` This change was detected around ${detected.toISOString().slice(0, 10)} - only treat a source as corroborating THIS change if it's recent (roughly within the last two months of that date). A source discussing the same card's terms from further back is not evidence of a recent change, even if the numbers happen to match.`;

  return `Search the web right now: has "${issuerName}" recently made this specific change to its "${cardName}" credit card - "${summary}"?${recencyHint}

Find and cite recent, independent sources (news articles, forum posts, review sites, or the bank's own press release/notification) specifically discussing this change - not just the bank's current live product page, since that's already the source the claim came from and doesn't count as independent corroboration.

If you find genuine independent coverage of this specific change, state its date explicitly and summarize what you found. If the only sources you find are old, undated, or you can't confirm this is recent, say so clearly - do not treat an old or undated mention as corroboration of a recent change.`;
}

// A citation being present doesn't by itself mean the model is asserting
// the claim is true - it might have searched, found nothing relevant, and
// still attached whatever citations the search turned up (see the real
// negative-signal example this was tested against: "the search results did
// not contain any information about..."). This catches that so citations
// alone can't manufacture a false "verified".
const NO_CORROBORATION_RE =
  /\b(could not find|couldn't find|did not find|didn't find|no evidence|no reports?|no recent news|no information|could not confirm|couldn't confirm|unable to (find|confirm)|no results?|did not contain any information|not recent|older (article|post|source)|cannot confirm (this|it) is recent|does not appear recent|appears to be (old|outdated|dated)|can(?:not|'t) determine (a |the )?(recent )?date)\b/i;

function textIndicatesNoCorroboration(text) {
  return NO_CORROBORATION_RE.test(text || "");
}

// Backstop for the prompt's recency instruction, which is self-reported
// and not guaranteed to be honored (same reasoning as excludeIssuerDomain
// above): scans the model's answer for explicit full dates (month name +
// day + year - a bare 4-digit year alone is too risky, since a rupee
// amount like "₹2025" would false-positive-match a year pattern). If the
// most recent explicit date found is older than MAX_CITATION_AGE_DAYS
// relative to when the change was detected, the "corroboration" is
// actually about something from before this change happened and doesn't
// count. If no explicit date is found at all, this doesn't reject on its
// own - the citation + no-negative-language checks still apply.
const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
};
const DATE_RE = new RegExp(
  `\\b(?:(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s+(20\\d{2})|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\s*,?\\s+(20\\d{2}))\\b`,
  "gi"
);
const MAX_CITATION_AGE_DAYS = 60;

function extractDatesFromText(text) {
  const dates = [];
  let match;
  DATE_RE.lastIndex = 0;
  while ((match = DATE_RE.exec(text || "")) !== null) {
    const [, monthA, dayA, yearA, dayB, monthB, yearB] = match;
    const month = monthA || monthB;
    const day = dayA || dayB;
    const year = yearA || yearB;
    const monthIdx = MONTH_INDEX[month.toLowerCase()];
    if (monthIdx === undefined) continue;
    const parsed = new Date(Date.UTC(Number(year), monthIdx, Number(day)));
    if (!Number.isNaN(parsed.getTime())) dates.push(parsed);
  }
  return dates;
}

function onlyMentionsStaleDates(text, detectedAt) {
  const detected = new Date(detectedAt);
  if (Number.isNaN(detected.getTime())) return false;

  const dates = extractDatesFromText(text);
  if (dates.length === 0) return false;

  const mostRecent = new Date(Math.max(...dates.map((d) => d.getTime())));
  const ageMs = detected.getTime() - mostRecent.getTime();
  return ageMs > MAX_CITATION_AGE_DAYS * 24 * 60 * 60 * 1000;
}

// Pulls every model_output text block out of the response (there can be
// more than one across a multi-step interaction) and concatenates them,
// so textIndicatesNoCorroboration() sees the model's actual answer instead
// of the whole response blob (which would also contain thought-step
// signatures and the raw search-suggestions HTML widget).
function extractAnswerText(data) {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  return steps
    .filter((s) => s.type === "model_output")
    .flatMap((s) => (Array.isArray(s.content) ? s.content : []))
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
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

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// The prompt tells the model the issuer's own current product page doesn't
// count as independent corroboration, but that's a self-reported
// instruction, not enforced - live-caught: it returned axis.bank.in as its
// top citation for an Axis card claim, which is exactly the "just the
// source the claim came from" case the whole point of this fallback is to
// rule out. Filters citations against the issuer's own domain in code
// instead of trusting the model to have honored the instruction.
//
// The citation `url` field is always a Google grounding-redirect proxy
// link (vertexaisearch.cloud.google.com/...), never the real source URL,
// so domainOf(c.url) is useless for this comparison - `title` is the only
// field that actually carries the source's real domain name (e.g.
// "axis.bank.in", "ndtvprofit.com") in this API's observed response shape.
function excludeIssuerDomain(citations, officialUrl) {
  const issuerDomain = domainOf(officialUrl);
  if (!issuerDomain) return citations;
  return citations.filter((c) => {
    const citedDomain = c.title.toLowerCase();
    return !citedDomain.includes(issuerDomain) && !issuerDomain.includes(citedDomain);
  });
}

/**
 * Searches the web via Gemini's Google Search grounding tool for
 * independent corroboration of a card change's summary. Returns the first
 * citation found as { title, url, description } if the model's answer
 * carries at least one real citation, doesn't itself say it found nothing
 * (see textIndicatesNoCorroboration - citations can be present even on a
 * "found nothing" answer), and doesn't only cite dates older than
 * MAX_CITATION_AGE_DAYS relative to `detectedAt` (see onlyMentionsStaleDates
 * - a source about the same card's terms from years back isn't evidence of
 * a recent change), or null otherwise - including on a missing key, a hit
 * MAX_CALLS_PER_RUN cap, or any call/parse error. Never throws - same
 * "boost confidence when found, never block reporting" contract as
 * groundChangeInReddit.
 */
export async function groundChangeInGoogleSearch({ cardName, issuerName, summary, officialUrl, detectedAt }) {
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
        input: buildPrompt(cardName, issuerName, summary, detectedAt),
        tools: [{ type: "google_search" }]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      console.warn(`  ! Gemini grounding call failed (${res.status}) for ${cardName}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    const citations = excludeIssuerDomain(extractCitations(data), officialUrl);
    const answerText = extractAnswerText(data);

    if (citations.length === 0 || textIndicatesNoCorroboration(answerText) || onlyMentionsStaleDates(answerText, detectedAt)) {
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
