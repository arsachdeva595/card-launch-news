// NVIDIA's build.nvidia.com API catalog exposes an OpenAI-compatible
// /v1/chat/completions endpoint for hosted models like openai/gpt-oss-20b.
// This endpoint URL/format is based on public NVIDIA API documentation, not
// live-verified from here - same caveat as the Apify integration elsewhere
// in this project. If summaries never come through despite a valid
// NVIDIA_API_KEY, check this against console.nvidia.com's current API
// reference and adjust NVIDIA_API_URL/model name below.
const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = process.env.NVIDIA_LLM_MODEL || "openai/gpt-oss-20b";
const NOISE_SENTINEL = "NOISE";

function buildPrompt(cardName, issuerName, diffText) {
  return `You are reviewing a text diff from an Indian bank's credit card webpage to decide if it represents a genuine change to that specific card, or unrelated noise.

Card: "${cardName}" (issuer: ${issuerName})

Diff (+ = line added, - = line removed; unmarked context lines are omitted):
${diffText}

This is REAL if it changes the card's own fees, interest rates, reward rates, welcome/joining benefits, eligibility, lounge/travel benefits, or availability status (e.g. discontinued).

This is NOISE if it's navigation links, a "related products"/cross-sell widget (especially one advertising a *different* card), live view/interest counters, cookie banners, promotional banner rotations, accessibility controls, or other page chrome unrelated to this card's own terms.

Respond with ONLY ONE of:
- A single short sentence (under 25 words) stating exactly what changed, if REAL.
- The single word ${NOISE_SENTINEL}, if this is noise.

No other text, no explanation, no markdown.`;
}

/**
 * Classifies a detected change as real or noise using an LLM, and if real,
 * returns a one-line summary of what changed. Returns:
 * - { summary: string } if the LLM judges it a genuine card change
 * - { noise: true } if the LLM confidently judges it noise (caller should
 *   suppress reporting this change)
 * - null if NVIDIA_API_KEY isn't set, the diff is empty, or the call
 *   failed/errored - callers should treat this as "unknown" and fall back
 *   to reporting the change without a summary, NOT as noise, so the whole
 *   change-detection feature doesn't go silent just because this one
 *   optional integration is unconfigured or briefly unavailable.
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
        max_tokens: 350,
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

    if (reply.toUpperCase().includes(NOISE_SENTINEL) && reply.length < NOISE_SENTINEL.length + 10) {
      return { noise: true };
    }
    return { summary: reply };
  } catch (err) {
    console.warn(`  ! NVIDIA LLM error for ${cardName}: ${err.message}`);
    return null;
  }
}
