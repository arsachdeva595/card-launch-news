const metaLine = document.getElementById("meta-line");
const overlay = document.getElementById("overlay");
const detailContent = document.getElementById("detail-content");
const closeBtn = document.getElementById("close-btn");
const searchInput = document.getElementById("search-input");

let allLaunches = [];
let allChanges = [];
let currentFrequencyDays = 7;

// All card names, search-result titles/snippets, and diff text originate
// from external sources (issuer pages, search API results) - escape before
// interpolating into innerHTML so a hostile page/snippet can't inject markup.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

// href values also come from external sources (search results); escaping
// handles quote-breakout, and restricting to http(s) blocks javascript:/data:
// scheme injection.
function safeHref(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "#";
    return escapeHtml(url);
  } catch {
    return "#";
  }
}

function formatDate(iso) {
  if (!iso) return "Unknown date";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function isRecent(iso, days) {
  if (!iso) return false;
  const ageMs = Date.now() - new Date(iso).getTime();
  return ageMs <= days * 24 * 60 * 60 * 1000;
}

function linkOrFallback(entry, label) {
  if (!entry) return `<p class="not-found">No ${escapeHtml(label)} found yet.</p>`;
  return `
    <a href="${safeHref(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.title || entry.url)}</a>
    ${entry.description ? `<p class="snippet">${escapeHtml(entry.description)}</p>` : ""}
  `;
}

function renderDiff(diffHunks) {
  if (!diffHunks || diffHunks.length === 0) {
    return `<p class="not-found">No line-level diff available for this change (page content shifted too much to diff cheaply, or the change was whitespace-only) — visit the page directly to see the current version.</p>`;
  }

  const lines = diffHunks
    .map((hunk) => {
      const cls = hunk.type === "added" ? "diff-added" : hunk.type === "removed" ? "diff-removed" : hunk.type === "ellipsis" ? "diff-ellipsis" : "diff-context";
      const prefix = hunk.type === "added" ? "+" : hunk.type === "removed" ? "−" : hunk.type === "ellipsis" ? "" : " ";
      return `<div class="diff-line ${cls}">${escapeHtml(prefix)}${escapeHtml(hunk.text)}</div>`;
    })
    .join("");

  return `<div class="diff-block">${lines}</div>`;
}

function renderLaunchDetail(launch) {
  return `
    <h2 id="detail-title">${escapeHtml(launch.cardName)}</h2>
    <p class="issuer-name">${escapeHtml(launch.issuerName)} &middot; detected ${formatDate(launch.discoveredAt)}</p>

    <div class="detail-section">
      <h3>Official issuer link</h3>
      <a href="${safeHref(launch.officialUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(launch.officialUrl)}</a>
    </div>

    <div class="detail-section">
      <h3>Announcement</h3>
      ${linkOrFallback(launch.announcement, "announcement")}
    </div>

    <div class="detail-section">
      <h3>Community sentiment</h3>
      <ul class="community-list">
        <li><strong>Reddit:</strong> ${linkOrFallback(launch.community?.reddit, "Reddit discussion")}</li>
        <li><strong>X / Twitter:</strong> <p class="not-found">Not checked (no free API available for X/Twitter search).</p></li>
        <li><strong>YouTube:</strong> ${linkOrFallback(launch.community?.youtube, "YouTube video")}</li>
      </ul>
    </div>
  `;
}

function renderChangeDetail(change) {
  return `
    <h2 id="detail-title">${escapeHtml(change.cardName)}</h2>
    <p class="issuer-name">${escapeHtml(change.issuerName)} &middot; changed ${formatDate(change.detectedAt)}</p>

    <div class="detail-section">
      <h3>Card page</h3>
      <a href="${safeHref(change.productPageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(change.productPageUrl)}</a>
    </div>

    <div class="detail-section">
      <h3>What changed</h3>
      ${renderDiff(change.diffHunks)}
    </div>

    <div class="detail-section">
      <h3>Official issuer link</h3>
      <a href="${safeHref(change.officialUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(change.officialUrl)}</a>
    </div>

    <div class="detail-section">
      <h3>Community verification</h3>
      <ul class="community-list">
        <li><strong>Reddit:</strong> ${linkOrFallback(change.community?.reddit, "Reddit discussion")}</li>
        <li><strong>YouTube:</strong> ${linkOrFallback(change.community?.youtube, "YouTube video")}</li>
      </ul>
    </div>
  `;
}

function openDetail(item, kind) {
  detailContent.innerHTML = kind === "change" ? renderChangeDetail(item) : renderLaunchDetail(item);
  overlay.hidden = false;
}

function closeDetail() {
  overlay.hidden = true;
}

closeBtn.addEventListener("click", closeDetail);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});

// --- Fuzzy search --------------------------------------------------------
// Three-tier, dependency-free scoring: exact substring beats word-overlap
// beats typo-tolerant character-subsequence matching. Returns -Infinity for
// "not a match at all" so callers can filter with `score > -Infinity`.
function normalizeForSearch(s) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, "");
}

function fuzzyScore(query, target) {
  const q = normalizeForSearch(query).trim();
  const t = normalizeForSearch(target);
  if (!q) return 0;

  const substringIdx = t.indexOf(q);
  if (substringIdx !== -1) return 1000 - substringIdx;

  const qWords = q.split(/\s+/).filter(Boolean);
  const tWords = t.split(/\s+/).filter(Boolean);
  const tokenMatches = qWords.filter((qw) => tWords.some((tw) => tw.includes(qw))).length;
  if (tokenMatches > 0) return 500 * (tokenMatches / qWords.length);

  let ti = 0;
  let matchedChars = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const foundAt = t.indexOf(ch, ti);
    if (foundAt === -1) continue;
    matchedChars++;
    ti = foundAt + 1;
  }
  const significantChars = q.replace(/\s+/g, "").length;
  const ratio = significantChars > 0 ? matchedChars / significantChars : 0;
  return ratio >= 0.7 ? 100 * ratio : -Infinity;
}

function bestScore(query, item) {
  return Math.max(fuzzyScore(query, item.cardName), fuzzyScore(query, item.issuerName));
}

function filterAndSort(items, query) {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: bestScore(query, item) }))
    .filter(({ score }) => score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}
// --------------------------------------------------------------------------

function renderTiles({ items, gridEl, emptyStateEl, kind, dateField, frequencyDays, emptyMessage }) {
  if (items.length === 0) {
    emptyStateEl.textContent = emptyMessage;
    emptyStateEl.hidden = false;
    gridEl.innerHTML = "";
    return;
  }

  emptyStateEl.hidden = true;
  gridEl.innerHTML = "";
  for (const item of items) {
    const tile = document.createElement("button");
    tile.className = "tile";
    tile.type = "button";

    const badges = [`<span class="badge">${escapeHtml(item.issuerName)}</span>`];
    if (isRecent(item[dateField], frequencyDays || 7)) {
      badges.push(`<span class="badge badge--new">${kind === "change" ? "Updated" : "New"}</span>`);
    }

    tile.innerHTML = `
      <div class="tile__badges">${badges.join("")}</div>
      <p class="tile__name">${escapeHtml(item.cardName)}</p>
      <p class="tile__date">${kind === "change" ? "Changed" : "Detected"} ${formatDate(item[dateField])}</p>
    `;
    tile.addEventListener("click", () => openDetail(item, kind));
    gridEl.appendChild(tile);
  }
}

function renderAll(query) {
  const filteredLaunches = filterAndSort(allLaunches, query);
  const filteredChanges = filterAndSort(allChanges, query);
  const isSearching = query.trim().length > 0;

  renderTiles({
    items: filteredLaunches,
    gridEl: document.getElementById("launches-grid"),
    emptyStateEl: document.getElementById("launches-empty-state"),
    kind: "launch",
    dateField: "discoveredAt",
    frequencyDays: currentFrequencyDays,
    emptyMessage: isSearching
      ? `No launches match "${query}".`
      : "No launches tracked yet. The runner populates this feed on its next scheduled pass."
  });

  renderTiles({
    items: filteredChanges,
    gridEl: document.getElementById("changes-grid"),
    emptyStateEl: document.getElementById("changes-empty-state"),
    kind: "change",
    dateField: "detectedAt",
    frequencyDays: currentFrequencyDays,
    emptyMessage: isSearching ? `No changes match "${query}".` : "No changes detected yet."
  });

  // If the search narrows things down to exactly one card total, jump
  // straight to its detail view instead of making the user click it.
  if (isSearching && filteredLaunches.length + filteredChanges.length === 1) {
    if (filteredLaunches.length === 1) openDetail(filteredLaunches[0], "launch");
    else openDetail(filteredChanges[0], "change");
  }
}

searchInput.addEventListener("input", () => renderAll(searchInput.value));

const REPO_URL = "https://github.com/arsachdeva595/card-launch-news";

function renderSettings(meta) {
  const settingsContent = document.getElementById("settings-content");
  settingsContent.innerHTML = `
    <dl class="settings-list">
      <div><dt>Check frequency</dt><dd>Every ${escapeHtml(meta.frequencyDays ?? "?")} day(s)</dd></div>
      <div><dt>Last checked</dt><dd>${meta.lastRunAt ? formatDate(meta.lastRunAt) : "Never yet"}</dd></div>
      <div><dt>Issuers tracked</dt><dd>${escapeHtml(meta.issuerCount ?? "?")}</dd></div>
      <div><dt>Launches tracked</dt><dd>${escapeHtml(meta.totalLaunchesTracked ?? 0)}</dd></div>
      <div><dt>Changes tracked</dt><dd>${escapeHtml(meta.totalChangesTracked ?? 0)}</dd></div>
      <div><dt>Change detection</dt><dd>${meta.changeDetectionEnabled === false ? "Disabled" : "Enabled"}</dd></div>
    </dl>
    <p class="settings-note">
      This is a static site — settings changes happen on GitHub, not here.
    </p>
    <div class="settings-links">
      <a href="${REPO_URL}/actions/workflows/runner.yml" target="_blank" rel="noopener noreferrer">Run a check now →</a>
      <a href="${REPO_URL}/edit/main/config/settings.json" target="_blank" rel="noopener noreferrer">Edit settings (frequency, patterns, etc.) →</a>
    </div>
  `;
}

async function init() {
  try {
    const [launchesRes, changesRes, metaRes] = await Promise.all([
      fetch("data/launches.json", { cache: "no-store" }),
      fetch("data/changes.json", { cache: "no-store" }),
      fetch("data/meta.json", { cache: "no-store" })
    ]);
    allLaunches = await launchesRes.json();
    allChanges = changesRes.ok ? await changesRes.json() : [];
    const meta = await metaRes.json();
    currentFrequencyDays = meta.frequencyDays || 7;

    metaLine.textContent = meta.lastRunAt
      ? `Last checked ${formatDate(meta.lastRunAt)} · tracking ${meta.issuerCount} issuers · checking every ${meta.frequencyDays} day(s)`
      : "Runner has not completed a pass yet.";

    renderSettings(meta);
    renderAll("");
  } catch (err) {
    metaLine.textContent = "Could not load feed data.";
    console.error(err);
  }
}

init();
