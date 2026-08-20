#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOCS_DIR = path.join(__dirname, "..", "docs");
const DATA_DIR = path.join(DOCS_DIR, "data");
const EDITIONS_DIR = path.join(DATA_DIR, "editions");
const BY_ISSUER_DIR = path.join(DATA_DIR, "by-issuer");
const NEWSLETTERS_PATH = path.join(DATA_DIR, "newsletters.json");
const PERMALINK_BASE = "https://arsachdeva595.github.io/card-launch-news/edition/";

const REQUIRED_FIELDS = ["number", "date", "subject", "summary", "body_html", "items"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
  process.stderr.write("Error: " + message + "\n");
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") {
      args.input = argv[i + 1];
      i++;
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

  const permalink = PERMALINK_BASE + "?date=" + payload.date;
  const issuers = deriveIssuers(payload.items);
  const items = payload.items.map((item) => ({
    card_slug: item.card_slug,
    card_name: item.card_name,
    issuer: item.issuer,
    change_type: item.change_type,
    summary: item.summary,
    anchor: item.card_slug,
  }));

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
  process.stdout.write("Item count: " + items.length + "\n");
}

main();
