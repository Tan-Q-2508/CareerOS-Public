// Recruitee adapter — ATS Direct, SMB/startup platform set (§15 #65).
//
// Public careers-site API, verified live 2026-09-26:
//   GET https://{slug}.recruitee.com/api/offers/
//     -> { offers: [{ id, slug, title, description (HTML), requirements (HTML),
//          location, city, state_name, country, locations[], remote, hybrid,
//          published_at, careers_url, company_name, employment_type_code,
//          experience_code, salary: { min, max, currency, period }, status }] }
// One request returns the whole board with descriptions inlined — the
// Greenhouse/Workable shape, no per-posting detail call. An unknown slug is a
// clean 404, so a 200 genuinely proves the board exists (unlike
// SmartRecruiters, whose unknown company answers 200 with nothing).
//
// `company_name` is on every offer, which is what lets detect.js name-verify
// a guessed slug here (VERIFIES_BOARD_NAME). A real board with no open offers
// probes ok with no board name, so a GUESSED slug for it is rejected by the
// verification step rather than accepted unverified — the conservative side
// of 4.6.2's false-positive rule.
//
// Companies that point a custom domain at Recruitee (careers.bunq.com) still
// answer on {slug}.recruitee.com; only the {slug}.recruitee.com shape is
// URL-matched, since a custom domain carries no platform signature.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { fetchJson, streamBoard, cleanTitles, titleMatchesAny, toIso } = require('./webFetch');

const platform = 'recruitee';

function boardUrl(slug) {
  return `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
}

function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const m = /^([a-z0-9-]+)\.recruitee\.com$/.exec(parsed.hostname.toLowerCase());
  if (!m || m[1] === 'www' || m[1] === 'app' || m[1] === 'api') return null;
  return { platform, slug: m[1] };
}

async function probe(slug) {
  if (!slug) return { ok: false, status: 0, boardName: null, error: 'missing identifier' };
  try {
    // First offer only, then stop reading: a board can be 70 MB (emplyfy), and
    // a probe needs one offer's company_name, not the whole listing.
    const firstOffer = await streamBoard(boardUrl(slug), {
      platform,
      pick: 'offers',
      makeHandler: () => {
        let first = null;
        return { onItem: (o) => { first = o; return false; }, result: () => first };
      },
    });
    if (firstOffer) return { ok: true, status: 200, boardName: firstOffer.company_name || null, error: null };
    // No offer streamed: either a real board with none open (tiny) or a 200 that
    // is not a board. Read it whole (size-capped) to tell the two apart.
    const body = await fetchJson(boardUrl(slug), { platform });
    const offers = Array.isArray(body?.offers) ? body.offers : null;
    if (!offers) return { ok: false, status: 200, boardName: null, error: 'no offers array' };
    return { ok: true, status: 200, boardName: (offers[0] && offers[0].company_name) || null, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function locationOf(o) {
  if (o.location) return o.location;
  const first = Array.isArray(o.locations) ? o.locations[0] : null;
  const src = first || o;
  return [src.city, src.state || src.state_name, src.country].filter(Boolean).join(', ') || null;
}

function num(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : null;
}

function normalizeItem(o, { slug, companyName }) {
  const id = o.id != null ? String(o.id) : null;
  const link = o.careers_url || (o.slug ? `https://${slug}.recruitee.com/o/${o.slug}` : null);
  const loc = locationOf(o);
  const salary = o.salary || {};
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: o.title || null,
    companyName: companyName || o.company_name || null,
    location: o.remote && loc && !/remote/i.test(loc) ? `${loc} (Remote)` : loc || (o.remote ? 'Remote' : null),
    postedAt: toIso(o.published_at || o.created_at),
    link,
    descriptionText: null, // filled after `keep` passes — see fetchJobs
    seniorityLevel: o.experience_code || null,
    employmentType: o.employment_type_code || null,
    // Only a yearly figure is stored — a monthly or hourly number in a salary
    // column would read as a wildly wrong annual one.
    salaryMin: salary.period === 'year' ? num(salary.min) : null,
    salaryMax: salary.period === 'year' ? num(salary.max) : null,
    dedupKey: dedupKey({ id, link, title: o.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  // Streamed, never buffered: one real board (emplyfy) is 70 MB, and reading
  // it whole took the server past Render's memory limit mid-scan. Each offer is
  // filtered as it is tokenized, so only the kept ones are ever held.
  return streamBoard(boardUrl(slug), {
    platform,
    pick: 'offers',
    makeHandler: () => {
      const kept = [];
      return {
        onItem: (o) => {
          if (o.status && o.status !== 'published') return true;
          if (!titleMatchesAny(o.title, t)) return true;
          const job = normalizeItem(o, { slug, companyName });
          if (!job.title || !job.link) return true;
          if (keep && !keep(job)) return true;
          job.descriptionText = [htmlToText(o.description), htmlToText(o.requirements)].filter(Boolean).join('\n\n') || null;
          kept.push(job);
          return kept.length < cap;
        },
        result: () => kept,
      };
    },
  });
}

const CONTRACT_CHECK_SLUG = 'bunq';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'boardName'],
  run: async () => {
    const p = await probe(CONTRACT_CHECK_SLUG);
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'bunq', limit: 1 });
    const first = jobs[0] || {};
    return {
      jobs: jobs.length ? jobs : null,
      firstTitle: first.title || null,
      firstLink: first.link || null,
      firstDescription: first.descriptionText || null,
      firstPostedAt: first.postedAt || null,
      boardName: p.boardName || null,
    };
  },
};

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };
