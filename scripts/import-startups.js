#!/usr/bin/env node
// import-startups.js — populate the built-in "Startups — Y Combinator"
// tracklist (spec 4.6.9a, §15 #65).
//
// Source: the YC company directory, read from yc-oss's public JSON mirror of
// it (https://yc-oss.github.io/api/companies/all.json — a community-maintained
// daily export of YC's own directory: name, slug, website, batch, team size,
// stage, industries, regions, status and a hiring flag). Every profile field
// written is copied verbatim from that export; nothing is inferred.
//
// Which companies: status Active, not a nonprofit, currently hiring, with the
// United States among their regions, and a team of at most
// tunables.startups.maxTeamSize people — the size cap is what keeps
// late-stage YC alumni (Stripe, Deel, Flexport) off a list meant for startups.
//
// How each company's board is found, strongest evidence first:
//   1. its OWN website (homepage, then careers pages) links a known ATS board
//      (apps/server/src/companies/startupDiscovery.js); the first candidate
//      that live-probes ok wins;
//   2. otherwise its YC company page, when that page lists at least one role
//      (the `ycombinator` adapter);
//   3. otherwise it is reported as unresolved and left out.
// There is no name-guessing anywhere in this path.
//
// Registration goes through apps/server/src/companies/bulkRegister.js. When a
// registry row already holds the startup's name on a different board, name
// equality alone is not identity (4.6.4) — "Magic" (getmagic.com) is not
// Magic.dev — so the row is linked only on independent evidence:
//   * found via the WEBSITE: the website is the evidence, so its board wins and
//     the startup is registered as "{name} (YC {batch})" beside the other row;
//   * found via the YC fallback: the existing row is this company when its
//     board slug matches the company's own web domain (webflow.com ->
//     greenhouse:webflow, apollo.io -> greenhouse:apolloio); the profile links
//     to that row and nothing is inserted. Otherwise, as above.
//
// Usage (from repo root):
//   node scripts/import-startups.js --dry-run [--limit=50] [--cache=path.json]
//   node scripts/import-startups.js --apply [--cache=path.json]
//   node scripts/import-startups.js --sync-only        (rebuild the tracklist only)
// --cache stores/reuses the crawl results so a dry run and the apply that
// follows it act on the same discovery.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, atsDirect, tunables } = require('@careeros/shared');
const { discoverBoard } = require('../apps/server/src/companies/startupDiscovery');
const { register, findByBoard } = require('../apps/server/src/companies/bulkRegister');
const { syncStartupTracklist } = require('../apps/server/src/companies/startupTracklist');
const { fetchText } = require('../packages/shared/src/sourcing/ats/webFetch');

const YC_EXPORT = 'https://yc-oss.github.io/api/companies/all.json';
const BATCH_LETTER = { Winter: 'W', Summer: 'S', Fall: 'F', Spring: 'X' };

function cfg() {
  return tunables.startups || { maxTeamSize: 1000, crawlConcurrency: 8, ycMinIntervalMs: 400 };
}

function parseArgs(argv) {
  const args = { apply: false, limit: null, cache: null, syncOnly: false };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--sync-only') args.syncOnly = true;
    else if (a.startsWith('--limit=')) args.limit = Number(a.slice(8));
    else if (a.startsWith('--cache=')) args.cache = a.slice(8);
  }
  return args;
}

function batchShort(batch) {
  const m = /^(Winter|Summer|Fall|Spring)\s+(\d{4})$/.exec(String(batch || ''));
  return m ? `${BATCH_LETTER[m[1]]}${m[2].slice(2)}` : null;
}

// "webflow" for https://www.webflow.com, "getmagic" for getmagic.com.
function domainLabel(website) {
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    return host.split('.')[0].replace(/[^a-z0-9]/g, '');
  } catch {
    return '';
  }
}

// The alphanumeric company token of a registry identifier: the slug itself,
// or the tenant of a colon-composite (workday "tenant:wd5:site").
function slugToken(slug) {
  return String(slug || '').split(':')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Whether an existing registry row's board plausibly belongs to the company
// whose website is `website`: one token must start with the other, and the
// shorter must be at least 4 characters so "ai" or "go" match nothing.
function boardMatchesDomain(slug, website) {
  const a = slugToken(slug);
  const b = domainLabel(website);
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

function isCandidate(c, maxTeam) {
  return (
    c.status === 'Active' &&
    !c.nonprofit &&
    c.isHiring === true &&
    Array.isArray(c.regions) &&
    c.regions.includes('United States of America') &&
    (c.team_size == null || c.team_size <= maxTeam) &&
    !!c.slug
  );
}

async function pooled(items, limit, fn) {
  let next = 0;
  await Promise.all(
    new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    })
  );
}

// YC pages are one host; space the fallback probes out rather than firing a
// crawl-sized burst at it.
let ycLast = 0;
async function ycGate() {
  const wait = Math.max(0, ycLast + cfg().ycMinIntervalMs - Date.now());
  ycLast = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function resolveBoard(company) {
  const { candidates } = await discoverBoard(company.website, {
    fetchText: (url) => fetchText(url, { platform: 'default' }),
  });
  for (const cand of candidates.slice(0, 3)) {
    const p = await atsDirect.adapters[cand.platform].probe(cand.slug).catch((e) => ({ ok: false, error: e.message }));
    if (p.ok) return { platform: cand.platform, slug: cand.slug, via: 'website', boardName: p.boardName || null };
  }
  await ycGate();
  const yc = await atsDirect.adapters.ycombinator.probe(company.slug).catch((e) => ({ ok: false, error: e.message }));
  if (yc.ok && yc.jobCount > 0) return { platform: 'ycombinator', slug: company.slug, via: 'yc', boardName: yc.boardName || null };
  return { platform: null, slug: null, via: 'none', candidates };
}

function profileRow(registryId, c) {
  return {
    company_ats_registry_id: registryId,
    source: 'yc',
    source_slug: c.slug,
    batch: c.batch || null,
    team_size: Number.isFinite(c.team_size) ? c.team_size : null,
    stage: c.stage || null,
    industries: Array.isArray(c.industries) ? c.industries : [],
    website: c.website || null,
    is_hiring: c.isHiring === true,
    synced_at: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = getSupabaseAdmin();
  if (!db) throw new Error('Supabase env missing (apps/server/.env)');

  if (args.syncOnly) {
    console.log('tracklist:', await syncStartupTracklist(db));
    return;
  }

  console.log(`fetching ${YC_EXPORT} ...`);
  const all = await (await fetch(YC_EXPORT)).json();
  let companies = all.filter((c) => isCandidate(c, cfg().maxTeamSize));
  console.log(`${all.length} companies in the export, ${companies.length} active + hiring + US + team <= ${cfg().maxTeamSize}`);
  if (args.limit) companies = companies.slice(0, args.limit);

  // --- discovery (cached) ----------------------------------------------------
  const cache = args.cache && fs.existsSync(args.cache) ? JSON.parse(fs.readFileSync(args.cache, 'utf8')) : {};
  let done = 0;
  await pooled(companies, cfg().crawlConcurrency, async (c) => {
    if (!cache[c.slug]) {
      try {
        cache[c.slug] = await resolveBoard(c);
      } catch (e) {
        cache[c.slug] = { platform: null, slug: null, via: 'error', error: e.message };
      }
    }
    done += 1;
    if (done % 100 === 0) {
      console.log(`  discovered ${done}/${companies.length}`);
      if (args.cache) fs.writeFileSync(args.cache, JSON.stringify(cache));
    }
  });
  if (args.cache) fs.writeFileSync(args.cache, JSON.stringify(cache));

  const byVia = {};
  for (const c of companies) byVia[cache[c.slug].via] = (byVia[cache[c.slug].via] || 0) + 1;
  const byPlatform = {};
  for (const c of companies) if (cache[c.slug].platform) byPlatform[cache[c.slug].platform] = (byPlatform[cache[c.slug].platform] || 0) + 1;
  console.log('board found via:', byVia);
  console.log('platforms:', byPlatform);

  // --- registration ------------------------------------------------------------
  const tally = {};
  const bump = (k) => (tally[k] = (tally[k] || 0) + 1);
  const profiles = [];
  for (const c of companies) {
    const b = cache[c.slug];
    if (!b.platform) {
      bump('unresolved');
      continue;
    }
    let res = await register(db, { display: c.name, platform: b.platform, slug: b.slug, dryRun: !args.apply });
    if (res.action === 'name_taken' && b.via === 'yc' && boardMatchesDomain(res.existing.slug_or_identifier, c.website)) {
      bump('linked_existing');
      if (args.apply) profiles.push(profileRow(res.existing.id, c));
      continue;
    }
    if (res.action === 'name_taken') {
      const tag = batchShort(c.batch);
      const display = tag ? `${c.name} (YC ${tag})` : `${c.name} (YC)`;
      console.log(`  name held by another company: "${c.name}" is ${res.existing.platform}:${res.existing.slug_or_identifier}; registering as "${display}"`);
      bump('disambiguated');
      res = await register(db, { display, platform: b.platform, slug: b.slug, dryRun: !args.apply });
    }
    bump(res.action);
    if (!args.apply) continue;
    const row = res.company || (await findByBoard(db, b.platform, b.slug));
    if (row) profiles.push(profileRow(row.id, c));
  }

  if (args.apply) {
    for (let i = 0; i < profiles.length; i += 500) {
      const { error } = await db.from('company_startup_profiles').upsert(profiles.slice(i, i + 500), { onConflict: 'company_ats_registry_id' });
      if (error) throw new Error(`profile upsert failed: ${error.message}`);
    }
    // A refresh also retires the hiring flag of profiled startups that stopped
    // hiring (or left the directory's active set), so the list drops them.
    const stillHiring = new Set(companies.map((c) => c.slug));
    const { data: existing, error } = await db.from('company_startup_profiles').select('company_ats_registry_id, source_slug, is_hiring').eq('source', 'yc');
    if (error) throw new Error(error.message);
    const stale = (existing || []).filter((p) => p.is_hiring && !stillHiring.has(p.source_slug)).map((p) => p.company_ats_registry_id);
    if (stale.length && !args.limit) {
      const { error: e2 } = await db.from('company_startup_profiles').update({ is_hiring: false, synced_at: new Date().toISOString() }).in('company_ats_registry_id', stale);
      if (e2) throw new Error(e2.message);
    }
    console.log(`profiles upserted: ${profiles.length}, marked not hiring: ${args.limit ? 0 : stale.length}`);
    console.log('tracklist:', await syncStartupTracklist(db));
  }

  console.log('\nregistration:', tally);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { isCandidate, batchShort, boardMatchesDomain, domainLabel };
