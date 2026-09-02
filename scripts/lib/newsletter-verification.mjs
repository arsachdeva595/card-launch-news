// Shared by scripts/publish-edition.js (a light existence check at publish
// time) and scripts/regenerate-newsletter-tags.mjs (the full verified/
// unverified tagging pass, re-run daily) - both need identical matching
// logic against this repo's own pipeline data, or the two could disagree
// about the same item.

// Canonical short-form issuer slugs, keyed by every long-form slug an
// incoming payload might use (matching config/issuers.json's own "slug"
// field). Values already in canonical form map to themselves, so any
// issuer this table doesn't recognize passes through unchanged.
export const CANONICAL_ISSUER_SLUGS = {
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

export function canonicalIssuerSlug(slug) {
  return CANONICAL_ISSUER_SLUGS[slug] || slug;
}

export function normalizeCardName(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Cross-checks one newsletter item against this repo's own pipeline data
 * (changes.json, launches.json, tracked-cards.json) rather than trusting
 * whatever the item claims about itself. Matching is by (card name,
 * canonical issuer) since a newsletter item's card_slug is hand-picked by
 * whoever authored the edition, not the same id format changes.json/
 * launches.json use internally.
 *
 * Returns:
 * - exists: false only when no record of this card/issuer exists anywhere
 *   (a typo or fabrication with nothing on record) - this is the one
 *   condition publish-edition.js drops an item for.
 * - status: "verified" if grounded in a launch's official page, a
 *   deterministically-confirmed discontinuation, or a Tier 1 change whose
 *   summary cleared Reddit/Google grounding (see lib/grounding.mjs) -
 *   "unverified" otherwise, including when the card exists but nothing
 *   corroborates this specific claim yet.
 * - officialLink: the card's own official product page, when known.
 * - verificationLink: the independent source (Reddit post / Google
 *   citation) that corroborated this claim, only set when status is
 *   "verified" and something more specific than the official page itself
 *   backs it.
 */
export function resolveItemVerification(item, { changes, launches, trackedCards }) {
  const wantName = normalizeCardName(item.card_name);
  const wantIssuer = canonicalIssuerSlug(item.issuer);

  const launchMatch = launches.find(
    (l) => normalizeCardName(l.cardName) === wantName && canonicalIssuerSlug(l.issuerSlug) === wantIssuer
  );
  const changeMatch = changes.find(
    (c) => normalizeCardName(c.cardName) === wantName && canonicalIssuerSlug(c.issuerSlug) === wantIssuer
  );
  const trackedMatch = trackedCards.find(
    (c) => normalizeCardName(c.cardName) === wantName && canonicalIssuerSlug(c.issuerSlug) === wantIssuer
  );

  const officialLink = launchMatch?.productPageUrl || changeMatch?.productPageUrl || trackedMatch?.url || null;

  if (!launchMatch && !changeMatch && !trackedMatch) {
    return { exists: false, status: "unverified", officialLink: null, verificationLink: null };
  }

  // A launch's "announcement" is the card's own official page, not an
  // LLM's reading of a diff - there's no hallucination-prone summarization
  // step in that path, so a launch match is trusted directly.
  if (launchMatch) {
    return {
      exists: true,
      status: "verified",
      officialLink,
      verificationLink: launchMatch.announcement?.url || officialLink
    };
  }

  // Discontinued status is set deterministically by regex-matching phrases
  // like "has been discontinued" in the page's own diff (see
  // scripts/lib/discontinuation.mjs), not by an LLM summarizing/interpreting
  // the change - so it's trusted from tracked-cards.json's own status
  // rather than requiring Reddit/Google corroboration of an LLM summary.
  if (item.change_type === "discontinued" && trackedMatch?.status === "Discontinued") {
    return { exists: true, status: "verified", officialLink, verificationLink: officialLink };
  }

  if (changeMatch?.summaryVerification?.status === "verified") {
    return {
      exists: true,
      status: "verified",
      officialLink,
      verificationLink: changeMatch.summaryVerification.source?.url || officialLink
    };
  }

  // The card/issuer is real (matched tracked-cards.json and/or
  // changes.json), but nothing corroborates this specific claim yet -
  // still published, just not asserted as confirmed.
  return { exists: true, status: "unverified", officialLink, verificationLink: null };
}

/**
 * Flattens every newsletter edition's items into one array per issuer,
 * newest first, with each item's parent edition info and verification tags
 * inlined - the shape scripts/publish-edition.js,
 * scripts/regenerate-issuer-feeds.js, and scripts/regenerate-newsletter-tags.mjs
 * all need to produce identically.
 */
export function flattenItemsByIssuer(newsletters) {
  const byIssuer = new Map();

  newsletters.forEach((entry) => {
    (entry.items || []).forEach((item) => {
      const flatItem = {
        card_slug: item.card_slug,
        card_name: item.card_name,
        issuer: item.issuer,
        change_type: item.change_type,
        summary: item.summary,
        status: item.status,
        official_link: item.official_link ?? null,
        verification_link: item.verification_link ?? null,
        edition_number: entry.number,
        edition_date: entry.date,
        edition_permalink: entry.permalink + "#" + item.card_slug
      };

      if (!byIssuer.has(item.issuer)) {
        byIssuer.set(item.issuer, []);
      }
      byIssuer.get(item.issuer).push(flatItem);
    });
  });

  byIssuer.forEach((items) => {
    items.sort((a, b) => (a.edition_date < b.edition_date ? 1 : a.edition_date > b.edition_date ? -1 : 0));
  });

  return byIssuer;
}
