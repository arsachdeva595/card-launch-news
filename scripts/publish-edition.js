#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
const PERMALINK_BASE = "https://arsachdeva595.github.io/card-launch-news/edition/";

const REQUIRED_FIELDS = ["number", "date", "subject", "summary", "body_html", "items"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Canonical short-form issuer slugs, keyed by every long-form slug an
// incoming payload might use (matching config/issuers.json's own "slug"
// field). Values already in canonical form map to themselves, so any
// issuer this table doesn't recognize passes through unchanged.
const CANONICAL_ISSUER_SLUGS = {
  "amex": "amex",
  "au-sfb": "au-sfb",
  "axis-bank": "axis",
  "bank-of-baroda": "bob",
  "bank-of-india": "boi",
  "canara-bank": "canara",
  "dbs-bank": "dbs",
  "equitas-sfb": "equitas-sfb",
  "federal-bank": "federal",
  "hdfc-bank": "hdfc",
  "hsbc-india": "hsbc",
  "icici-bank": "icici",
  "idbi-bank": "idbi",
  "idfc-first-bank": "idfc-first",
  "indusind-bank": "indusind",
  "karur-vysya-bank": "kvb",
  "kotak-mahindra-bank": "kotak",
  "punjab-national-bank": "pnb",
  "rbl-bank": "rbl",
  "sbi-card": "sbi",
  "south-indian-bank": "sib",
  "standard-chartered-india": "standard-chartered",
  "union-bank-of-india": "union-bank",
  "yes-bank": "yes-bank",
};

function canonicalIssuerSlug(slug) {
  return CANONICAL_ISSUER_SLUGS[slug] || slug;
}

function normalizeCardName(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Cross-checks one edition item against this repo's own pipeline data
// (docs/data/changes.json, docs/data/launches.json, config/tracked-cards.json)
// rather than trusting whatever the edition payload claims - the same
// "verified news only" gate the site applies to Tier 1 changes (see
// scripts/lib/reddit-grounding.mjs / lib/llm-summary.mjs) now also decides
// what's allowed into newsletters.json and, downstream, the per-issuer
// feeds that monzy.co reads. Matching is by (card name, canonical issuer)
// since the edition payload's card_slug is a hand-picked slug, not the
// same id format changes.json/launches.json use internally.
function verifySourceMatch(item, { changes, launches, trackedCards }) {
  const wantName = normalizeCardName(item.card_name);
  const wantIssuer = canonicalIssuerSlug(item.issuer);

  // A launch's "announcement" is the card's own official page, not an
  // LLM's reading of a diff - there's no hallucination-prone summarization
  // step in that path, so a launch match is trusted directly.
  const launchMatch = launches.find(
    (l) => normalizeCardName(l.cardName) === wantName && canonicalIssuerSlug(l.issuerSlug) === wantIssuer
  );
  if (launchMatch) return { ok: true };

  // Discontinued status is set deterministically by regex-matching phrases
  // like "has been discontinued" in the page's own diff (see
  // scripts/lib/discontinuation.mjs), not by an LLM summarizing/interpreting
  // the change - so it's trusted from tracked-cards.json's own status
  // rather than requiring Reddit corroboration of an LLM-written summary.
  if (item.change_type === "discontinued") {
    const trackedMatch = trackedCards.find(
      (c) => normalizeCardName(c.cardName) === wantName && canonicalIssuerSlug(c.issuerSlug) === wantIssuer
    );
    if (trackedMatch && trackedMatch.status === "Discontinued") return { ok: true };
    return {
      ok: false,
      reason: "claims discontinued, but config/tracked-cards.json doesn't show Discontinued status for a matching card/issuer",
    };
  }

  const changeMatch = changes.find(
    (c) => normalizeCardName(c.cardName) === wantName && canonicalIssuerSlug(c.issuerSlug) === wantIssuer
  );
  if (!changeMatch) {
    return { ok: false, reason: "no matching card/issuer found in changes.json or launches.json" };
  }
  if (changeMatch.summaryVerification?.status === "verified") {
    return { ok: true };
  }
  return { ok: false, reason: "matching change exists but its summary is unverified (no Reddit corroboration yet)" };
}

function fail(message) {
  process.stderr.write("Error: " + message + "\n");
  process.exit(1);
}

function parseArgs(argv) {
  const args = { allowUnverified: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") {
      args.input = argv[i + 1];
      i++;
    } else if (argv[i] === "--allow-unverified") {
      args.allowUnverified = true;
    }
  }
  return args;
}

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

function validatePayload(payload) {
  const missing = REQUIRED_FIELDS.filter((field) => payload[field] === undefined || payload[field] === null);
  if (missing.length) {
    fail("input is missing required field(s): " + missing.join(", "));
  }
  if (!DATE_RE.test(payload.date)) {
    fail("date must be in YYYY-MM-DD format, got: " + payload.date);
  }
  if (!Array.isArray(payload.items)) {
    fail("items must be an array");
  }
  payload.items.forEach((item, idx) => {
    ["card_slug", "card_name", "issuer", "change_type", "summary"].forEach((field) => {
      if (!item[field]) {
        fail("items[" + idx + "] is missing required field: " + field);
      }
    });
  });
}

function deriveIssuers(items) {
  const set = new Set();
  items.forEach((item) => set.add(item.issuer));
  return Array.from(set).sort();
}

function toMasterEntry(edition) {
  return {
    number: edition.number,
    date: edition.date,
    subject: edition.subject,
    summary: edition.summary,
    permalink: edition.permalink,
    issuers: edition.issuers,
    items: edition.items.map((item) => ({
      card_slug: item.card_slug,
      card_name: item.card_name,
      issuer: item.issuer,
      change_type: item.change_type,
      summary: item.summary,
      anchor: item.anchor,
    })),
  };
}

function sortByDateDesc(list) {
  return list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function flattenItemsByIssuer(newsletters) {
  const byIssuer = new Map();

  newsletters.forEach((entry) => {
    (entry.items || []).forEach((item) => {
      const flatItem = {
        card_slug: item.card_slug,
        card_name: item.card_name,
        issuer: item.issuer,
        change_type: item.change_type,
        summary: item.summary,
        edition_number: entry.number,
        edition_date: entry.date,
        edition_permalink: entry.permalink + "#" + item.card_slug,
      };

      if (!byIssuer.has(item.issuer)) {
        byIssuer.set(item.issuer, []);
      }
      byIssuer.get(item.issuer).push(flatItem);
    });
  });

  byIssuer.forEach((items, issuer) => {
    items.sort((a, b) => (a.edition_date < b.edition_date ? 1 : a.edition_date > b.edition_date ? -1 : 0));
  });

  return byIssuer;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    fail("missing required --input <path> argument");
  }
  if (!fs.existsSync(args.input)) {
    fail("input file not found: " + args.input);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(args.input, "utf8"));
  } catch (err) {
    fail("input file is not valid JSON: " + err.message);
  }

  validatePayload(payload);

  // "Verified news only" gate: cross-check every item against this repo's
  // own pipeline output (not just whatever the payload claims) before it's
  // allowed into newsletters.json and, downstream, the per-issuer feeds
  // that monzy.co reads. Anything that doesn't check out is dropped from
  // this edition, with the rest still published - see verifySourceMatch().
  const sourceData = {
    changes: readJson(CHANGES_PATH, []),
    launches: readJson(LAUNCHES_PATH, []),
    trackedCards: readJson(TRACKED_CARDS_PATH, []),
  };

  const droppedItems = [];
  const verifiedPayloadItems = args.allowUnverified
    ? payload.items
    : payload.items.filter((item) => {
        const result = verifySourceMatch(item, sourceData);
        if (!result.ok) {
          droppedItems.push({ card_name: item.card_name, issuer: item.issuer, reason: result.reason });
          return false;
        }
        return true;
      });

  if (args.allowUnverified) {
    process.stdout.write("--allow-unverified passed: skipping the verified-source gate for this publish.\n");
  }

  if (droppedItems.length) {
    process.stdout.write("Dropped " + droppedItems.length + " unverified item(s) from this edition:\n");
    droppedItems.forEach((d) => {
      process.stdout.write("  - " + d.card_name + " (" + d.issuer + "): " + d.reason + "\n");
    });
  }

  if (verifiedPayloadItems.length === 0) {
    fail("no items in this payload passed the verified-source check - nothing to publish. See dropped-item reasons above.");
  }

  const permalink = PERMALINK_BASE + "?date=" + payload.date;
  const items = verifiedPayloadItems.map((item) => ({
    card_slug: item.card_slug,
    card_name: item.card_name,
    issuer: canonicalIssuerSlug(item.issuer),
    change_type: item.change_type,
    summary: item.summary,
    anchor: item.card_slug,
  }));
  const issuers = deriveIssuers(items);

  const edition = {
    number: payload.number,
    date: payload.date,
    subject: payload.subject,
    summary: payload.summary,
    permalink: permalink,
    body_html: payload.body_html,
    items: items,
    issuers: issuers,
  };
  if (payload.body_markdown) {
    edition.body_markdown = payload.body_markdown;
  }

  const editionPath = path.join(EDITIONS_DIR, edition.date + ".json");
  writeJson(editionPath, edition);

  let newsletters = readJson(NEWSLETTERS_PATH, []);
  newsletters = newsletters.filter((entry) => entry.date !== edition.date);
  newsletters.push(toMasterEntry(edition));
  newsletters = sortByDateDesc(newsletters);
  writeJson(NEWSLETTERS_PATH, newsletters);

  const byIssuer = flattenItemsByIssuer(newsletters);

  const issuerFiles = [];
  issuers.forEach((slug) => {
    const flatItems = byIssuer.get(slug) || [];
    const issuerPath = path.join(BY_ISSUER_DIR, slug + ".json");
    writeJson(issuerPath, flatItems);
    issuerFiles.push(issuerPath);
  });

  const filesWritten = [editionPath, NEWSLETTERS_PATH, ...issuerFiles];

  process.stdout.write("Edition " + edition.number + " (" + edition.date + ") published.\n");
  process.stdout.write("Files written (" + filesWritten.length + "):\n");
  filesWritten.forEach((filePath) => {
    process.stdout.write("  " + path.relative(process.cwd(), filePath) + "\n");
  });
  process.stdout.write("Issuers touched: " + issuers.join(", ") + "\n");
  process.stdout.write(
    "Item count: " + items.length + (droppedItems.length ? " (" + droppedItems.length + " dropped as unverified)" : "") + "\n"
  );
}

main();
