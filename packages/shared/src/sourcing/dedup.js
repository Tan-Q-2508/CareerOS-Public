// Dedup key for a job posting (spec 4.4): URL-first, since title+company alone
// wrongly merges genuinely different postings. Prefer the LinkedIn job id, then
// the normalized URL, then title|company|location as a last resort.

function extractLinkedInJobId(url) {
  if (!url) return null;
  let m = url.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/);
  if (m) return m[1];
  m = url.match(/[?&]currentJobId=(\d{6,})/);
  if (m) return m[1];
  return null;
}

function normalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

function dedupKey({ id, link, title, companyName, location, atsPlatform, atsSlug }) {
  // ATS Direct (4.6) FIRST, and deliberately so — both fallbacks below are
  // actively wrong for these postings, confirmed against a real Greenhouse
  // board:
  //   * the normalized URL collapses them. Stripe's absolute_url is
  //     "https://stripe.com/jobs/search?gh_jid=8023928" — the job id lives in
  //     the QUERY string, which normalizeUrl drops, so all 549 of Stripe's
  //     postings would share the single key "url:https://stripe.com/jobs/search"
  //     and 548 of them would silently vanish as duplicates.
  //   * the numeric-id branch below puts them in the WRONG namespace. Greenhouse
  //     ids are 7-8 digits, so they match /^\d{6,}$/ and would be tagged "ld:",
  //     colliding with the LinkedIn job-id space.
  // The platform+slug prefix also keeps two companies' boards from ever
  // colliding on a per-platform-sequential id.
  if (atsPlatform && atsSlug && id != null && String(id) !== '') {
    return `ats:${atsPlatform}:${atsSlug}:${id}`;
  }
  // Prefer the actor's explicit LinkedIn job id when present; else extract it
  // from the URL; else the normalized URL; else title|company|location (4.4).
  if (id != null && /^\d{6,}$/.test(String(id))) return `ld:${id}`;
  const fromUrl = extractLinkedInJobId(link);
  if (fromUrl) return `ld:${fromUrl}`;
  const norm = normalizeUrl(link);
  if (norm) return `url:${norm}`;
  const parts = [title, companyName, location].map((s) => (s || '').trim().toLowerCase());
  return `tcl:${parts.join('|')}`;
}

module.exports = { dedupKey, extractLinkedInJobId, normalizeUrl };
