const tileGrid = document.getElementById("tile-grid");
const emptyState = document.getElementById("empty-state");
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

function renderDetail(launch) {
  detailContent.innerHTML = `
    <div class="detail-content">
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
    </div>
  `;
}

function openDetail(launch) {
  renderDetail(launch);
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

function renderTiles(launches, frequencyDays) {
  if (launches.length === 0) {
    emptyState.hidden = false;
    return;
  }

  tileGrid.innerHTML = "";
  for (const launch of launches) {
    const tile = document.createElement("button");
    tile.className = "tile";
    tile.type = "button";

    const badges = [`<span class="badge">${launch.issuerName}</span>`];
    if (isRecent(launch.discoveredAt, frequencyDays || 7)) {
      badges.push(`<span class="badge badge--new">New</span>`);
    }

    tile.innerHTML = `
      <div class="tile__badges">${badges.join("")}</div>
      <p class="tile__name">${launch.cardName}</p>
      <p class="tile__date">Detected ${formatDate(launch.discoveredAt)}</p>
    `;
    tile.addEventListener("click", () => openDetail(launch));
    tileGrid.appendChild(tile);
  }
}

async function init() {
  try {
    const [launchesRes, metaRes] = await Promise.all([
      fetch("data/launches.json", { cache: "no-store" }),
      fetch("data/meta.json", { cache: "no-store" })
    ]);
    const launches = await launchesRes.json();
    const meta = await metaRes.json();

    metaLine.textContent = meta.lastRunAt
      ? `Last checked ${formatDate(meta.lastRunAt)} · tracking ${meta.issuerCount} issuers · checking every ${meta.frequencyDays} day(s)`
      : "Runner has not completed a pass yet.";

    renderTiles(launches, meta.frequencyDays);
  } catch (err) {
    metaLine.textContent = "Could not load feed data.";
    console.error(err);
  }
}

init();
