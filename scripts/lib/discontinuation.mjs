// Deterministic keyword check for a card being discontinued, kept separate
// from the optional LLM summary/noise step so config/tracked-cards.json's
// `status` field stays in sync with reality even when NVIDIA_API_KEY isn't
// configured. Only checks *added* lines (not removed/context) - a real
// discontinuation notice is new text appearing on the page, not text that
// happened to already be there.
const DISCONTINUATION_PATTERNS = [
  /\bhas been discontinued\b/i,
  /\bis (?:now )?discontinued\b/i,
  /\bcard has been withdrawn\b/i,
  /\bno longer (?:available|offered|issued)\b/i,
  /\bwe have discontinued\b/i,
  /\bnot accepting (?:new )?applications\b/i,
  /\bwithdrawn from (?:sale|issuance)\b/i,
  /\bceased to (?:offer|issue)\b/i
];

export function detectsDiscontinuation(diffHunks) {
  return (diffHunks || []).some(
    (hunk) => hunk.type === "added" && DISCONTINUATION_PATTERNS.some((pattern) => pattern.test(hunk.text))
  );
}
