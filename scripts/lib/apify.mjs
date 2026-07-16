const APIFY_API_BASE = "https://api.apify.com/v2";

/**
 * Runs an Apify actor synchronously (run-sync-get-dataset-items - blocks
 * until the run finishes and returns its dataset directly, no manual
 * polling) and returns the raw dataset items. Returns [] (never throws) if
 * the token is missing or the run fails, so callers degrade gracefully the
 * same way every other search integration in this project does.
 */
export async function runActorSync(actorId, input, { timeoutSecs = 60 } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.warn(`  ! APIFY_TOKEN not set, skipping Apify actor: ${actorId}`);
    return [];
  }

  try {
    const url = `${APIFY_API_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&timeout=${timeoutSecs}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    if (!res.ok) {
      console.warn(`  ! Apify actor ${actorId} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return [];
    }
    return await res.json();
  } catch (err) {
    console.warn(`  ! Apify actor ${actorId} error: ${err.message}`);
    return [];
  }
}

/**
 * Logs a diagnostic sample when an actor returned data but our field
 * mapping produced zero usable results - almost always means the actor's
 * output schema doesn't match what we guessed, not that there's nothing
 * there. Makes that failure mode fixable instead of silently empty.
 */
export function warnIfMappingFailed(label, rawItems, mappedResults) {
  if (rawItems.length > 0 && mappedResults.length === 0) {
    console.warn(
      `  ! ${label}: Apify returned ${rawItems.length} item(s) but none mapped to a usable result. ` +
        `Raw sample (check field names against scripts/lib/${label.toLowerCase()}.mjs): ` +
        JSON.stringify(rawItems[0]).slice(0, 400)
    );
  }
}
