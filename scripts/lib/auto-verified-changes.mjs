// Keeps docs/data/auto-verified-changes.json in sync with every verified
// Tier 1 change in changes.json, so a card's verified change shows up in
// its by-issuer feed as soon as it's detected and grounded - without
// waiting for a newsletter edition to be written about it, which may lag
// by days or never happen for a given card. flattenItemsByIssuer() (see
// lib/newsletter-verification.mjs) merges this list in alongside
// newsletter-derived items whenever any of the by-issuer writers
// (publish-edition.js, regenerate-newsletter-tags.mjs,
// regenerate-issuer-feeds.js) run.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { canonicalIssuerSlug, normalizeCardName } from "./newsletter-verification.mjs";
import { slugify } from "./page-meta.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const DATA_DIR = path.join(REPO_ROOT, "docs", "data");
const CHANGES_PATH = path.join(DATA_DIR, "changes.json");
const NEWSLETTERS_PATH = path.join(DATA_DIR, "newsletters.json");
const AUTO_VERIFIED_PATH = path.join(DATA_DIR, "auto-verified-changes.json");

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// Best-effort classification into the same change_type categories
// newsletter items use (devaluation/launch/discontinued/fee-change/
// reward-change/benefit-change/eligibility-change/other) - a changes.json
// entry has no change_type of its own, that's something a human/Cowork
// infers when writing about it, so this pattern-matches the LLM summary
// text instead. Approximate by design: defaults to "other" rather than
// blocking an item from being pushed just because its category is
// ambiguous.
const CLASSIFY_RULES = [
  { type: "discontinued", re: /\bdiscontinued\b|closed to new applicants|no longer (available|accepting)/i },
  { type: "fee-change", re: /\b(fee|charge|markup|interest rate|apr)\b/i },
  { type: "reward-change", re: /\b(reward|points?|cashback|miles)\b/i },
  { type: "benefit-change", re: /\b(lounge|benefit|voucher|insurance|concierge|milestone)\b/i },
  { type: "eligibility-change", re: /\b(eligib|income|salary|criteria)\b/i }
];

function classifyChangeType(summary) {
  const text = String(summary || "");
  for (const rule of CLASSIFY_RULES) {
    if (rule.re.test(text)) return rule.type;
  }
  return "other";
}

function buildAutoItem(change) {
  return {
    card_slug: slugify(change.cardName),
    card_name: change.cardName,
    issuer: canonicalIssuerSlug(change.issuerSlug),
    change_type: classifyChangeType(change.summary),
    summary: change.summary,
    status: "verified",
    official_link: change.productPageUrl || null,
    verification_link: change.summaryVerification?.source?.url || null,
    source: "auto-detected",
    detected_at: change.detectedAt
  };
}

// A newsletter entry for the same card/issuer on the same day is the
// better, human-written version once it exists - the auto item for that
// specific day is dropped in favor of it (not a blanket "this card has
// ever appeared in a newsletter" exclusion, since a different day's
// change for the same card is still worth surfacing on its own).
function newsletterCoversSameDay(newsletters, cardName, issuerSlug, detectedAt) {
  const wantName = normalizeCardName(cardName);
  const wantIssuer = canonicalIssuerSlug(issuerSlug);
  const wantDate = String(detectedAt || "").slice(0, 10);
  return newsletters.some(
    (entry) =>
      entry.date === wantDate &&
      (entry.items || []).some(
        (item) => normalizeCardName(item.card_name) === wantName && canonicalIssuerSlug(item.issuer) === wantIssuer
      )
  );
}

/**
 * Reads changes.json, finds every verified entry, and upserts a
 * corresponding item into auto-verified-changes.json - keyed by
 * (issuer, normalized card name, detected date) so reruns never
 * duplicate. Existing auto entries are left untouched (not re-derived),
 * matching regenerate-newsletter-tags.mjs's one-way-upgrade philosophy -
 * this only ever adds newly-verified changes, never removes or rewrites
 * ones already recorded. Returns how many were added.
 */
export function syncAutoVerifiedChanges() {
  const changes = readJson(CHANGES_PATH, []);
  const newsletters = readJson(NEWSLETTERS_PATH, []);
  const existing = readJson(AUTO_VERIFIED_PATH, []);

  const existingKeys = new Set(
    existing.map((item) => `${item.issuer}::${normalizeCardName(item.card_name)}::${String(item.detected_at).slice(0, 10)}`)
  );

  let added = 0;
  for (const change of changes) {
    if (change.summaryVerification?.status !== "verified") continue;

    const key = `${canonicalIssuerSlug(change.issuerSlug)}::${normalizeCardName(change.cardName)}::${String(change.detectedAt).slice(0, 10)}`;
    if (existingKeys.has(key)) continue;
    if (newsletterCoversSameDay(newsletters, change.cardName, change.issuerSlug, change.detectedAt)) continue;

    existing.push(buildAutoItem(change));
    existingKeys.add(key);
    added++;
  }

  if (added > 0) {
    writeJson(AUTO_VERIFIED_PATH, existing);
  }
  return added;
}

/** Reads the current auto-verified-changes.json list (for flattenItemsByIssuer to merge in). */
export function readAutoVerifiedChanges() {
  return readJson(AUTO_VERIFIED_PATH, []);
}
