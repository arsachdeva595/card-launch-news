// NVIDIA's build.nvidia.com API catalog exposes an OpenAI-compatible
// /v1/chat/completions endpoint for hosted models like openai/gpt-oss-20b.
// This endpoint URL/format is based on public NVIDIA API documentation, not
// live-verified from here - same caveat as the Apify integration elsewhere
// in this project. If summaries never come through despite a valid
// NVIDIA_API_KEY, check this against console.nvidia.com's current API
// reference and adjust NVIDIA_API_URL/model name below.
const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = process.env.NVIDIA_LLM_MODEL || "openai/gpt-oss-20b";

function buildPrompt(cardName, issuerName, diffText) {
  return `You are reviewing a text diff from an Indian bank's credit card webpage to decide if it represents a genuine change to that specific card, or unrelated noise.

Card: "${cardName}" (issuer: ${issuerName})

Diff (+ = line added/now present, - = line removed/no longer present; unmarked context lines are omitted):
${diffText}

Rules:
1. Judge REAL only if this changes the card's own fees, interest rates, reward rates, welcome/joining benefits, eligibility, lounge/travel benefits, or availability status (e.g. discontinued).
2. Judge NOISE if it's navigation links, a "related products"/cross-sell widget (especially one advertising a *different* card), live view/interest counters, cookie banners, promotional banner rotations, accessibility controls, or other page chrome unrelated to this card's own terms.
3. Direction is easy to get backwards - check it twice. A "+" line is text that is now on the page and was NOT there before (something gained/present). A "-" line is text that WAS on the page and is now gone (something lost/absent). If a benefit's description appears only in a "-" line, that benefit was REMOVED - never describe a "-" line as an addition, and never describe a "+" line as a removal.
4. Never state a number, percentage, or date that does not appear verbatim, character-for-character, in the diff lines above. Do not "correct" a figure using what you recall about this card from general knowledge, and do not fill in a number that isn't actually in the diff text - if you can't find the specific new value in the diff itself, describe the change qualitatively instead of guessing.
5. "quote" must be an exact, verbatim substring (max ~15 words) copied directly from one of the diff lines above (the text itself, not the +/- marker) that most directly supports your summary. Do not paraphrase it - copy it exactly as written, including any typos in the source page.

Respond with ONLY a single line of JSON, no markdown code fences, no other text:
- If REAL: {"verdict":"REAL","direction":"added"|"removed"|"modified","summary":"<one short sentence, under 25 words>","quote":"<verbatim excerpt from a diff line above>"}
- If NOISE: {"verdict":"NOISE"}`;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseJsonReply(reply) {
  // Strip ```json ... ``` fences some models wrap replies in despite being
  // told not to, and grab the first {...} blob as a fallback if there's any
  // stray text around it.
  const stripped = reply.replace(/```(?:json)?/gi, "").trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : stripped;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// Cross-checks the LLM's claimed quote/direction against the actual diff
// hunks (not just the flattened diffText it was prompted with) - this is
// what catches a model stating a benefit was "added" when the matching line
// was actually a "-" (removed) line, or inventing a quote that isn't in the
// diff at all. Returns true only if the quote is found verbatim in a hunk
// whose type is consistent with the claimed direction.
function isGroundedInDiff(quote, direction, diffHunks) {
  const normQuote = normalize(quote);
  if (!normQuote) return false;

  const relevantTypes =
    direction === "added" ? ["added"] : direction === "removed" ? ["removed"] : ["added", "removed"];

  return (diffHunks || []).some(
    (hunk) => relevantTypes.includes(hunk.type) && normalize(hunk.text).includes(normQuote)
  );
}

/**
 * Classifies a detected change as real or noise using an LLM, and if real,
 * returns a one-line summary of what changed. Returns:
 * - { summary: string } if the LLM judges it a genuine card change AND its
 *   claimed quote/direction check out against the actual diff hunks
 * - { noise: true } if the LLM confidently judges it noise (caller should
 *   suppress reporting this change)
 * - null if NVIDIA_API_KEY isn't set, the diff is empty, the call
 *   failed/errored, the reply didn't parse, or the LLM's claim didn't
 *   ground in the diff (e.g. direction mismatch, fabricated quote) -
 *   callers should treat this as "unknown" and fall back to reporting the
 *   change without a summary, NOT as noise, so the whole change-detection
 *   feature doesn't go silent just because this one optional integration is
 *   unconfigured, briefly unavailable, or produced an untrustworthy answer.
 */
export async function summarizeChange({ cardName, issuerName, diffHunks }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.warn(`  ! NVIDIA_API_KEY not set, skipping LLM summary for: ${cardName}`);
    return null;
  }

  const diffText = (diffHunks || [])
    .filter((h) => h.type === "added" || h.type === "removed")
    .map((h) => `${h.type === "added" ? "+" : "-"} ${h.text}`)
    .join("\n")
    .slice(0, 6000); // keep the prompt bounded regardless of how large a diff is

  if (!diffText.trim()) return null;

  try {
    const res = await fetch(NVIDIA_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: buildPrompt(cardName, issuerName, diffText) }],
        temperature: 0.1,
        max_tokens: 400,
        // gpt-oss-20b is a reasoning model that spends tokens on an internal
        // "reasoning" field before the final answer - without this, a low
        // max_tokens budget gets consumed entirely by reasoning (finish_reason
        // "length", empty content) for anything but the simplest diffs. This
        // task doesn't need deep reasoning, just classification.
        reasoning_effort: "low"
      })
    });

    if (!res.ok) {
      console.warn(`  ! NVIDIA LLM call failed (${res.status}) for ${cardName}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.warn(
        `  ! NVIDIA LLM returned empty content for ${cardName} (finish_reason: ${data.choices?.[0]?.finish_reason}) - skipping summary`
      );
      return null;
    }

    const parsed = parseJsonReply(reply);
    if (!parsed || typeof parsed.verdict !== "string") {
      console.warn(`  ! NVIDIA LLM reply for ${cardName} wasn't valid JSON, skipping summary: ${reply.slice(0, 200)}`);
      return null;
    }

    if (parsed.verdict.toUpperCase() === "NOISE") {
      return { noise: true };
    }

    if (parsed.verdict.toUpperCase() !== "REAL" || !parsed.summary) {
      console.warn(`  ! NVIDIA LLM reply for ${cardName} had unexpected shape, skipping summary: ${reply.slice(0, 200)}`);
      return null;
    }

    if (!isGroundedInDiff(parsed.quote, parsed.direction, diffHunks)) {
      console.warn(
        `  ! NVIDIA LLM summary for ${cardName} didn't ground in the diff (direction: ${parsed.direction}, quote: "${String(parsed.quote || "").slice(0, 80)}") - skipping summary, reporting diff only`
      );
      return null;
    }

    return { summary: parsed.summary };
  } catch (err) {
    console.warn(`  ! NVIDIA LLM error for ${cardName}: ${err.message}`);
    return null;
  }
}
