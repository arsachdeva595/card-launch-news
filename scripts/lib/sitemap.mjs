// Several issuer WAFs (Akamai/Imperva-style) block generic bot user-agents
// even on public sitemap.xml files that exist specifically to be crawled.
// A standard browser UA avoids those false-positive blocks.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 30000;
const MAX_SITEMAP_INDEX_DEPTH = 3;

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml,*/*" },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Some sitemaps (e.g. DBS) namespace-prefix every element, e.g. <ns1:url>,
// <ns1:loc> instead of <url>, <loc> — the optional (?:\w+:)? prefix handles both.
function extractBlocks(xml, tagName) {
  const blockRe = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, "gi");
  const blocks = [];
  let match;
  while ((match = blockRe.exec(xml)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractTag(block, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, "i");
  const match = re.exec(block);
  return match ? match[1].trim() : null;
}

/**
 * Fetches a sitemap URL, transparently following sitemap-index files, and
 * returns a flat list of { loc, lastmod } entries from all leaf urlsets.
 */
export async function fetchSitemapUrls(sitemapUrl, depth = 0) {
  if (depth > MAX_SITEMAP_INDEX_DEPTH) return [];

  const xml = await fetchText(sitemapUrl);
  const isIndex = /<(?:\w+:)?sitemapindex[\s>]/i.test(xml);

  if (isIndex) {
    const childSitemaps = extractBlocks(xml, "sitemap")
      .map((block) => extractTag(block, "loc"))
      .filter(Boolean);

    const results = [];
    for (const childUrl of childSitemaps) {
      try {
        const childEntries = await fetchSitemapUrls(childUrl, depth + 1);
        results.push(...childEntries);
      } catch (err) {
        console.warn(`  ! failed to fetch child sitemap ${childUrl}: ${err.message}`);
      }
    }
    return results;
  }

  return extractBlocks(xml, "url")
    .map((block) => ({
      loc: extractTag(block, "loc"),
      lastmod: extractTag(block, "lastmod")
    }))
    .filter((entry) => entry.loc);
}
