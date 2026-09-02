// Re-runs the verified/unverified tagging pass (see
// lib/newsletter-verification.mjs) against every item already published in
// docs/data/newsletters.json and docs/data/editions/*.json, against this
// run's current changes.json/launches.json/tracked-cards.json.
//
// This exists because an item published as "unverified" isn't necessarily
// wrong - it just didn't have corroboration YET at publish time. Reddit/
// Google grounding (lib/grounding.mjs) can catch up days later, or a
// card's discontinued status can get confirmed after the newsletter
// already mentioned it. Re-running this daily (wired into run.mjs) lets
// those items upgrade to "verified" once that evidence exists, instead of
// staying stuck at whatever was known the moment the newsletter shipped.
//
// Safe to run standalone too: `node scripts/regenerate-newsletter-tags.mjs`
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveItemVerification, flattenItemsByIssuer } from "./lib/newsletter-verification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const DATA_DIR = path.join(DOCS_DIR, "data");
const EDITIONS_DIR = path.join(DATA_DIR, "editions");
const BY_ISSUER_DIR = path.join(DATA_DIR, "by-issuer");
const NEWSLETTERS_PATH = path.join(DATA_DIR, "newsletters.json");
const CHANGES_PATH = path.join(DATA_DIR, "changes.json");
const LAUNCHES_PATH = path.join(DATA_DIR, "launches.json");
const TRACKED_CARDS_PATH = path.join(REPO_ROOT, "config", "tracked-cards.json");

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

// Verification is one-way: once an item is tagged "verified" with a
// captured evidence link, that's durable historical record and is never
// re-derived or downgraded - changes.json only keeps the most recent 200
// entries (MAX_CHANGES_KEPT in run.mjs), so an older item's supporting
// changes.json record can age out over time even though nothing about the
// actual claim changed. Re-deriving on every run would wrongly flip an
// already-verified item back to unverified the moment its source record
// got trimmed. So only items that are currently unverified get
// re-checked, as an upgrade path only.
function retagItems(items, sourceData) {
  let upgraded = 0;
  const retagged = items.map((item) => {
    if (item.status === "verified") return item;

    const verification = resolveItemVerification(item, sourceData);
    if (verification.status === "verified") upgraded++;
    return {
      ...item,
      status: verification.status,
      official_link: verification.officialLink ?? item.official_link ?? null,
      verification_link: verification.verificationLink
    };
  });
  return { retagged, upgraded };
}

export async function regenerateNewsletterTags() {
  const sourceData = {
    changes: readJson(CHANGES_PATH, []),
    launches: readJson(LAUNCHES_PATH, []),
    trackedCards: readJson(TRACKED_CARDS_PATH, [])
  };

  const newsletters = readJson(NEWSLETTERS_PATH, []);
  if (newsletters.length === 0) {
    return { editionsChecked: 0, itemsChecked: 0, upgraded: 0 };
  }

  let itemsChecked = 0;
  let totalUpgraded = 0;

  const retaggedNewsletters = newsletters.map((entry) => {
    const { retagged, upgraded } = retagItems(entry.items || [], sourceData);
    itemsChecked += retagged.length;
    totalUpgraded += upgraded;

    // Keep the per-edition file (the full record, including body_html) in
    // sync with the same tags, not just the master feed.
    const editionPath = path.join(EDITIONS_DIR, entry.date + ".json");
    const edition = readJson(editionPath, null);
    if (edition) {
      edition.items = retagItems(edition.items || [], sourceData).retagged;
      writeJson(editionPath, edition);
    }

    return { ...entry, items: retagged };
  });

  writeJson(NEWSLETTERS_PATH, retaggedNewsletters);

  const byIssuer = flattenItemsByIssuer(retaggedNewsletters);
  const issuersWritten = [];
  byIssuer.forEach((items, issuer) => {
    writeJson(path.join(BY_ISSUER_DIR, issuer + ".json"), items);
    issuersWritten.push(issuer);
  });

  return {
    editionsChecked: newsletters.length,
    itemsChecked,
    upgraded: totalUpgraded,
    issuersWritten
  };
}

async function main() {
  const result = await regenerateNewsletterTags();
  console.log(
    `Re-tagged ${result.itemsChecked} item(s) across ${result.editionsChecked} edition(s): ` +
      `${result.upgraded} upgraded to verified.`
  );
  if (result.issuersWritten?.length) {
    console.log(`Issuer feeds rewritten: ${result.issuersWritten.sort().join(", ")}`);
  }
}

// Only run as a CLI when invoked directly (`node scripts/regenerate-newsletter-tags.mjs`),
// not when imported by run.mjs to run as part of the daily pipeline.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal error in regenerate-newsletter-tags.mjs:", err);
    process.exit(1);
  });
}
