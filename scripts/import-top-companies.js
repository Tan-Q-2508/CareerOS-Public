#!/usr/bin/env node
// import-top-companies.js — load the Fortune-200 ATS research ledger
// (data/ats-research/fortune200_us.csv) into company_ats_registry
// (spec 4.6.3/4.6.5, §15 #65).
//
// The ledger is the research deliverable: one row per company with the board
// it was found on, how (status), and why (notes). This script only acts on it:
//
//   status            action
//   ---------------   ------------------------------------------------------
//   add               register a new row on an existing platform
//   add_new_platform  register a new row on a platform added in §15 #65
//   repoint           point the company's existing (wrong) row at the real board
//   in_registry       verify the existing row still probes; no write
//   blocked/custom/   no board to register; if a wrong mapping squats the
//   unresolved        company's name, retire it to company_ats_unresolved
//   not_applicable    nothing
//
// rename_existing=yes: when the board is already registered under a junk name
// an earlier bulk import gave it ("Jci", "Egug", "Wf"), rename that row to the
// company's real name. For a repoint whose board already has its own row, the
// squatter row holding the company's name is retired first, then the board's
// row is renamed — one row per company, on the right board, with the right
// name. Listed per row in the ledger rather than guessed by a heuristic.
//
// Every board is live-probed through its own adapter first; a failed probe is
// reported and the row is skipped, never written. Each write goes through
// apps/server/src/companies/bulkRegister.js, which refuses to create a second
// row for a board already registered and never overwrites a name conflict.
//
// Usage (from repo root):
//   node scripts/import-top-companies.js --dry-run
//   node scripts/import-top-companies.js --apply
//   node scripts/import-top-companies.js --apply --only=12,143

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, atsDirect } = require('@careeros/shared');
const { register, repoint, retire, rename, findByBoard, findByName } = require('../apps/server/src/companies/bulkRegister');

const LEDGER = path.join(__dirname, '..', 'data', 'ats-research', 'fortune200_us.csv');

// The wrong mappings research found squatting a company's name while no
// replacement board is reachable. Retired only if the row still points here.
const RETIRE = {
  Tesla: { platform: 'workable', slug: 'tesla' },
  'Ross Stores': { platform: 'workable', slug: 'ross-stores' },
};

function parseArgs(argv) {
  const args = { apply: false, only: null };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a.startsWith('--only=')) args.only = new Set(a.slice(7).split(',').map((s) => s.trim()));
  }
  return args;
}

// RFC4180-enough: the ledger is written without quoted fields, but a quoted
// field is still read correctly if one is ever added.
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const out = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(field); field = ''; }
      else field += c;
    }
    out.push(field);
    rows.push(out);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

async function probeBoard(platform, identifier) {
  const adapter = atsDirect.adapters[platform];
  if (!adapter) return { ok: false, error: `no adapter for ${platform}` };
  try {
    return await adapter.probe(identifier);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const db = getSupabaseAdmin();
  if (!db) throw new Error('Supabase env missing (apps/server/.env)');
  const rows = parseCsv(fs.readFileSync(LEDGER, 'utf8')).filter((r) => !args.only || args.only.has(r.rank));
  const dryRun = !args.apply;
  const tally = {};
  const bump = (k) => (tally[k] = (tally[k] || 0) + 1);

  console.log(`${dryRun ? 'DRY RUN' : 'APPLY'} — ${rows.length} ledger rows\n`);
  for (const r of rows) {
    const display = r.registry_name || r.company;
    const tag = `#${r.rank} ${r.company}`;

    if (['add', 'add_new_platform', 'repoint', 'in_registry'].includes(r.status)) {
      const p = await probeBoard(r.platform, r.identifier);
      if (!p.ok) {
        bump(`${r.status}:probe_failed`);
        console.log(`  PROBE FAIL  ${tag} ${r.platform}:${r.identifier} — ${p.error || p.status}`);
        continue;
      }
    }

    if (r.status === 'in_registry') {
      const row = (await findByBoard(db, r.platform, r.identifier)) || null;
      if (row) {
        bump('in_registry:ok');
        console.log(`  ok          ${tag} = ${row.company_name_display} (${row.platform}:${row.slug_or_identifier})`);
      } else {
        const named = await findByName(db, atsDirect.normalizeCompanyName(display));
        bump('in_registry:mismatch');
        console.log(`  MISMATCH    ${tag} ledger says ${r.platform}:${r.identifier}, registry has ${named ? `${named.platform}:${named.slug_or_identifier}` : 'no row'}`);
      }
      continue;
    }

    if (r.status === 'add' || r.status === 'add_new_platform') {
      const res = await register(db, { display, platform: r.platform, slug: r.identifier, dryRun });
      bump(`${r.status}:${res.action}`);
      if (res.action === 'board_exists' && r.rename_existing === 'yes') {
        const rn = await rename(db, { id: res.company.id, display, dryRun });
        bump(`rename:${rn.action}`);
        console.log(`  ${('rename:' + rn.action).padEnd(11)} ${tag} "${res.company.company_name_display}" -> "${display}"`);
      }
      const where = res.company ? ` -> ${res.company.company_name_display}` : res.existing ? ` (name held by ${res.existing.platform}:${res.existing.slug_or_identifier})` : '';
      console.log(`  ${res.action.padEnd(11)} ${tag} ${r.platform}:${r.identifier}${where}`);
      continue;
    }

    if (r.status === 'repoint') {
      const res = await repoint(db, { display, platform: r.platform, slug: r.identifier, dryRun });
      bump(`repoint:${res.action}`);
      const was = res.previous ? ` (was ${res.previous.platform}:${res.previous.slug || res.previous.slug_or_identifier})` : '';
      console.log(`  ${res.action.padEnd(11)} ${tag} -> ${r.platform}:${r.identifier}${was}`);
      if (res.action === 'board_exists' && r.rename_existing === 'yes' && res.previous) {
        const rt = await retire(db, { display, expect: { platform: res.previous.platform, slug: res.previous.slug_or_identifier }, careersUrl: r.careers_url, dryRun });
        bump(`retire:${rt.action}`);
        console.log(`  ${('retire:' + rt.action).padEnd(11)} ${tag} squatter ${res.previous.platform}:${res.previous.slug_or_identifier}`);
        if (rt.action === 'retired') {
          // The retired row freed the company's name, so a dry run cannot
          // check the rename against the database — report it as planned.
          const rn = dryRun ? { action: 'renamed' } : await rename(db, { id: res.company.id, display, dryRun });
          bump(`rename:${rn.action}`);
          console.log(`  ${('rename:' + rn.action).padEnd(11)} ${tag} "${res.company.company_name_display}" -> "${display}"`);
        }
      }
      continue;
    }

    if (RETIRE[r.company]) {
      const res = await retire(db, { display, expect: RETIRE[r.company], careersUrl: r.careers_url, dryRun });
      bump(`retire:${res.action}`);
      console.log(`  ${res.action.padEnd(11)} ${tag} (${RETIRE[r.company].platform}:${RETIRE[r.company].slug})`);
      continue;
    }

    bump(`skip:${r.status}`);
  }

  console.log('\nsummary:');
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(32)} ${v}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { parseCsv };
