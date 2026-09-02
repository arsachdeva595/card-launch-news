// Summarizes a large (multi-month) diff for the historical backfill feature
// (see backfill-history.mjs). Distinct from lib/llm-summary.mjs, which
// judges a small day-to-day diff as real-vs-noise and returns one sentence -
// a several-month-old diff commonly bundles multiple real changes at once
// (a fee revision *and* a new benefit *and* a reward-rate change), so this
// asks for a short bullet list instead of forcing everything into one line,
// and never suppresses as "noise" - the diff is always shown, this only
// controls the written summary above it.
const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = process.env.NVIDIA_LLM_MODEL || "openai/gpt-oss-20b";
const NO_CHANGE_LINE = "No material change detected.";

function buildPrompt(cardName, issuerName, diffText) {
  return `You are comparing an Indian bank credit card's webpage from two points in time: an older archived snapshot, and today's live version.

Card: "${cardName}" (issuer: ${issuerName})

Diff (+ = line present today but not in the old snapshot; - = line present in the old snapshot but not today; unmarked context lines are omitted):
${diffText}

List what materially changed for this specific card - fees, interest rates, reward rates, welcome/joining benefits, eligibility, lounge/travel benefits, or availability status (e.g. discontinued). Ignore navigation links, "related products"/cross-sell widgets, live view/interest counters, cookie banners, promotional banner rotations, accessibility controls, or other page chrome unrelated to this card's own terms.

Name the specific fee/charge in each bullet - never write a vague "fee structure changed" or "fees changed" bullet. A card has several distinct fees (annual fee, joining fee, renewal fee, late payment/overdue payment fee, foreign currency/forex markup, cash advance fee, etc.) and confusing one for another is misleading. In particular, a fee that only applies when a payment is late or overdue (sometimes phrased as "late payment fee", "overdue payment charge", "penalty charge", or a Minimum Amount Due/MAD-linked charge) must be explicitly called a late payment/overdue fee, not folded into a generic "fee" mention - it does not change what the card costs to hold or use normally, only what a missed/late payment costs.

Respond with ONLY:
- Up to 4 short bullet points (each on its own line starting with "- "), each under 20 words, if there are real changes.
- The exact line "${NO_CHANGE_LINE}" if none of the above changed.

No other text, no markdown headers, no explanation.`;
}

/**
 * Returns a bullet-point summary string (or the NO_CHANGE_LINE sentinel), or
 * null if NVIDIA_API_KEY isn't set, the diff is empty, or the call
 * failed/errored - callers should treat null as "unknown, summary
 * unavailable" and still keep the raw diff, not treat it as no change.
 */
export async function summarizeBackfillDiff({ cardName, issuerName, diffHunks }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;

  const diffText = (diffHunks || [])
    .filter((h) => h.type === "added" || h.type === "removed")
    .map((h) => `${h.type === "added" ? "+" : "-"} ${h.text}`)
    .join("\n")
    .slice(0, 10000);

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
        max_tokens: 450,
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
      console.warn(`  ! NVIDIA LLM returned empty content for ${cardName} - skipping summary`);
      return null;
    }
    return reply;
  } catch (err) {
    console.warn(`  ! NVIDIA LLM error for ${cardName}: ${err.message}`);
    return null;
  }
}

export { NO_CHANGE_LINE };
