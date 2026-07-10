// Telegram's HTML parse mode only understands a small tag subset (b, i, a,
// code, pre, ...) - escape everything else so a fetched title/snippet
// containing & < > can't break message formatting or silently get dropped.
function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

function linkLine(label, entry, fallback = "Not found yet") {
  if (!entry) return `${label}: ${fallback}`;
  return `${label}: <a href="${esc(entry.url)}">${esc(entry.title || entry.url)}</a>`;
}

function diffExcerpt(diffHunks, maxLines = 6) {
  if (!diffHunks || diffHunks.length === 0) return null;
  const meaningful = diffHunks.filter((h) => h.type !== "ellipsis").slice(0, maxLines);
  if (meaningful.length === 0) return null;
  const prefixed = meaningful.map((h) => {
    const prefix = h.type === "added" ? "+ " : h.type === "removed" ? "- " : "  ";
    return `${prefix}${h.text}`;
  });
  return `<pre>${esc(prefixed.join("\n"))}</pre>`;
}

export function formatLaunchMessage(launch, siteUrl) {
  const lines = [
    `🆕 <b>${esc(launch.cardName)}</b>`,
    `Issuer: ${esc(launch.issuerName)}`,
    "",
    `Official: ${esc(launch.officialUrl)}`,
    `Card page: <a href="${esc(launch.productPageUrl)}">${esc(launch.productPageUrl)}</a>`,
    linkLine("Announcement", launch.announcement),
    linkLine("Reddit", launch.community?.reddit),
    linkLine("X/Twitter", launch.community?.twitter),
    linkLine("YouTube", launch.community?.youtube)
  ];
  if (siteUrl) lines.push("", `Full details: ${esc(siteUrl)}`);
  return lines.join("\n");
}

export function formatChangeMessage(change, siteUrl) {
  const lines = [
    `♻️ <b>${esc(change.cardName)}</b> — page changed`,
    `Issuer: ${esc(change.issuerName)}`,
    "",
    `Card page: <a href="${esc(change.productPageUrl)}">${esc(change.productPageUrl)}</a>`
  ];

  const excerpt = diffExcerpt(change.diffHunks);
  lines.push("", excerpt ? `What changed (excerpt):\n${excerpt}` : "What changed: see full diff on the site");

  lines.push("", linkLine("Reddit", change.community?.reddit), linkLine("News/other", change.community?.general));
  if (siteUrl) lines.push("", `Full details: ${esc(siteUrl)}`);
  return lines.join("\n");
}
