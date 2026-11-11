// CareerOS — DOL/OFLC H-1B sponsorship ETL (spec 19.1/19.2, §15 #48).
//
// Downloads the U.S. Department of Labor Office of Foreign Labor Certification
// quarterly LCA (Form ETA-9035) case-disclosure file, keeps the certified H-1B
// rows, aggregates them per employer, and upserts into `visa_sponsors`.
//
// NOT the same thing as detectVisaReject / tunables.visaRejectPatterns /
// scripts/audit-visa-sponsorship.js. Those read ONE posting's wording to decide
// whether a job says it won't sponsor. This reads government filing records to
// describe an EMPLOYER's real sponsorship history. Absence of a filing here is
// never evidence of refusal (19.4), so the two must never be wired together.
//
// ---------------------------------------------------------------------------
// Live facts about the source, confirmed against dol.gov and the FY2026 Q3
// file itself. Each of these cost a debugging cycle to discover; none is
// guessable from the DOL landing page.
//
// 1. dol.gov sits behind Akamai. A realistic User-Agent ALONE still returns
//    403 — the full browser navigation header set below is required, and every
//    header in it was confirmed necessary by removing it and re-requesting.
// 2. HEAD is refused (403) even with those headers. A ranged GET returns 206,
//    so a size probe must be `Range: bytes=0-1023`, never HEAD.
// 3. The current-quarter file's URL does NOT follow the historical path
//    pattern. Every prior quarter lives under
//    /sites/dolgov/files/ETA/oflc/pdfs/, but FY2026 Q3 is published at
//    https://www.dol.gov//media/LCA_Disclosure_Data_FY2026_Q3.xlsx — note the
//    real page emits a doubled slash. The URL is therefore DISCOVERED by
//    scanning the performance page for the newest LCA_Disclosure_Data file,
//    never constructed from a template.
// 4. The .xlsx is enormous and growing (FY2025 Q4: 79 MB; FY2026 Q3: 252 MB).
//    Inside, xl/worksheets/sheet1.xml is ~1.6 GB uncompressed while
//    xl/sharedStrings.xml is ~42 MB. That split is what makes this tractable:
//    the string table fits in memory, the sheet absolutely does not, so the
//    sheet is SAX-streamed a row at a time and nothing accumulates but the
//    per-employer aggregate. A whole-workbook reader (SheetJS, ExcelJS's
//    non-streaming path) cannot open this file at all.
// 5. Consequence of 4: this does not fit in Render's ~512 MB tier. The
//    supported execution path is scripts/refresh-visa-sponsors.js run
//    locally. The internal endpoint exists per 19.1 and shares this exact
//    module, but is expected to OOM on the current host — see the handoff.
// 6. Column VALUES are title-case, not upper ("Certified", not "CERTIFIED"),
//    confirmed against LCA_Record_Layout_FY2026_Q3.pdf. All comparisons here
//    uppercase both sides rather than trusting the file's casing.
// 7. The quarterly file is CUMULATIVE within the fiscal year (Q3 covers
//    Oct 1 - Jun 30), so filing_count_last_fy is the certified-H-1B count
//    within the single newest file, not a sum across quarterly files.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const yauzl = require('yauzl');
const { SaxesParser } = require('saxes');
const { tunables, atsDirect } = require('@careeros/shared');
const { syncSponsorTracklists } = require('./sponsorTracklists');

const { normalizeCompanyName } = atsDirect;
const CFG = tunables.visaSponsors;

// See note 1 above — the whole set is required, not just the User-Agent.
const DOL_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

// WAGE_UNIT_OF_PAY values per the record layout: Hour, Week, Bi-Weekly, Month,
// Year. Annualized so avg_wage is comparable across employers who file hourly
// and salaried roles — an average mixing $60/hr with $180,000/yr is noise.
const WAGE_MULTIPLIER = {
  HOUR: 2080,
  WEEK: 52,
  'BI-WEEKLY': 26,
  BIWEEKLY: 26,
  MONTH: 12,
  YEAR: 1,
};

/**
 * Find the newest LCA case-disclosure file linked from DOL's performance page.
 * Never builds the URL from a template — see note 3 above.
 *
 * @returns {Promise<{url: string, fiscalYear: number, quarter: number}>}
 */
async function discoverLatestLcaFile({ pageUrl = CFG.performancePageUrl } = {}) {
  const res = await fetch(pageUrl, { headers: DOL_HEADERS });
  if (!res.ok) {
    throw new Error(`DOL performance page returned HTTP ${res.status} (see note 1 — header set may have changed)`);
  }
  const html = await res.text();

  const re = /href="([^"]*LCA_Disclosure_Data_FY(\d{4})_Q(\d)\.xlsx)"/gi;
  let best = null;
  for (const m of html.matchAll(re)) {
    const fiscalYear = Number(m[2]);
    const quarter = Number(m[3]);
    const rank = fiscalYear * 10 + quarter;
    if (!best || rank > best.rank) best = { href: m[1], fiscalYear, quarter, rank };
  }
  if (!best) throw new Error('No LCA_Disclosure_Data_FY*_Q*.xlsx link found on the DOL performance page');

  return { url: absoluteDolUrl(best.href), fiscalYear: best.fiscalYear, quarter: best.quarter };
}

// The live page emits `https://www.dol.gov//media/...` (doubled slash) for the
// current quarter and a site-root-relative path for older ones. Collapse both
// to one well-formed absolute URL.
function absoluteDolUrl(href) {
  const abs = /^https?:\/\//i.test(href) ? href : `${CFG.originBase}${href.startsWith('/') ? '' : '/'}${href}`;
  return abs.replace(/([^:])\/{2,}/g, '$1/');
}

/**
 * Stream the file to disk. Never buffered — it is a quarter of a gigabyte.
 * @returns {Promise<{filePath: string, bytes: number}>}
 */
async function downloadToTemp(url, { dir = os.tmpdir(), onProgress } = {}) {
  const filePath = path.join(dir, `lca_disclosure_${Date.now()}.xlsx`);
  const res = await fetch(url, {
    headers: { ...DOL_HEADERS, Referer: CFG.performancePageUrl, 'Sec-Fetch-Site': 'same-origin' },
    signal: AbortSignal.timeout(CFG.requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`LCA file download returned HTTP ${res.status} for ${url}`);

  let bytes = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    bytes += chunk.length;
    if (onProgress) onProgress(bytes);
  });
  await pipeline(source, fs.createWriteStream(filePath));
  return { filePath, bytes };
}

// --- xlsx streaming -------------------------------------------------------
// Deliberately not ExcelJS/SheetJS: both want to materialize a worksheet, and
// this one is 1.6 GB of XML. yauzl gives a read stream per zip entry and saxes
// turns that into events, so peak memory is the shared-string table plus one
// row.

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function entryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

// Walk the central directory once and keep the entries we need by name.
function findEntries(zip, wanted) {
  return new Promise((resolve, reject) => {
    const found = {};
    zip.on('entry', (entry) => {
      const key = Object.keys(wanted).find((k) => wanted[k].test(entry.fileName));
      if (key && !found[key]) found[key] = entry;
      zip.readEntry();
    });
    zip.on('end', () => resolve(found));
    zip.on('error', reject);
    zip.readEntry();
  });
}

async function parseXmlStream(stream, handlers) {
  const parser = new SaxesParser();
  if (handlers.opentag) parser.on('opentag', handlers.opentag);
  if (handlers.closetag) parser.on('closetag', handlers.closetag);
  if (handlers.text) parser.on('text', handlers.text);
  let failure = null;
  parser.on('error', (e) => {
    failure = e;
  });

  for await (const chunk of stream) {
    if (failure) break;
    parser.write(chunk.toString('utf8'));
  }
  if (failure) throw failure;
}

/**
 * Read xl/sharedStrings.xml into an array. ~42 MB of XML for the FY2026 Q3
 * file — the one part of the workbook small enough to hold whole, and the
 * reason the sheet can then be streamed without a second pass.
 */
async function readSharedStrings(zip, entry) {
  if (!entry) return [];
  const strings = [];
  let inSi = false;
  let buf = '';
  await parseXmlStream(await entryStream(zip, entry), {
    opentag: (node) => {
      if (node.name === 'si') {
        inSi = true;
        buf = '';
      }
    },
    text: (t) => {
      if (inSi) buf += t;
    },
    closetag: (node) => {
      if (node.name === 'si') {
        strings.push(buf);
        inSi = false;
        buf = '';
      }
    },
  });
  return strings;
}

// saxes hands back `attributes` as plain strings in its default (non-xmlns)
// mode and as {value} objects when namespaces are on. Reading `.value`
// unconditionally silently yields undefined in the first case, which turns
// every t="s" cell into a raw shared-string INDEX instead of its text — a
// header row of numbers that fails resolveColumns with a confusing
// "missing required column" error rather than a parse error.
function attrValue(node, name) {
  const a = node.attributes[name];
  if (a === undefined || a === null) return null;
  return typeof a === 'string' ? a : a.value;
}

// "BC12" -> 54 (zero-based column index)
function columnIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * SAX-stream the worksheet, calling onRow(header, row) for every data row.
 * Row 1 is read as the header, so column ORDER is never assumed — only the
 * column NAMES in tunables.visaSponsors.columns matter, and a DOL column
 * rename is a config fix rather than a code change.
 */
async function streamSheetRows(zip, entry, sharedStrings, onRow) {
  let header = null;
  let row = null;
  let cellRef = null;
  let cellType = null;
  let inValue = false;
  let valueBuf = '';

  await parseXmlStream(await entryStream(zip, entry), {
    opentag: (node) => {
      if (node.name === 'row') {
        row = [];
      } else if (node.name === 'c') {
        cellRef = attrValue(node, 'r');
        cellType = attrValue(node, 't');
      } else if (node.name === 'v' || node.name === 't') {
        inValue = true;
        valueBuf = '';
      }
    },
    text: (t) => {
      if (inValue) valueBuf += t;
    },
    closetag: (node) => {
      if (node.name === 'v' || node.name === 't') {
        inValue = false;
        if (!row) return;
        // t="s" is a shared-string index; t="inlineStr"/"str" carry text directly.
        const value = cellType === 's' ? sharedStrings[Number(valueBuf)] ?? '' : valueBuf;
        const idx = cellRef ? columnIndex(cellRef) : row.length;
        row[idx] = value;
      } else if (node.name === 'c') {
        cellRef = null;
        cellType = null;
      } else if (node.name === 'row') {
        if (!header) {
          header = (row || []).map((h) => String(h || '').trim());
        } else if (row && row.length) {
          onRow(header, row);
        }
        row = null;
      }
    },
  });

  return header;
}

// --- aggregation ----------------------------------------------------------

function annualizeWage(raw, unit) {
  const amount = Number(String(raw || '').replace(/[$,]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const mult = WAGE_MULTIPLIER[String(unit || '').trim().toUpperCase()];
  if (!mult) return null;
  const annual = amount * mult;
  // Guards against a stray unit/amount mismatch skewing an employer's average.
  return annual > 1000 && annual < 10000000 ? annual : null;
}

function upperSet(values) {
  return new Set((values || []).map((v) => String(v).toUpperCase()));
}

/**
 * Fold the certified H-1B rows into one accumulator per normalized employer
 * name. This is the only thing that grows with the file, and it grows with the
 * number of distinct EMPLOYERS (tens of thousands), not the number of rows.
 */
function createAggregator() {
  const byNormalized = new Map();
  const keepVisa = upperSet(CFG.keepVisaClasses);
  const keepStatus = upperSet(CFG.keepCaseStatuses);
  const stats = { rows: 0, kept: 0, skippedNoName: 0 };

  function add(get) {
    stats.rows++;
    if (!keepVisa.has(String(get('visaClass') || '').trim().toUpperCase())) return;
    if (!keepStatus.has(String(get('caseStatus') || '').trim().toUpperCase())) return;

    const display = String(get('employerName') || '').trim();
    const normalized = normalizeCompanyName(display);
    if (!normalized) {
      stats.skippedNoName++;
      return;
    }
    stats.kept++;

    let acc = byNormalized.get(normalized);
    if (!acc) {
      acc = {
        display,
        dbaNormalized: null,
        count: 0,
        wageSum: 0,
        wageN: 0,
        levels: new Map(),
        titles: new Map(),
      };
      byNormalized.set(normalized, acc);
    }
    acc.count++;

    // The registry stores trade names far more often than legal names
    // ("Meta" vs "Meta Platforms, Inc."), so the DBA is kept as a SECOND
    // lookup key for the registry join only. Same normalizer, no second
    // name-matching system — 19.2's constraint is about the algorithm, not
    // about how many fields it is applied to.
    //
    // GUARDED BY LENGTH, and the guard is not optional. The first live run
    // linked `Mehta Mechanical Co. In.` (one filing) to the registry's `Mmc`
    // row, because that employer files under the DBA "MMC" — a three-letter
    // acronym is a collision magnet, and the result was a household-name
    // company's badge showing a stranger's single filing. Short DBA keys carry
    // almost no identifying information; long ones are safe enough. Legal names
    // are not filtered this way (`lyft` is four characters and correct) because
    // they are the primary key, matched exactly, not a fallback guess.
    // See the `ats-name-guess-false-positive-risk` memory — same failure mode,
    // one layer up. 19.3 sets a higher bar than usual for this data.
    if (!acc.dbaNormalized) {
      const dba = normalizeCompanyName(String(get('tradeNameDba') || '').trim());
      if (dba && dba !== normalized && dba.length >= CFG.minDbaKeyLength) acc.dbaNormalized = dba;
    }

    const wage = annualizeWage(get('wageFrom'), get('wageUnit'));
    if (wage !== null) {
      acc.wageSum += wage;
      acc.wageN++;
    }

    const level = String(get('pwWageLevel') || '').trim().toUpperCase() || 'N/A';
    acc.levels.set(level, (acc.levels.get(level) || 0) + 1);

    const title = String(get('jobTitle') || '').trim();
    if (title) acc.titles.set(title, (acc.titles.get(title) || 0) + 1);
  }

  function finish() {
    const out = [];
    for (const [normalized, acc] of byNormalized) {
      if (acc.count < CFG.minCertifiedFilings) continue;
      out.push({
        employer_name_normalized: normalized,
        employer_name_display: acc.display,
        dba_normalized: acc.dbaNormalized,
        filing_count_last_fy: acc.count,
        avg_wage: acc.wageN ? Math.round(acc.wageSum / acc.wageN) : null,
        wage_level_distribution: distributionOf(acc.levels, acc.count),
        top_job_titles: topN(acc.titles, CFG.topJobTitles),
      });
    }
    return { sponsors: out, stats };
  }

  return { add, finish, stats };
}

// Shares, rounded to 3dp, of the levels actually present — an absent level is
// absent rather than an explicit zero, so the jsonb stays small.
function distributionOf(levels, total) {
  const dist = {};
  for (const level of CFG.wageLevels) {
    const n = levels.get(level);
    if (n) dist[level] = Math.round((n / total) * 1000) / 1000;
  }
  for (const [level, n] of levels) {
    if (!(level in dist) && n) dist[level] = Math.round((n / total) * 1000) / 1000;
  }
  return dist;
}

function topN(counts, n) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([title]) => title);
}

/**
 * Parse an already-downloaded LCA file into per-employer aggregates.
 * @returns {Promise<{sponsors: Array, stats: object, header: string[]}>}
 */
async function aggregateFile(filePath, { onProgress } = {}) {
  const zip = await openZip(filePath);
  try {
    const entries = await findEntries(zip, {
      sharedStrings: /^xl\/sharedStrings\.xml$/i,
      sheet: /^xl\/worksheets\/sheet1\.xml$/i,
    });
    if (!entries.sheet) throw new Error('xl/worksheets/sheet1.xml not found in the LCA workbook');

    const sharedStrings = await readSharedStrings(zip, entries.sharedStrings);

    const agg = createAggregator();
    let colIndex = null;

    const header = await streamSheetRows(zip, entries.sheet, sharedStrings, (hdr, row) => {
      if (!colIndex) colIndex = resolveColumns(hdr);
      agg.add((key) => row[colIndex[key]]);
      if (onProgress && agg.stats.rows % 100000 === 0) onProgress({ ...agg.stats });
    });

    const { sponsors, stats } = agg.finish();
    return { sponsors, stats, header, sharedStringCount: sharedStrings.length };
  } finally {
    zip.close();
  }
}

// Map tunables' logical column names onto this file's actual header row. A
// missing REQUIRED column is fatal and named explicitly — DOL restructures this
// file periodically, and a silent undefined would produce a table full of
// zeroes that looks successful.
function resolveColumns(header) {
  const byName = new Map(header.map((h, i) => [String(h).trim().toUpperCase(), i]));
  const required = ['visaClass', 'caseStatus', 'employerName'];
  const idx = {};
  const missing = [];
  for (const [key, columnName] of Object.entries(CFG.columns)) {
    const at = byName.get(String(columnName).toUpperCase());
    if (at === undefined) {
      if (required.includes(key)) missing.push(columnName);
      idx[key] = -1;
    } else {
      idx[key] = at;
    }
  }
  if (missing.length) {
    throw new Error(
      `LCA file is missing required column(s): ${missing.join(', ')} — DOL may have renamed them; update tunables.visaSponsors.columns`
    );
  }
  return idx;
}

// --- persistence ----------------------------------------------------------

/**
 * Resolve each aggregate to a company_ats_registry row by normalized name,
 * exactly the shape linkJobsToRegistry uses (registry.js) — chunked
 * `.in('company_name_normalized', ...)` lookups against the same normalizer,
 * so no second name-matching path is introduced (4.6.4's stated risk).
 * Unmatched employers keep a null id and are still stored (19.2).
 */
async function resolveRegistryIds(db, sponsors) {
  // A DBA key two different employers both claim identifies neither of them, so
  // it is dropped rather than resolved arbitrarily — the same reason the length
  // guard above exists. Legal names can't collide (they are the unique key).
  const dbaClaims = new Map();
  for (const s of sponsors) {
    if (s.dba_normalized) dbaClaims.set(s.dba_normalized, (dbaClaims.get(s.dba_normalized) || 0) + 1);
  }
  let ambiguousDba = 0;
  for (const s of sponsors) {
    if (s.dba_normalized && dbaClaims.get(s.dba_normalized) > 1) {
      s.dba_normalized = null;
      ambiguousDba++;
    }
  }

  const keys = new Set();
  for (const s of sponsors) {
    keys.add(s.employer_name_normalized);
    if (s.dba_normalized) keys.add(s.dba_normalized);
  }

  const idByName = new Map();
  const all = [...keys];
  const LOOKUP_BATCH = 500;
  for (let i = 0; i < all.length; i += LOOKUP_BATCH) {
    const { data, error } = await db
      .from('company_ats_registry')
      .select('id, company_name_normalized')
      .in('company_name_normalized', all.slice(i, i + LOOKUP_BATCH));
    if (error) throw new Error(`registry lookup failed: ${error.message}`);
    for (const r of data || []) idByName.set(r.company_name_normalized, r.id);
  }

  // The hand-reviewed exclusion list (19.2). Equality on a normalized name is
  // still a name match, and two unrelated real companies can share a name:
  // `Vertex, Inc.` (tax software) normalizes to the same `vertex` as the
  // registry's Vertex Pharmaceuticals row. Consulted here so a quarterly
  // refresh stops RE-CREATING a link a maintainer already rejected — the read
  // path filters too (sponsorLookup.js), because the exact-name tier there
  // never looks at this FK at all.
  const { data: exclusionRows, error: exclusionErr } = await db
    .from('visa_sponsor_exclusions')
    .select('registry_normalized_name, filing_employer_name');
  if (exclusionErr) throw new Error(`exclusion list lookup failed: ${exclusionErr.message}`);
  // Keyed on the pair, since the two names are frequently equal.
  const excludedPairs = new Set((exclusionRows || []).map((r) => `${r.registry_normalized_name}|${r.filing_employer_name}`));

  let matched = 0;
  let matchedViaDba = 0;
  let excluded = 0;
  for (const s of sponsors) {
    // The matched KEY is the registry company's normalized name — which is what
    // the exclusion is keyed on, not the registry id.
    let key = idByName.has(s.employer_name_normalized) ? s.employer_name_normalized : null;
    let id = key ? idByName.get(key) : null;
    if (!id && s.dba_normalized && idByName.has(s.dba_normalized)) {
      key = s.dba_normalized;
      id = idByName.get(key);
      if (id) matchedViaDba++;
    }
    if (id && excludedPairs.has(`${key}|${s.employer_name_normalized}`)) {
      id = null;
      excluded++;
      if (key === s.dba_normalized) matchedViaDba--;
    }
    s.company_ats_registry_id = id;
    if (id) matched++;
  }
  return { matched, matchedViaDba, ambiguousDba, excluded, distinctKeys: all.length };
}

/**
 * Chunked upsert on the plain-unique employer_name_normalized, with the
 * per-row fallback scripts/import-ats-slugs.js established so one bad row
 * cannot lose the other 499.
 */
async function upsertSponsors(db, sponsors, { fiscalYear, quarter, retrievedAt }) {
  const BATCH = CFG.batchSize;
  let written = 0;
  let failed = 0;

  const toRow = (s) => ({
    employer_name_normalized: s.employer_name_normalized,
    employer_name_display: s.employer_name_display,
    company_ats_registry_id: s.company_ats_registry_id || null,
    filing_count_last_fy: s.filing_count_last_fy,
    avg_wage: s.avg_wage,
    wage_level_distribution: s.wage_level_distribution,
    top_job_titles: s.top_job_titles,
    source_fiscal_year: fiscalYear,
    source_quarter: quarter,
    retrieved_at: retrievedAt,
  });

  for (let i = 0; i < sponsors.length; i += BATCH) {
    const batch = sponsors.slice(i, i + BATCH).map(toRow);
    const { error } = await db.from('visa_sponsors').upsert(batch, { onConflict: 'employer_name_normalized' });
    if (!error) {
      written += batch.length;
      continue;
    }
    console.error(`  visa_sponsors batch upsert failed (${error.message}), retrying rows individually ...`);
    for (const row of batch) {
      const { error: rowErr } = await db.from('visa_sponsors').upsert(row, { onConflict: 'employer_name_normalized' });
      if (rowErr) {
        failed++;
        console.error(`    row "${row.employer_name_normalized}" failed: ${rowErr.message}`);
      } else {
        written++;
      }
    }
  }
  return { written, failed };
}

/**
 * The whole quarterly pass. Shared verbatim by
 * POST /api/internal/refresh-visa-sponsors and
 * scripts/refresh-visa-sponsors.js so the batch cannot drift from the endpoint
 * (the classify-sectors.js precedent).
 *
 * @param {object} db service-role Supabase client
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] aggregate and report, write nothing
 * @param {string}  [opts.filePath] parse an already-downloaded file instead of
 *   fetching (re-runs during development shouldn't re-pull 252 MB)
 * @param {string}  [opts.tmpDir] where the download lands
 * @param {function} [opts.onProgress]
 */
async function refreshVisaSponsors(db, { dryRun = false, filePath = null, tmpDir, onProgress } = {}) {
  const startedAt = Date.now();
  let source = null;
  let localPath = filePath;
  let downloadedBytes = null;
  let cleanUp = false;

  if (localPath) {
    const m = /FY(\d{4})_Q(\d)/i.exec(path.basename(localPath));
    source = { url: `file://${localPath}`, fiscalYear: m ? Number(m[1]) : null, quarter: m ? Number(m[2]) : null };
    if (!m) {
      // Can't read the vintage off an arbitrary filename, and 19.3 forbids
      // storing a number without one.
      const discovered = await discoverLatestLcaFile();
      source.fiscalYear = discovered.fiscalYear;
      source.quarter = discovered.quarter;
    }
  } else {
    source = await discoverLatestLcaFile();
    if (onProgress) onProgress({ phase: 'discovered', ...source });
    const dl = await downloadToTemp(source.url, {
      dir: tmpDir,
      onProgress: (b) => onProgress && onProgress({ phase: 'download', bytes: b }),
    });
    localPath = dl.filePath;
    downloadedBytes = dl.bytes;
    cleanUp = true;
  }

  try {
    if (onProgress) onProgress({ phase: 'parse', filePath: localPath });
    const { sponsors, stats, header } = await aggregateFile(localPath, {
      onProgress: (s) => onProgress && onProgress({ phase: 'parse', ...s }),
    });

    const retrievedAt = new Date().toISOString();
    const summary = {
      source,
      downloadedBytes,
      columns: header ? header.length : null,
      rowsRead: stats.rows,
      certifiedH1b: stats.kept,
      skippedNoEmployerName: stats.skippedNoName,
      employers: sponsors.length,
      retrievedAt,
      dryRun,
    };

    if (!sponsors.length) {
      throw new Error(
        'LCA parse produced zero employers — refusing to write (a schema change would otherwise silently empty the table)'
      );
    }

    const link = await resolveRegistryIds(db, sponsors);
    summary.registryMatched = link.matched;
    summary.registryMatchedViaDba = link.matchedViaDba;
    summary.dbaKeysDroppedAsAmbiguous = link.ambiguousDba;
    // Surfaced so a refresh reports that a hand-reviewed rejection was honoured
    // rather than silently applying it. A drop to 0 means the list stopped
    // matching — a renamed filer, not a fixed collision.
    summary.registryLinksExcluded = link.excluded;

    if (dryRun) {
      summary.wrote = 0;
      summary.elapsedMs = Date.now() - startedAt;
      summary.sample = sponsors
        .slice()
        .sort((a, b) => b.filing_count_last_fy - a.filing_count_last_fy)
        .slice(0, 10);
      return summary;
    }

    const { written, failed } = await upsertSponsors(db, sponsors, {
      fiscalYear: source.fiscalYear,
      quarter: source.quarter,
      retrievedAt,
    });
    summary.wrote = written;
    summary.writeFailed = failed;

    // 19.5's sponsor system tracklists are derived state, so they are rebuilt
    // as part of the refresh rather than drifting until someone remembers to
    // re-run them. Never fails the ETL: the table is already written by this
    // point, and a tracklist that is one quarter stale is a far smaller problem
    // than a refresh that reports failure after succeeding.
    try {
      summary.tracklists = await syncSponsorTracklists(db);
    } catch (e) {
      console.error(`refresh-visa-sponsors: tracklist sync failed (table was written): ${e.message || e}`);
      summary.tracklists = { error: e.message || String(e) };
    }

    summary.elapsedMs = Date.now() - startedAt;
    return summary;
  } finally {
    if (cleanUp && localPath) {
      try {
        fs.unlinkSync(localPath);
      } catch (e) {
        console.error(`could not remove temp file ${localPath}: ${e.message}`);
      }
    }
  }
}

/**
 * Is the `visa_sponsors` data still current?
 *
 * The quarterly refresh workflow is disabled (see
 * .github/workflows/visa-sponsors-refresh.yml — it OOMs on Render's tier while
 * still reporting green), so the ONLY thing standing between this table and
 * silent indefinite staleness is someone remembering to run
 * scripts/refresh-visa-sponsors.js locally. This makes forgetting visible
 * instead of invisible.
 *
 * Reads `retrieved_at` alongside `source_fiscal_year` / `source_quarter` — all
 * three exist for exactly this purpose (19.3). Pure read, no writes, no
 * throwing: a freshness check that breaks its caller would be worse than the
 * staleness it reports.
 *
 * @returns {Promise<{ok: boolean, stale: boolean, ageDays: number|null,
 *   retrievedAt: string|null, fiscalYear: number|null, quarter: number|null,
 *   maxDays: number, message: string}>}
 */
async function checkSponsorFreshness(db) {
  const maxDays = CFG.freshnessMaxDays;
  const { data, error } = await db
    .from('visa_sponsors')
    .select('retrieved_at, source_fiscal_year, source_quarter')
    .order('retrieved_at', { ascending: false })
    .limit(1);

  if (error) {
    return { ok: false, stale: false, ageDays: null, retrievedAt: null, fiscalYear: null, quarter: null, maxDays, message: `visa_sponsors freshness check failed: ${error.message}` };
  }
  const row = (data || [])[0];
  if (!row || !row.retrieved_at) {
    return { ok: false, stale: true, ageDays: null, retrievedAt: null, fiscalYear: null, quarter: null, maxDays, message: 'visa_sponsors is EMPTY — run scripts/refresh-visa-sponsors.js --apply' };
  }

  const ageDays = Math.floor((Date.now() - new Date(row.retrieved_at).getTime()) / 86400000);
  const stale = ageDays > maxDays;
  const provenance = `FY${row.source_fiscal_year} Q${row.source_quarter}, retrieved ${row.retrieved_at}`;
  return {
    ok: !stale,
    stale,
    ageDays,
    retrievedAt: row.retrieved_at,
    fiscalYear: row.source_fiscal_year,
    quarter: row.source_quarter,
    maxDays,
    message: stale
      ? `visa_sponsors is STALE: ${ageDays} days old (limit ${maxDays}) — ${provenance}. The quarterly workflow is disabled (it OOMs on this tier); run "node scripts/refresh-visa-sponsors.js --apply" locally.`
      : `visa_sponsors is current: ${ageDays} days old (limit ${maxDays}) — ${provenance}.`,
  };
}

module.exports = {
  refreshVisaSponsors,
  checkSponsorFreshness,
  discoverLatestLcaFile,
  downloadToTemp,
  aggregateFile,
  resolveRegistryIds,
  upsertSponsors,
  // exported for testing — all pure, no I/O. createAggregator and
  // distributionOf in particular carry the row filter, the DBA-key guard and
  // the wage-level maths, which is where a silent parsing regression would do
  // the most damage (19.3: someone may be making an immigration-relevant
  // decision off these numbers).
  annualizeWage,
  columnIndex,
  resolveColumns,
  absoluteDolUrl,
  DOL_HEADERS,
  createAggregator,
  distributionOf,
  topN,
  upperSet,
};
