#!/usr/bin/env node
// import-ats-slugs.js — bulk import of externally-sourced company->board
// mappings into company_ats_registry (spec 4.6.1/4.6.5), for every platform
// that has an adapter and a matching source list.
//
// Source: one CSV per platform from github.com/kalil0321/ats-scrapers
// (`ats-companies/`), snapshotted at data/ats-research/kalil0321-ats-scrapers
// with its SOURCE.md. Only `name` and `url` are read — the source's own `slug`
// column is not our identifier shape (its Workday slug drops the wdN data
// centre, its Oracle slug drops region and site), so each adapter's own
// extractSlugFromUrl derives the identifier from the URL. --dir overrides the
// folder for a refreshed download.
//
// COMMITTED, not an ephemeral scratch script: re-runnable for a future
// slug-list refresh, and the one place these skip rules live.
//
// Usage (from repo root):
//   node scripts/import-ats-slugs.js --dry-run
//   node scripts/import-ats-slugs.js --apply
//   node scripts/import-ats-slugs.js --apply --only=smartrecruiters,bamboohr
//
// Every candidate is live-probed through its own adapter before it can be
// written — a bulk directory is a third party's claim, and a board that does
// not answer for us is not a board we can scan. Workable is probed like every
// other platform (its adapter serializes its own requests at
// tunables.atsDirect.platforms.workable.minRequestIntervalMs), and a Workable
// board must also list at least one job: empty Workable accounts squatting
// big-company names are a measured failure mode (4.6.4).
//
// A probe that fails for a reason that could be ours or momentary — timeout,
// network error, 429/403/5xx — is retried in later passes (--retry-passes,
// with a cool-down between) rather than dropped. Only a definite answer
// (404, an empty board, a response of the wrong shape) rejects a candidate.
//
// Measured probe-rate behaviour (2026-09-27, the numbers behind the default
// concurrency, per platform): 300 distinct-board probes at concurrency 8 against each of
// Greenhouse, Lever, Ashby, SmartRecruiters, Rippling, BambooHR, Breezy and
// iCIMS drew no 429 or throttling 403; 30 back-to-back probes of one board on
// every platform were clean, except Recruitee, which 429s a single tenant past
// ~5 CONCURRENT requests, and 429s ACROSS tenants at a sustained ~20/s — 1,100
// probes at concurrency 8 lost 875 to 429 — while 300 probes at 250ms spacing
// were clean. That cross-tenant limit is why Recruitee carries a platform-wide
// floor in tunables.atsDirect.minPlatformIntervalMs, applied inside the adapter
// to probes and scans alike.
//
// Skip rules, per candidate:
//   1. blank/unusable normalized name
//   2. a duplicate name, or a duplicate board, within the same file
//   3. the board is already in company_ats_registry under any name — a second
//      row would scan the same board twice
//   4. the normalized name is already in company_ats_registry — an existing
//      mapping always wins; this import never overwrites one
//   5. no usable identifier from the URL. The adapter's own extractSlugFromUrl
//      decides, with one deliberate fallback: SuccessFactors' parser reads
//      job-posting URLs, and this source lists career-site roots
//      (`jobs.dana.com`, `ace1950.jobs2web.com`), which are exactly the
//      adapter's identifier shape (host[/prefix]). The root is used as-is and
//      the mandatory probe is what proves it.
//   6. the probe failed definitively
//   6a. Eightfold only: a tenant whose classic API refuses us (403) is tried
//      once more through the `phenom` adapter's pcsx API, and registered as
//      `phenom` if that answers (see eightfoldViaPcsx).
//   7. the same normalized name probed ok on more than one platform — the
//      earlier platform in PLATFORMS order wins. Resolved AFTER probing, so a
//      dead board on one platform never blocks a live one on another.
// A company that resolves here and was parked in company_ats_unresolved is
// deleted from that table — 4.6.5 keeps a company in exactly one of the two.
//
// Writes a run log (inserted ids, rejects, retries) to
// data/ats-research/import-runs/, which is how the follow-up steps —
// sector classification and the sponsor-list relink — know what was added.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { atsDirect } = require('@careeros/shared');
const { normalizeCompanyName } = atsDirect;

// Order is the cross-platform tie-break (skip rule 7): enterprise boards the
// company runs itself first, Workable last for its squatter history.
const PLATFORMS = [
  'workday',
  'oracle',
  'successfactors',
  'icims',
  'eightfold',
  'avature',
  'greenhouse',
  'ashby',
  'lever',
  'smartrecruiters',
  'rippling',
  'bamboohr',
  'breezy',
  'recruitee',
  'workable',
];

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'ats-research', 'kalil0321-ats-scrapers');
const RUN_DIR = path.join(__dirname, '..', 'data', 'ats-research', 'import-runs');


// Minimal PostgREST client used INSTEAD OF @careeros/shared's getSupabaseAdmin
// (which wraps @supabase/supabase-js) — found live 2026-08-27, in this
// script specifically, that the installed supabase-js client throws "JWT
// issued at future" when constructed with this project's current
// SUPABASE_SERVICE_ROLE_KEY, which is the newer non-JWT `sb_secret_...`
// format, not a legacy JWT. Confirmed the key itself is fine: a bare fetch
// straight to `${SUPABASE_URL}/rest/v1/...` with the same key as both
// `apikey` and `Authorization: Bearer` headers returns a clean 200 — the
// failure is isolated to the client library's own internal handling of this
// key shape, not the credential, not the database, and not this project's
// RLS. Scoped to this one script rather than touching
// `packages/shared/src/supabaseAdmin.js` (used everywhere else in the app,
// including production) without first confirming the same failure actually
// reproduces there — out of scope for a bulk-import run. Implements only the
// handful of query-builder methods this file actually calls.
function makeRestDb(url, key) {
  function from(table) {
    let method = null;
    let queryParts = [];
    let body = null;
    let wantsRepresentation = false;

    const builder = {
      select(cols) {
        if (!method) {
          method = 'GET';
          queryParts.push(`select=${encodeURIComponent(cols)}`);
        } else {
          // insert(...).select(...) — ask PostgREST to return the inserted rows.
          wantsRepresentation = true;
        }
        return builder;
      },
      order(col, { ascending = true } = {}) {
        queryParts.push(`order=${encodeURIComponent(col)}.${ascending ? 'asc' : 'desc'}`);
        return builder;
      },
      range(from_, to_) {
        queryParts.push(`offset=${from_}`, `limit=${to_ - from_ + 1}`);
        return builder;
      },
      insert(rows) {
        method = 'POST';
        body = JSON.stringify(rows);
        return builder;
      },
      delete() {
        method = 'DELETE';
        return builder;
      },
      in(col, values) {
        queryParts.push(`${col}=in.(${values.map((v) => String(v)).join(',')})`);
        return builder;
      },
      then(resolve, reject) {
        exec().then(resolve, reject);
      },
    };

    async function exec() {
      const qs = queryParts.length ? `?${queryParts.join('&')}` : '';
      const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
      if (method === 'POST') headers.Prefer = wantsRepresentation ? 'return=representation' : 'return=minimal';
      try {
        const resp = await fetch(`${url}/rest/v1/${table}${qs}`, { method: method || 'GET', headers, body });
        const raw = await resp.text();
        if (!resp.ok) {
          let message = raw.slice(0, 300);
          try {
            const parsed = JSON.parse(raw);
            message = parsed.message || message;
          } catch {
            /* non-JSON error body, keep raw slice */
          }
          return { data: null, error: { message } };
        }
        const data = raw ? JSON.parse(raw) : null;
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message || String(e) } };
      }
    }

    return builder;
  }
  return { from };
}


// Minimal RFC4180 CSV parser — a naive split(',') corrupts every quoted-comma
// row (162 of them across the two files: "Advance Auto Parts, Inc", etc).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1);
}

function loadRows(dir, platform) {
  const file = path.join(dir, `${platform}.csv`);
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const [header, ...body] = rows;
  const nameIdx = header.indexOf('name');
  const urlIdx = header.indexOf('url');
  const domainIdx = header.indexOf('domain');
  return body.map((r) => ({ name: r[nameIdx], url: r[urlIdx], domain: domainIdx >= 0 ? r[domainIdx] || null : null }));
}

async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return out;
}

// PostgREST caps an unfiltered select at 1000 rows (the standing repo gotcha —
// see classify-sectors.js/registry.js for the same helper shape).
async function selectAll(db, table, columns) {
  const pageSize = 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await db.from(table).select(columns).order('id', { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, concurrency: 8, retryPasses: 3, cooldownMs: 60000, dir: DEFAULT_DIR, only: null };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.slice('--concurrency='.length));
    else if (raw.startsWith('--retry-passes=')) args.retryPasses = Number(raw.slice('--retry-passes='.length));
    else if (raw.startsWith('--cooldown-ms=')) args.cooldownMs = Number(raw.slice('--cooldown-ms='.length));
    else if (raw.startsWith('--dir=')) args.dir = raw.slice('--dir='.length);
    else if (raw.startsWith('--only=')) args.only = new Set(raw.slice('--only='.length).split(','));
  }
  return args;
}

function identifierFor(platform, url) {
  const extracted = atsDirect[platform].extractSlugFromUrl(url);
  if (extracted && extracted.slug) return extracted.slug;
  if (platform === 'successfactors') {
    try {
      const u = new URL(String(url));
      if (/(^|\.)successfactors\.(com|eu)$/i.test(u.hostname)) return null; // classic portal, unsupported
      const prefix = u.pathname.replace(/^\/+|\/+$/g, '');
      return prefix ? `${u.hostname.toLowerCase()}/${prefix}` : u.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

const boardKey = (platform, slug) => `${platform}|${String(slug).toLowerCase()}`;

/**
 * Parse one platform's CSV into candidates, applying skip rules 1, 2 and 5.
 */
// iCIMS companies often run several portals — regional (emea-, german-),
// role-specific (drivers-, physicians-, internships-) and the main one
// (careers-, uscareers-). The registry holds one board per company, and the
// first row in the file used to win, which registered Bruker's German portal
// and Latham & Watkins' Asia associates portal. Ranking puts the main portal
// first so the in-file dedup keeps it.
const PORTAL_REGION = /emea|apac|asia|europe|german|spanish|espanol|french|canada|canadian|^uk|india|mexico|latam|china|japan|intl|international|netherlands|prague|belgium|inuktitut|australia|brazil|poland|italy|ireland|singapore|korea|philippines|global/;
const PORTAL_ROLE = /driver|physician|doctor|provider|nurse|intern|student|recovery|volunteer|distribution|frontline|wage|clinical|allied|^app$|security|startup|admin|campus|retail|store|hourly|warehouse|field|seasonal|executive|faculty|residency|temp|contract|pillar|lenddirect|holiday/;
function icimsPortalScore(host) {
  const prefix = String(host).replace(/\.icims\.com$/, '').split('-')[0];
  let score = 0;
  if (prefix === 'careers') score += 6;
  else if (/^(uscareers|us|external|jobs|corporatecareers|englishcareers|careersus|careers2)$/.test(prefix)) score += 4;
  else if (/careers/.test(prefix)) score += 2;
  if (/^us|english|corporate|professional/.test(prefix)) score += 1;
  if (PORTAL_REGION.test(prefix)) score -= 6;
  if (PORTAL_ROLE.test(prefix)) score -= 4;
  return score;
}

function buildCandidates(dir, platform) {
  let rows = loadRows(dir, platform);
  if (platform === 'icims') {
    const hostOf = (u) => identifierFor('icims', u) || '';
    rows = rows.map((r, i) => ({ r, i, s: icimsPortalScore(hostOf(r.url)) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
  }
  const seenNames = new Set();
  const seenBoards = new Set();
  const candidates = [];
  const tally = { rows: rows.length, blankName: 0, dupInFile: 0, noIdentifier: 0 };
  for (const { name, url, domain } of rows) {
    const normalized = normalizeCompanyName(name);
    if (!normalized) {
      tally.blankName++;
      continue;
    }
    const slug = identifierFor(platform, url);
    if (!slug) {
      tally.noIdentifier++;
      continue;
    }
    const key = boardKey(platform, slug);
    if (seenNames.has(normalized) || seenBoards.has(key)) {
      tally.dupInFile++;
      continue;
    }
    seenNames.add(normalized);
    seenBoards.add(key);
    candidates.push({ platform, list: platform, normalized, display: String(name).trim(), slug, domain });
  }
  return { candidates, tally };
}

// Could the failure be ours or momentary? Those are retried; the rest reject.
function isTransient(result) {
  const s = result.status;
  if (s === 429 || s === 403 || s === 408 || (s >= 500 && s < 600)) return true;
  if (s === 0 || s == null) return !/malformed|missing identifier/i.test(String(result.error || ''));
  return false;
}

// An Eightfold tenant whose classic API is WAF-blocked (403) very often
// still answers Eightfold's newer pcsx API, which the `phenom` adapter speaks
// (the same finding that put Morgan Stanley and Lockheed Martin on `phenom`,
// §15 #65). pcsx needs the brand domain: the directory's `domain` column when
// it has one, else `{subdomain}.com` — a wrong guess answers 403/empty and the
// probe rejects it, never a different company's board.
async function eightfoldViaPcsx(c) {
  const host = String(c.slug).split(':')[0];
  const domain = c.domain || `${host.split('.')[0]}.com`;
  const slug = `${host}:${domain}`;
  const p = await atsDirect.phenom.probe(slug);
  return p.ok ? { platform: 'phenom', slug } : null;
}

// ---------------------------------------------------------------------------
// Names. The directory's name column is not an identity: every BambooHR name
// and most SmartRecruiters/Rippling/Breezy/Recruitee/Workable names in it are
// the slug ("Generalcatalyst"), and SuccessFactors names are page titles
// ("Careers at EY: search jobs"). A slug-name squats a real company's name
// ("Seagate" on a small business's seagate BambooHR account) and never matches
// a legal name in visa_sponsors. So a row is named, in order, by the name the
// board gives itself, then by its page title with the boilerplate removed,
// then by the directory — and that result, not the directory's name, is what
// skip rules 4 and 7 compare.
// ---------------------------------------------------------------------------

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const decodeHtml = (t) => t.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// BambooHR's list API carries no company name; its careers page's og:site_name does.
async function ogSiteName(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA_BROWSER, Accept: 'text/html', 'Accept-Language': 'en-US' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const m = (await r.text()).match(/og:site_name"\s+content="([^"]+)"/i);
    return m ? decodeHtml(m[1]) : null;
  } catch {
    return null;
  }
}

const JUNK_SELF = /^(careers?|jobs?|current openings|home|default portal|job board|careers? page|open positions|join (us|our team)|hiring|recruiting|apply)$/i;
const TITLE_LIKE = /career|karriere|carri[eè]re|empleo|trabaj|talento|vacatur|stellen|jobs? at|search jobs|job opportunit|candidate experience|default portal|job board|job offers|^jobs?$|opportunit|recruit(ing|ment) site|join (us|our)|work (with|at|for) |portal|^home$|welcome|bewerb/i;
const LEAD = /^(?:welcome to |apply online for |search |open |current |available |explore |view |(?:work for|join the team at|join)\s+(?=\S+(?:\s+\S+){0,5}$)(?:careers? )?)?(?:careers?|jobs?(?: and careers)?|jobs? & careers|career opportunities|careers? opportunities|job opportunities|opportunities|openings|karriere(?: & jobs| und jobs)?|stellenangebote|stellen|jobportal|bewerberportal|bewerbungsportal|trabajos?|trabaja|empleos?|carri[eè]res?(?: et offres d'emploi)?|vacatures)\s+(?:at|@|with|in|chez|bei(?: der)?|der|en|for|bij)\s+(.+)$/i;
const TRAIL = /^(?:welcome to )?(.+?)\s+(?:careers?(?: site| portal| centre| center| home| search agents)?|jobs?|karriere(?:portal)?|jobportal|career portal|careers? page|job opportunities|opportunities|carriere)$/i;
const BOILER = /^(your|our|the|join|jetzt bewerben|west)$|\bjetzt\b|\bbewerben\b|^work for|^join |forward your|do your best|career|karriere|carri[eè]re|\bjobs?\b|job ?portal|opportunit|\bsite\b|\bpage\b|portal|apply|volunteer|current|available|listados|ofertas|stellen|vacatur|\bbij\b|\bchez\b|empleo|trabaj|talento|^welcome\b|^explore (?:careers|jobs)\b|\bsearch (?:jobs|agents)\b|^search\b|\bhome\b|openings|^the$|^group$|icims|jobs2web/i;
const PURE = /^(careers?|jobs?|job|empleo|trabajos|talento|carrieres|carri[eè]res|stellenb[oö]rse|career opportunities|job opportunities|opportunities|careers? page|careerspage|careers and job opportunities|trabajaconnosotros|trabajaenclaro|globalcareers|careersemea|groupcareers)$/i;
const titleCase = (w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));

// A pure-boilerplate title on the company's OWN domain ("Empleo" on
// empleo.abanca.com) names the company by that domain; a shared vendor host
// (icims.com, jobs2web.com) names nobody.
function nameFromOwnHost(slug) {
  const host = String(slug).split(/[/:]/)[0].toLowerCase();
  if (/icims\.com$|jobs2web\.com$|oraclecloud\.com$|sapsf|hr\.cloud\.sap$/.test(host)) return null;
  let labels = host.split('.').slice(0, -1);
  if (labels.length > 1 && /^(co|com|gov|org|ac|net|edu)$/.test(labels[labels.length - 1])) labels = labels.slice(0, -1);
  const pick = labels.filter((l) => !/^(careers?|jobs?|job|mycareer|empleo|trabajos|talento|carrieres|karriere|greatjobs|www|apply|join|work|opportunities|external|recruiting|globalcareers|careersemea|careerhk|trabajaconnosotros|trabajaenclaro|canaldeempleo)$/.test(l));
  const label = pick.length ? pick[pick.length - 1] : null;
  return label && label.replace(/[^a-z]/g, '').length >= 3 ? label.split('-').map(titleCase).join(' ') : null;
}

// Strip a page title down to the company it names, or null when unsure — null
// keeps the directory's name, which is never worse than a wrong guess.
function nameFromTitle(display, slug) {
  const raw = String(display).replace(/[®™•]/g, ' ').replace(/\s+/g, ' ').trim();
  if (PURE.test(raw)) return nameFromOwnHost(slug);
  const segs = raw.split(/\s+[|–—]\s+|\s+-\s+|:\s+/).map((x) => x.trim()).filter(Boolean);
  for (const seg of segs) {
    let m = seg.match(LEAD);
    let name = m ? m[1] : null;
    if (!name) {
      m = seg.match(TRAIL);
      name = m ? m[1] : null;
    }
    if (!name) {
      const fused = seg.match(/^(?:careers?(?:at)?)?([a-z]{4,})(?:careers?)$/i) || seg.match(/^careers?at([a-z]{4,})$/i);
      if (fused && /careers?/i.test(seg)) name = titleCase(fused[1].toLowerCase());
    }
    if (!name && segs.length > 1 && !BOILER.test(seg)) name = seg;
    if (name) {
      name = name.replace(/[.,!]+$/, '').replace(/'s$/i, '').replace(/\s+/g, ' ').trim();
      if (name.length >= 2 && !BOILER.test(name)) return name;
    }
  }
  return null;
}

function chooseName(c) {
  const self = c.selfName && String(c.selfName).replace(/\s+/g, ' ').trim();
  if (self && self.length >= 2 && !JUNK_SELF.test(self)) return self;
  if (TITLE_LIKE.test(c.display)) return nameFromTitle(c.display, c.slug) || c.display;
  return c.display;
}

async function probeOne(c) {
  const r = await probeOnce(c);
  if (!r.ok && c.platform === 'eightfold' && r.status === 403) {
    const alt = await eightfoldViaPcsx(c).catch(() => null);
    if (alt) {
      c.platform = alt.platform;
      c.slug = alt.slug;
      c.via = 'eightfold-pcsx';
      return { ok: true };
    }
    return { ...r, transient: false, error: `${r.error} (pcsx fallback also refused)` };
  }
  return r;
}

async function probeOnce(c) {
  try {
    const p = await atsDirect[c.platform].probe(c.slug);
    if (p.ok && c.platform === 'workable' && !(p.jobCount > 0)) {
      return { ok: false, transient: false, status: p.status, error: 'workable board lists no jobs' };
    }
    if (p.ok) c.selfName = p.boardName || (c.platform === 'bamboohr' ? await ogSiteName(`https://${c.slug}.bamboohr.com/careers`) : null);
    return { ok: !!p.ok, transient: !p.ok && isTransient(p), status: p.status, error: p.error || (p.ok ? null : 'probe not ok') };
  } catch (e) {
    const r = { status: e.status || 0, error: e.message || String(e) };
    return { ok: false, transient: isTransient(r), ...r };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.apply) {
    console.error('Usage: node scripts/import-ats-slugs.js (--dry-run | --apply) [--only=a,b] [--concurrency=N] [--retry-passes=N] [--cooldown-ms=N] [--dir=path]');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — check apps/server/.env');
    process.exit(1);
  }
  const db = makeRestDb(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const platforms = PLATFORMS.filter((p) => !args.only || args.only.has(p));

  console.log(`Loading CSVs from ${args.dir} ...`);
  const byPlatform = {};
  for (const platform of platforms) {
    if (!fs.existsSync(path.join(args.dir, `${platform}.csv`))) {
      console.log(`  ${platform}: no CSV, skipped`);
      continue;
    }
    byPlatform[platform] = buildCandidates(args.dir, platform);
    const t = byPlatform[platform].tally;
    console.log(`  ${platform}: ${t.rows} rows, blankName=${t.blankName}, dupWithinFile=${t.dupInFile}, noIdentifier=${t.noIdentifier}, parsed=${byPlatform[platform].candidates.length}`);
  }

  console.log('\nLoading existing registry + unresolved rows ...');
  const [registryRows, unresolvedRows] = await Promise.all([
    selectAll(db, 'company_ats_registry', 'id, company_name_normalized, platform, slug_or_identifier'),
    selectAll(db, 'company_ats_unresolved', 'id, company_name_normalized'),
  ]);
  const existingNames = new Set(registryRows.map((r) => r.company_name_normalized));
  const existingBoards = new Set(registryRows.map((r) => boardKey(r.platform, r.slug_or_identifier)));
  const unresolvedByName = new Map(unresolvedRows.map((r) => [r.company_name_normalized, r.id]));
  console.log(`  registry: ${registryRows.length} rows, unresolved: ${unresolvedRows.length} rows`);

  // Skip rules 3 and 4, before any network traffic.
  const toProbe = [];
  const summary = {};
  for (const platform of Object.keys(byPlatform)) {
    const s = (summary[platform] = { parsed: byPlatform[platform].candidates.length, boardExists: 0, nameExists: 0, renamedFromBoard: 0, probed: 0, ok: 0, rejected: 0, unresolvedTransient: 0, lostToEarlierPlatform: 0, inserted: 0, insertFailed: 0, unresolvedCleaned: 0 });
    for (const c of byPlatform[platform].candidates) {
      if (existingBoards.has(boardKey(c.platform, c.slug))) s.boardExists++;
      else if (existingNames.has(c.normalized)) s.nameExists++;
      else toProbe.push(c);
    }
    s.probed = s.parsed - s.boardExists - s.nameExists;
    console.log(`  ${platform}: board already registered=${s.boardExists}, name already registered=${s.nameExists}, to probe=${s.probed}`);
  }

  // Probe, then retry the transient failures after a cool-down.
  const rejects = [];
  const okSet = new Set();
  let pending = toProbe;
  for (let pass = 0; pass <= args.retryPasses && pending.length; pass++) {
    if (pass > 0) {
      console.log(`\nRetry pass ${pass}: ${pending.length} transient failures, cooling down ${args.cooldownMs / 1000}s first ...`);
      await new Promise((r) => setTimeout(r, args.cooldownMs));
    } else {
      console.log(`\nProbing ${pending.length} candidates (concurrency=${args.concurrency}) ...`);
    }
    const next = [];
    let done = 0;
    const t0 = Date.now();
    // One pool per platform, all platforms at once: each platform is its own
    // origin (or its own tenant farm), so the run takes as long as the slowest
    // platform rather than the sum of them. Workable serializes itself at its
    // own interval, so it gets a single worker; Recruitee's platform-wide
    // floor (tunables.atsDirect.minPlatformIntervalMs) paces it inside the
    // adapter.
    const groups = new Map();
    for (const c of pending) {
      if (!groups.has(c.platform)) groups.set(c.platform, []);
      groups.get(c.platform).push(c);
    }
    const handle = async (c) => {
      const r = await probeOne(c);
      if (r.ok) okSet.add(c);
      else if (r.transient) next.push({ c, r });
      else rejects.push({ ...c, status: r.status, error: String(r.error || '').slice(0, 200) });
      if (++done % 500 === 0) console.log(`  ${done}/${pending.length} probed (${Math.round((Date.now() - t0) / 1000)}s), ok so far ${okSet.size}`);
    };
    await Promise.all([...groups].map(([platform, list]) => pooled(list, platform === 'workable' ? 1 : args.concurrency, handle)));
    pending = next.map((x) => x.c);
    if (pass === args.retryPasses) {
      for (const { c, r } of next) rejects.push({ ...c, status: r.status, error: `transient, unresolved after ${args.retryPasses} retries: ${String(r.error || '').slice(0, 160)}`, transient: true });
    }
  }

  // Skip rule 7: among ok boards, the earliest platform keeps a shared name.
  const claimed = new Set();
  const toInsert = [];
  for (const platform of Object.keys(byPlatform)) {
    const s = summary[platform];
    for (const c of byPlatform[platform].candidates) {
      if (!okSet.has(c)) continue;
      s.ok++;
      // The pcsx fallback moves a candidate to a different board key, which
      // skip rule 3 has not seen yet.
      if (c.via && existingBoards.has(boardKey(c.platform, c.slug))) {
        s.boardExists++;
        continue;
      }
      // Name the row by its board, then re-apply skip rule 4 to that name.
      const named = chooseName(c);
      const normalized = normalizeCompanyName(named);
      if (normalized && normalized !== c.normalized) {
        c.display = named;
        c.normalized = normalized;
        s.renamedFromBoard++;
      }
      if (existingNames.has(c.normalized)) {
        s.nameExists++;
        continue;
      }
      if (claimed.has(c.normalized)) {
        s.lostToEarlierPlatform++;
        continue;
      }
      claimed.add(c.normalized);
      toInsert.push(c);
    }
  }
  for (const r of rejects) {
    if (r.transient) summary[r.list].unresolvedTransient++;
    else summary[r.list].rejected++;
  }

  const inserted = [];
  if (args.apply) {
    console.log(`\nInserting ${toInsert.length} rows ...`);
    const now = new Date().toISOString();
    const row = (c) => ({
      company_name_normalized: c.normalized,
      company_name_display: c.display,
      platform: c.platform,
      slug_or_identifier: c.slug,
      status: 'active',
      source: 'manual',
      probed_at: now,
      probe_outcome: 'ok',
      last_seen_at: now,
    });
    const listOf = new Map(toInsert.map((c) => [c.normalized, c.list]));
    const BATCH = 500;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH);
      const { data, error } = await db.from('company_ats_registry').insert(batch.map(row)).select('id, company_name_normalized, platform');
      if (!error) {
        for (const d of data || []) {
          inserted.push(d);
          summary[listOf.get(d.company_name_normalized)].inserted++;
        }
        continue;
      }
      // One unique violation fails the whole batch; fall back to per-row so it
      // cannot cost the other 499.
      console.error(`  batch insert failed (${error.message}), retrying rows individually ...`);
      for (const c of batch) {
        const { data: one, error: rowErr } = await db.from('company_ats_registry').insert([row(c)]).select('id, company_name_normalized, platform');
        if (rowErr) {
          summary[c.list].insertFailed++;
          console.error(`    insert failed for "${c.display}" (${c.platform}:${c.slug}): ${rowErr.message}`);
        } else {
          inserted.push(one[0]);
          summary[c.list].inserted++;
        }
      }
    }

    const toClean = inserted.map((d) => [d, unresolvedByName.get(d.company_name_normalized)]).filter(([, id]) => id);
    for (let i = 0; i < toClean.length; i += 200) {
      const slice = toClean.slice(i, i + 200);
      const { error } = await db.from('company_ats_unresolved').delete().in('id', slice.map(([, id]) => id));
      if (error) console.error(`  unresolved cleanup failed: ${error.message}`);
      else for (const [d] of slice) summary[listOf.get(d.company_name_normalized)].unresolvedCleaned++;
    }
  }

  console.log(args.apply ? '\n--- Import summary ---' : '\n--- Dry-run summary (no writes performed) ---');
  for (const [platform, s] of Object.entries(summary)) {
    const viaPcsx = toInsert.filter((c) => c.via === 'eightfold-pcsx').length;
    const tail = (viaPcsx && platform === 'eightfold' ? `registeredAsPhenomViaPcsx=${viaPcsx} ` : '') + (args.apply ? `inserted=${s.inserted} insertFailed=${s.insertFailed} unresolvedCleaned=${s.unresolvedCleaned}` : `wouldInsert=${toInsert.filter((c) => c.list === platform).length}`);
    console.log(`  ${platform}: probed=${s.probed} ok=${s.ok} rejected=${s.rejected} transientUnresolved=${s.unresolvedTransient} lostToEarlierPlatform=${s.lostToEarlierPlatform} ${tail}`);
  }

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const file = path.join(RUN_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}${args.apply ? '' : '-dry-run'}.json`);
  fs.writeFileSync(file, JSON.stringify({ dir: args.dir, apply: args.apply, summary, insertedIds: inserted.map((d) => d.id), rejects }, null, 1));
  console.log(`\nRun log: ${path.relative(path.join(__dirname, '..'), file)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
}

module.exports = { parseCsv, buildCandidates, loadRows, identifierFor, isTransient, nameFromTitle, chooseName, icimsPortalScore };
