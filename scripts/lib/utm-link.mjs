// Every "check the official page" link generated alongside an AI summary
// carries this UTM tag, so clicks originating from a Monzy-authored
// summary/notification are attributable as coming from Monzy rather than
// generic referral traffic.
export function withMonzyUtm(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("utm_source", "monzy");
    return parsed.toString();
  } catch {
    return url;
  }
}
