const metaLine = document.getElementById("meta-line");
const overlay = document.getElementById("overlay");
const detailContent = document.getElementById("detail-content");
const closeBtn = document.getElementById("close-btn");

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
  if (!entry) return `<p class="not-found">No ${label} found yet.</p>`;
  return `
    <a href="${entry.url}" target="_blank" rel="noopener noreferrer">${entry.title || entry.url}</a>
    ${entry.description ? `<p class="snippet">${entry.description}</p>` : ""}
  `;
}

function renderLaunchDetail(launch) {
  return `
    <h2 id="detail-title">${launch.cardName}</h2>
    <p class="issuer-name">${launch.issuerName} &middot; detected ${formatDate(launch.discoveredAt)}</p>

    <div class="detail-section">
      <h3>Official issuer link</h3>
      <a href="${launch.officialUrl}" target="_blank" rel="noopener noreferrer">${launch.officialUrl}</a>
    </div>

    <div class="detail-section">
      <h3>Announcement</h3>
      ${linkOrFallback(launch.announcement, "announcement")}
    </div>

    <div class="detail-section">
      <h3>Community sentiment</h3>
      <ul class="community-list">
        <li><strong>Reddit:</strong> ${linkOrFallback(launch.community?.reddit, "Reddit discussion")}</li>
        <li><strong>X / Twitter:</strong> ${linkOrFallback(launch.community?.twitter, "X/Twitter post")}</li>
        <li><strong>YouTube:</strong> ${linkOrFallback(launch.community?.youtube, "YouTube video")}</li>
      </ul>
    </div>
  `;
}

function renderChangeDetail(change) {
  return `
    <h2 id="detail-title">${change.cardName}</h2>
    <p class="issuer-name">${change.issuerName} &middot; changed ${formatDate(change.detectedAt)}</p>

    <div class="detail-section">
      <h3>Card page</h3>
      <a href="${change.productPageUrl}" target="_blank" rel="noopener noreferrer">${change.productPageUrl}</a>
    </div>

    <div class="detail-section">
      <h3>Official issuer link</h3>
      <a href="${change.officialUrl}" target="_blank" rel="noopener noreferrer">${change.officialUrl}</a>
    </div>

    <div class="detail-section">
      <h3>Community verification</h3>
      <ul class="community-list">
        <li><strong>Reddit:</strong> ${linkOrFallback(change.community?.reddit, "Reddit discussion")}</li>
        <li><strong>News/other:</strong> ${linkOrFallback(change.community?.general, "coverage")}</li>
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

function renderTiles({ items, gridEl, emptyStateEl, kind, dateField, frequencyDays }) {
  if (items.length === 0) {
    emptyStateEl.hidden = false;
    return;
  }

  gridEl.innerHTML = "";
  for (const item of items) {
    const tile = document.createElement("button");
    tile.className = "tile";
    tile.type = "button";

    const badges = [`<span class="badge">${item.issuerName}</span>`];
    if (isRecent(item[dateField], frequencyDays || 7)) {
      badges.push(`<span class="badge badge--new">${kind === "change" ? "Updated" : "New"}</span>`);
    }

    tile.innerHTML = `
      <div class="tile__badges">${badges.join("")}</div>
      <p class="tile__name">${item.cardName}</p>
      <p class="tile__date">${kind === "change" ? "Changed" : "Detected"} ${formatDate(item[dateField])}</p>
    `;
    tile.addEventListener("click", () => openDetail(item, kind));
    gridEl.appendChild(tile);
  }
}

async function init() {
  try {
    const [launchesRes, changesRes, metaRes] = await Promise.all([
      fetch("data/launches.json", { cache: "no-store" }),
      fetch("data/changes.json", { cache: "no-store" }),
      fetch("data/meta.json", { cache: "no-store" })
    ]);
    const launches = await launchesRes.json();
    const changes = changesRes.ok ? await changesRes.json() : [];
    const meta = await metaRes.json();

    metaLine.textContent = meta.lastRunAt
      ? `Last checked ${formatDate(meta.lastRunAt)} · tracking ${meta.issuerCount} issuers · checking every ${meta.frequencyDays} day(s)`
      : "Runner has not completed a pass yet.";

    renderTiles({
      items: launches,
      gridEl: document.getElementById("launches-grid"),
      emptyStateEl: document.getElementById("launches-empty-state"),
      kind: "launch",
      dateField: "discoveredAt",
      frequencyDays: meta.frequencyDays
    });

    renderTiles({
      items: changes,
      gridEl: document.getElementById("changes-grid"),
      emptyStateEl: document.getElementById("changes-empty-state"),
      kind: "change",
      dateField: "detectedAt",
      frequencyDays: meta.frequencyDays
    });
  } catch (err) {
    metaLine.textContent = "Could not load feed data.";
    console.error(err);
  }
}

init();
