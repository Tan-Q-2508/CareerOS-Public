#!/usr/bin/env node
// refresh-visa-sponsors.js — the quarterly DOL/OFLC H-1B sponsorship ETL
// (spec 19.1/19.2, §15 #48).
//
// THIS IS THE SUPPORTED EXECUTION PATH. POST /api/internal/refresh-visa-sponsors
// exists and shares this exact module (apps/server/src/visa/sponsors.js) so the
// batch can never drift from the endpoint — the same reason
// scripts/classify-sectors.js imports the production classifier rather than
// re-implementing it. But the current-quarter LCA file is a 252 MB .xlsx whose
// worksheet is ~1.6 GB uncompressed, and a real run peaks around 330 MB RSS on
// top of the download. That does not leave room on Render's ~512 MB tier, so
// the endpoint is expected to OOM there and this script, run locally, is what
// actually populates the table. See the module header for the full set of live
// findings about the source.
//
// NOT scripts/audit-visa-sponsorship.js. That one re-runs the JD-text
// sponsorship-REFUSAL detector over stored postings and can delete jobs. This
// one only reads a government file and writes the global visa_sponsors table.
// They share a word, nothing else.
//
// Usage (from repo root):
//   node scripts/refresh-visa-sponsors.js --dry-run
//   node scripts/refresh-visa-sponsors.js --apply
//   node scripts/refresh-visa-sponsors.js --dry-run --file=/path/to/LCA_Disclosure_Data_FY2026_Q3.xlsx
//
// --file skips the 252 MB download and parses a local copy — use it when
// iterating. The FY/quarter are read from the filename when it matches
// FY####_Q#, otherwise they are looked up live (19.3 forbids storing a number
// without its vintage).
//
// Node's default old-space is comfortable here, but if a future quarter's
// shared-string table grows past it, run with:
//   node --max-old-space-size=4096 scripts/refresh-visa-sponsors.js --apply

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin } = require('@careeros/shared');
const { refreshVisaSponsors } = require('../apps/server/src/visa/sponsors');

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, file: null };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw.startsWith('--file=')) args.file = raw.slice('--file='.length);
  }
  return args;
}

function mb(bytes) {
  return bytes === null || bytes === undefined ? '—' : `${(bytes / 1e6).toFixed(1)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apply && !args.dryRun) {
    console.error('Pass --dry-run (report only) or --apply (write to visa_sponsors).');
    process.exit(1);
  }
  if (args.apply && args.dryRun) {
    console.error('Pass one of --dry-run or --apply, not both.');
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  if (!db) {
    console.error('Supabase not configured — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from apps/server/.env');
    process.exit(1);
  }

  let lastPhase = null;
  const summary = await refreshVisaSponsors(db, {
    dryRun: args.dryRun,
    filePath: args.file,
    onProgress: (p) => {
      if (p.phase === 'discovered') {
        console.log(`Source: FY${p.fiscalYear} Q${p.quarter}\n  ${p.url}`);
      } else if (p.phase === 'download') {
        if (p.bytes % (25 * 1e6) < 1e6) process.stdout.write(`\r  downloading ... ${mb(p.bytes)}   `);
      } else if (p.phase === 'parse') {
        if (lastPhase !== 'parse') {
          process.stdout.write('\n');
          console.log('Parsing (streamed — the worksheet does not fit in memory) ...');
        }
        if (p.rows) {
          process.stdout.write(`\r  ${p.rows.toLocaleString()} rows read, ${p.kept.toLocaleString()} certified H-1B kept   `);
        }
      }
      lastPhase = p.phase;
    },
  });

  console.log('\n');
  console.log(`Source            FY${summary.source.fiscalYear} Q${summary.source.quarter}`);
  console.log(`Downloaded        ${mb(summary.downloadedBytes)}`);
  console.log(`Columns           ${summary.columns}`);
  console.log(`Rows read         ${summary.rowsRead.toLocaleString()}`);
  console.log(`Certified H-1B    ${summary.certifiedH1b.toLocaleString()}`);
  console.log(`Distinct employers ${summary.employers.toLocaleString()}`);
  console.log(
    `Matched to registry ${summary.registryMatched.toLocaleString()} (${summary.registryMatchedViaDba.toLocaleString()} via trade name)`
  );
  console.log(`Retrieved at      ${summary.retrievedAt}`);
  console.log(`Elapsed           ${(summary.elapsedMs / 1000).toFixed(1)}s`);

  if (summary.dryRun) {
    console.log('\n[dry run] No writes performed. Top 10 sponsors by certified filings:\n');
    for (const s of summary.sample) {
      console.log(
        `  ${String(s.filing_count_last_fy).padStart(6)}  ${s.employer_name_display.slice(0, 44).padEnd(45)}` +
          `avg ${String(s.avg_wage ?? '—').padStart(7)}  ${JSON.stringify(s.wage_level_distribution)}`
      );
    }
    console.log('\nRe-run with --apply to write these to visa_sponsors.');
  } else {
    console.log(`\nWrote             ${summary.wrote.toLocaleString()} rows (${summary.writeFailed} failed)`);
    const tl = summary.tracklists;
    if (tl && !tl.error) {
      console.log(
        `Sponsor tracklists ${tl.sponsors.toLocaleString()} companies, ${tl.entryLevel.toLocaleString()} entry-level-friendly ` +
          `(+${tl.added} / -${tl.removed})`
      );
    } else if (tl) {
      console.log(`Sponsor tracklists FAILED: ${tl.error} — table was still written; re-run syncSponsorTracklists`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
