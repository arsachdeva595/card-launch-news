import { withMonzyUtm } from "./utm-link.mjs";

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

// Appended as a trailing sentence directly onto an AI-generated summary
// (not its own section) so the summary always points back at the card's own
// official page as the source of truth, wherever that summary is shown.
function officialPageSentence(productPageUrl) {
  return ` Check the <a href="${esc(withMonzyUtm(productPageUrl))}">official page</a> for more details.`;
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
    "X/Twitter: Not checked (no free API available)",
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

  if (change.summary) {
    lines.push("", `<b>Summary (✅ verified via Reddit):</b> ${esc(change.summary)}${officialPageSentence(change.productPageUrl)}`);
  } else if (change.summaryVerification?.candidateSummary) {
    lines.push(
      "",
      `<b>Summary (⚠️ unverified, AI guess):</b> ${esc(change.summaryVerification.candidateSummary)}${officialPageSentence(change.productPageUrl)}`
    );
  }

  const excerpt = diffExcerpt(change.diffHunks);
  lines.push("", excerpt ? `What changed (excerpt):\n${excerpt}` : "What changed: see full diff on the site");

  lines.push("", linkLine("Reddit", change.community?.reddit), linkLine("YouTube", change.community?.youtube));
  if (siteUrl) lines.push("", `Full details: ${esc(siteUrl)}`);
  return lines.join("\n");
}

// Tier 2: a lightweight "something changed" signal with no fetched content
// behind it (see scripts/detect-pings.mjs) - deliberately terser than the
// full launch/change messages since there's no diff, no community search,
// nothing but "this URL's sitemap lastmod moved."
export function formatPingMessage(ping) {
  return [
    `🔔 Page updated (unverified — lastmod signal only)`,
    `Issuer: ${esc(ping.issuerName)}`,
    `URL: <a href="${esc(ping.url)}">${esc(ping.url)}</a>`,
    `Last modified: ${esc(ping.previousLastmod)} → ${esc(ping.lastmod)}`
  ].join("\n");
}

export function formatRedditBuzzMessage(buzz, siteUrl) {
  const lines = [
    `💬 <b>${esc(buzz.cardName)}</b> — r/CreditCardsIndia buzz (${esc(buzz.kind)})`,
    `Issuer: ${esc(buzz.issuerName)}`,
    "",
    `<a href="${esc(buzz.postUrl)}">${esc(buzz.postTitle)}</a>`
  ];
  if (buzz.snippet) lines.push(esc(buzz.snippet).slice(0, 300));
  if (siteUrl) lines.push("", `Full details: ${esc(siteUrl)}`);
  return lines.join("\n");
}
