import { searchReddit } from "./reddit.mjs";

const SUBREDDIT = "CreditCardsIndia";
const BETWEEN_QUERY_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Searches r/CreditCardsIndia specifically (via Reddit's own
 * "subreddit:name" search qualifier) for posts about one card. Deliberately
 * separate from the general (unscoped) Reddit search used for each card's
 * own "community sentiment" section - this one backs the dedicated "Reddit
 * Buzz" feed, which only ever shows posts tied to an actual launch/change,
 * never general subreddit browsing.
 */
export async function findRedditBuzz(cardName, { limit = 2 } = {}) {
  await sleep(BETWEEN_QUERY_DELAY_MS);
  return searchReddit(`subreddit:${SUBREDDIT} ${cardName}`, { limit });
}

/**
 * Given this run's newly-detected launches/changes, searches r/CreditCardsIndia
 * for each and returns a flat list of buzz entries (one per matching post).
 * Cards with no matching post contribute nothing - this list is only ever
 * "real discussion found", never a placeholder.
 */
export async function collectRedditBuzz({ newLaunches, newChanges }) {
  const entries = [];

  for (const launch of newLaunches) {
    const posts = await findRedditBuzz(launch.cardName);
    for (const post of posts) {
      entries.push({
        id: `${launch.id}-${Buffer.from(post.url).toString("base64url").slice(0, 16)}`,
        cardName: launch.cardName,
        issuerName: launch.issuerName,
        kind: "launch",
        postTitle: post.title,
        postUrl: post.url,
        snippet: post.description,
        detectedAt: new Date().toISOString()
      });
    }
  }

  for (const change of newChanges) {
    const posts = await findRedditBuzz(change.cardName);
    for (const post of posts) {
      entries.push({
        id: `${change.id}-${Buffer.from(post.url).toString("base64url").slice(0, 16)}`,
        cardName: change.cardName,
        issuerName: change.issuerName,
        kind: "change",
        postTitle: post.title,
        postUrl: post.url,
        snippet: post.description,
        detectedAt: new Date().toISOString()
      });
    }
  }

  return entries;
}
