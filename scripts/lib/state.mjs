import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PATHS = {
  issuers: path.join(ROOT, "config", "issuers.json"),
  settings: path.join(ROOT, "config", "settings.json"),
  trackedCards: path.join(ROOT, "config", "tracked-cards.json"),
  snapshotsDir: path.join(ROOT, "data", "sitemap-snapshots"),
  pageHashesDir: path.join(ROOT, "data", "page-hashes"),
  lastmodSnapshotsDir: path.join(ROOT, "data", "lastmod-snapshots"),
  launches: path.join(ROOT, "docs", "data", "launches.json"),
  changes: path.join(ROOT, "docs", "data", "changes.json"),
  meta: path.join(ROOT, "docs", "data", "meta.json")
};

export async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function snapshotPathFor(issuerSlug) {
  return path.join(PATHS.snapshotsDir, `${issuerSlug}.json`);
}

export function pageHashPathFor(issuerSlug) {
  return path.join(PATHS.pageHashesDir, `${issuerSlug}.json`);
}

export function lastmodSnapshotPathFor(issuerSlug) {
  return path.join(PATHS.lastmodSnapshotsDir, `${issuerSlug}.json`);
}
