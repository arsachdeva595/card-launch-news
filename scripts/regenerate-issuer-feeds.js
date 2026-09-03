#!/usr/bin/env node

// One-off script to rebuild every docs/data/by-issuer/*.json file from
// scratch, using the flat per-item schema (see scripts/publish-edition.js).
// Deletes all existing per-issuer files first so a stale file under an old
// slug (e.g. axis-bank.json before a slug rename) doesn't linger.
//
//   node scripts/regenerate-issuer-feeds.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { flattenItemsByIssuer } from "./lib/newsletter-verification.mjs";
import { readAutoVerifiedChanges } from "./lib/auto-verified-changes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOCS_DIR = path.join(__dirname, "..", "docs");
const DATA_DIR = path.join(DOCS_DIR, "data");
const BY_ISSUER_DIR = path.join(DATA_DIR, "by-issuer");
const NEWSLETTERS_PATH = path.join(DATA_DIR, "newsletters.json");

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

function main() {
  const newsletters = readJson(NEWSLETTERS_PATH, []);

  fs.mkdirSync(BY_ISSUER_DIR, { recursive: true });
  fs.readdirSync(BY_ISSUER_DIR).forEach((file) => {
    if (file === ".gitkeep") return;
    fs.unlinkSync(path.join(BY_ISSUER_DIR, file));
  });

  const byIssuer = flattenItemsByIssuer(newsletters, readAutoVerifiedChanges());

  let totalItems = 0;
  const issuersWritten = [];
  byIssuer.forEach((items, issuer) => {
    const issuerPath = path.join(BY_ISSUER_DIR, issuer + ".json");
    writeJson(issuerPath, items);
    issuersWritten.push(issuer);
    totalItems += items.length;
  });

  process.stdout.write("Regenerated " + issuersWritten.length + " issuer feed(s): " + issuersWritten.sort().join(", ") + "\n");
  process.stdout.write("Total items: " + totalItems + "\n");
}

main();
