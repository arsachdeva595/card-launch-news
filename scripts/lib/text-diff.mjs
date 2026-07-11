const MAX_DP_CELLS = 500_000; // guard against pathological O(n*m) blowup on huge pages

/**
 * Classic LCS-backtrack line diff. Returns an array of
 * { type: 'context' | 'added' | 'removed', text } covering every line of
 * both inputs in order. Returns null if the inputs are too large to diff
 * cheaply (caller should fall back to "content changed significantly").
 */
export function diffLines(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > MAX_DP_CELLS) return null;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "context", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "removed", text: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "added", text: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "removed", text: oldLines[i++] });
  while (j < m) ops.push({ type: "added", text: newLines[j++] });

  return ops;
}

/**
 * Collapses a full line-diff down to unified-diff-style hunks: only the
 * changed lines plus a little surrounding context, with "…" markers over the
 * gaps. Keeps the published diff small even when only a few lines changed on
 * an otherwise-long page. Returns [] if there's nothing but context (diff
 * turned out empty despite a hash mismatch — e.g. whitespace-only source
 * differences that survived normalization).
 */
export function toUnifiedHunks(ops, { contextLines = 2, maxLines = 200 } = {}) {
  const changeIndices = ops.reduce((acc, op, idx) => {
    if (op.type !== "context") acc.push(idx);
    return acc;
  }, []);
  if (changeIndices.length === 0) return [];

  const keep = new Set();
  for (const idx of changeIndices) {
    for (let k = Math.max(0, idx - contextLines); k <= Math.min(ops.length - 1, idx + contextLines); k++) {
      keep.add(k);
    }
  }

  const sortedKeep = Array.from(keep).sort((a, b) => a - b);
  const hunks = [];
  let lastIdx = -2;
  for (const idx of sortedKeep) {
    if (idx !== lastIdx + 1 && hunks.length > 0) hunks.push({ type: "ellipsis", text: "…" });
    hunks.push(ops[idx]);
    lastIdx = idx;
  }

  if (hunks.length > maxLines) {
    return [...hunks.slice(0, maxLines), { type: "ellipsis", text: `… diff truncated (${hunks.length - maxLines} more lines) …` }];
  }
  return hunks;
}

/**
 * Fallback for pages too large for the positional LCS diff: a multiset
 * (line-frequency) comparison instead. O(n), so it never hits a size cap -
 * "removed" is lines whose count dropped, "added" is lines whose count rose.
 * No context lines (there's no meaningful position to anchor them to), but
 * this guarantees *something* concrete is always shown instead of "diff not
 * available", even on huge pages.
 */
export function computeMultisetDiff(oldText, newText, { maxLines = 200 } = {}) {
  const countLines = (text) => {
    const counts = new Map();
    for (const line of text.split("\n")) counts.set(line, (counts.get(line) || 0) + 1);
    return counts;
  };

  const oldCounts = countLines(oldText);
  const newCounts = countLines(newText);
  const hunks = [];

  for (const [line, oldCount] of oldCounts) {
    const newCount = newCounts.get(line) || 0;
    for (let i = 0; i < oldCount - newCount; i++) hunks.push({ type: "removed", text: line });
  }
  for (const [line, newCount] of newCounts) {
    const oldCount = oldCounts.get(line) || 0;
    for (let i = 0; i < newCount - oldCount; i++) hunks.push({ type: "added", text: line });
  }

  if (hunks.length > maxLines) {
    return [...hunks.slice(0, maxLines), { type: "ellipsis", text: `… diff truncated (${hunks.length - maxLines} more lines) …` }];
  }
  return hunks;
}

/**
 * Diff two texts and return trimmed unified hunks. Prefers the positional
 * LCS diff (has surrounding context); falls back to the multiset diff if the
 * inputs are too large for that (see MAX_DP_CELLS) - so this never returns
 * null/nothing the way the underlying pieces individually can.
 */
export function computeUnifiedDiff(oldText, newText, options) {
  const ops = diffLines(oldText, newText);
  if (ops) return toUnifiedHunks(ops, options);
  return computeMultisetDiff(oldText, newText, options);
}
