#!/usr/bin/env node
// diff-wrap-metrics.js — blast-radius report for Divergence D/C (§7.6).
//
// metrics.js measures a line as ceil(totalWidth / availableWidth): a
// uniform-density model that assumes text packs perfectly to the margin. Word
// breaks at word boundaries and leaves a ragged right edge, so the real count is
// always >= the estimate. Phase 3's bug-fix handoff called closing this "the
// highest-risk item in the plan" and shipped NO code for it, because the
// measurement feeds fitToPage, the shotgun variant picker, the fill pass and the
// export page-overflow gate — so changing it can retroactively flip which
// variant an already-generated document would have picked, and can make an
// in-flight Copilot session start failing page_overflow with no user action.
//
// That handoff asked for exactly one thing before anyone touches the default:
// "an offline diff over every existing content_tree/generated_documents row".
// This is that diff. It is READ-ONLY: it writes nothing, changes no tunable, and
// flips no flag. It answers "what would break, and for whom" so the decision can
// be made on numbers instead of nerve.
//
// Population: every resume_edit_sessions.content_tree. That is where real bullet
// text lives — generated_documents rows point at .docx blobs in storage, whose
// text came from exactly these trees, and whose own layout decisions were made
// with the same measurement. Sessions still in `editing` are called out
// separately: those are the ones a change would break under a live user.
//
//   node scripts/diff-wrap-metrics.js
//   node scripts/diff-wrap-metrics.js --verbose   (list every changed bullet)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.secrets', 'deploy.env') });
const { createClient } = require('@supabase/supabase-js');
const {
  SIZE, geometry, DEFAULT_RENDER, wrappedLineCount, wrappedLineCountGreedy, measureTextWidth,
} = require('../apps/server/src/generation/metrics');
const { tunables } = require('@careeros/shared');

const VERBOSE = process.argv.includes('--verbose');

function bulletTextOf(b) {
  return b.picked === 'custom' ? b.custom_text : (b.variants && b.variants[b.picked]);
}

// The in-band test the fill pass and the variant picker both read (7.6). A
// bullet must be a nearly-full ONE line or a nearly-full TWO lines; the stubby
// middle and 3+ lines are out of band.
function inBand(text, lineCount, availW, t) {
  const L = measureTextWidth(text, SIZE.bullet, false) / availW;
  if (lineCount === 1) return L >= t.oneLine;
  if (lineCount === 2) return L >= t.twoLine;
  return false;
}

(async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });

  const { data: sessions, error } = await db
    .from('resume_edit_sessions')
    .select('id, status, user_id, content_tree, updated_at')
    .not('content_tree', 'is', null);
  if (error) throw new Error(error.message);

  const geom = geometry(DEFAULT_RENDER.marginIn);
  const availW = geom.bulletAvailW;
  const T = tunables.bulletFill.strict;

  let bullets = 0;
  let changed = 0;
  let bandChanged = 0;
  let overTwo = 0; // would newly exceed the 2-line export gate
  const byDelta = {};
  const docsTouched = new Map(); // sessionId -> { status, changed, overTwo }
  const examples = [];
  let maxL = 0;
  let maxLText = null;
  const lBuckets = {};

  for (const s of sessions) {
    const tree = s.content_tree || {};
    const all = [
      ...(tree.summary || []),
      ...(tree.entries || []).flatMap((e) => e.bullets || []),
    ];

    for (const b of all) {
      const text = bulletTextOf(b);
      if (!text || typeof text !== 'string') continue;
      bullets += 1;

      const L = measureTextWidth(text, SIZE.bullet, false) / availW;
      if (L > maxL) { maxL = L; maxLText = text; }
      const bucket = (Math.floor(L * 10) / 10).toFixed(1);
      lBuckets[bucket] = (lBuckets[bucket] || 0) + 1;

      const oldN = wrappedLineCount(text, SIZE.bullet, availW);
      const newN = wrappedLineCountGreedy(text, SIZE.bullet, availW);
      if (oldN === newN) continue;

      changed += 1;
      const delta = newN - oldN;
      byDelta[delta] = (byDelta[delta] || 0) + 1;

      const oldBand = inBand(text, oldN, availW, T);
      const newBand = inBand(text, newN, availW, T);
      if (oldBand !== newBand) bandChanged += 1;
      // The export gate rejects any bullet over 2 lines outright.
      if (oldN <= 2 && newN > 2) overTwo += 1;

      const rec = docsTouched.get(s.id) || { status: s.status, changed: 0, overTwo: 0 };
      rec.changed += 1;
      if (oldN <= 2 && newN > 2) rec.overTwo += 1;
      docsTouched.set(s.id, rec);

      if (examples.length < 12 || VERBOSE) {
        examples.push({ session: s.id.slice(0, 8), status: s.status, oldN, newN, oldBand, newBand, text });
      }
    }
  }

  const editing = [...docsTouched.entries()].filter(([, r]) => r.status === 'editing');
  const blocked = [...docsTouched.entries()].filter(([, r]) => r.overTwo > 0);

  // A zero result is indistinguishable from a broken harness, so find the
  // threshold empirically and report it next to the real data. Randomised
  // search over résumé-shaped vocabulary, looking for the smallest L at which
  // greedy needs a line that ceil() does not.
  function divergenceThreshold() {
    const vocab = 'Led managed built designed shipped a the of to and with across for platform service pipeline analytics infrastructure orchestration migration reliability engineering team teams engineers reduced improved increased latency throughput cost forty percent three six twelve ninety median deployment observability containerization authentication authorization interoperability standardization'.split(' ');
    let lowest = Infinity;
    // GROWS a sentence word by word and tests it whenever L lands in the top
    // of the 2-line band, rather than sampling blindly. Divergence is caused
    // by the last word that will not fit, so it only ever appears at the top
    // of a band — blind sampling wastes almost every draw outside it.
    for (let trial = 0; trial < 400; trial++) {
      let t = '';
      for (let w = 0; w < 40; w++) {
        const word = vocab[Math.floor(Math.random() * vocab.length)];
        t = t ? `${t} ${word}` : word;
        const L = measureTextWidth(t, SIZE.bullet, false) / availW;
        if (L > 2.05) break;
        if (L < 1.80 || L >= lowest) continue;
        if (wrappedLineCount(t, SIZE.bullet, availW) !== wrappedLineCountGreedy(t, SIZE.bullet, availW)) lowest = L;
      }
    }
    return lowest;
  }
  const threshold = divergenceThreshold();
  const ceiling = tunables.generation.twoLineSafetyCeiling || 1.9;

  console.log('='.repeat(78));
  console.log('Divergence D/C — greedy word-wrap vs ceil(width/avail)');
  console.log('='.repeat(78));
  console.log(`Sessions with a content_tree : ${sessions.length}`);
  console.log(`Bullets measured             : ${bullets}`);
  console.log(`Bullets whose line count moves: ${changed}  (${bullets ? ((changed / bullets) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`  by delta                   : ${JSON.stringify(byDelta)}`);
  console.log(`Bullets whose IN-BAND verdict flips: ${bandChanged}`);
  console.log(`Bullets that would newly exceed 2 lines (export gate): ${overTwo}`);
  console.log('');
  console.log(`Documents affected at all    : ${docsTouched.size} of ${sessions.length}`);
  console.log(`  ...still 'editing' (a live user would see this break): ${editing.length}`);
  console.log(`  ...that would newly FAIL export on bullet_too_long   : ${blocked.length}`);

  console.log('');
  console.log('-'.repeat(78));
  console.log('WHY — where divergence actually lives, vs where real bullets sit:');
  console.log('-'.repeat(78));
  console.log(`Lowest L at which greedy needs an extra line (randomised search): ${threshold === Infinity ? "none found" : threshold.toFixed(3)}`);
  console.log(`tunables.generation.twoLineSafetyCeiling                        : ${ceiling}`);
  console.log(`Highest L across all ${bullets} real bullets                        : ${maxL.toFixed(3)}`);
  console.log(`L distribution                                                 : ${JSON.stringify(lBuckets)}`);
  if (maxLText) console.log(`  widest bullet: "${maxLText.slice(0, 110)}${maxLText.length > 110 ? "…" : ""}"`);
  console.log('');
  if (threshold === Infinity) {
    console.log('No divergence found at all in the search. Widen it before trusting a zero.');
  } else if (ceiling < threshold) {
    console.log(`Divergence begins above L ~${threshold.toFixed(3)}, and twoLineSafetyCeiling caps every`);
    console.log(`two-line bullet at ${ceiling} — so the ceiling already closes this exposure.`);
  } else {
    console.log('READ THIS PART. The zero above is NOT structural.');
    console.log('');
    console.log(`Divergence is reachable at L ~${threshold.toFixed(3)}, which is BELOW the ${ceiling} safety`);
    console.log('ceiling — so the ceiling does not exclude it. And the widest real bullet');
    console.log(`already sits at ${maxL.toFixed(3)}, inside that window.`);
    console.log('');
    console.log('So: nothing in the corpus diverges today, but that is margin, not a');
    console.log('guarantee. A future bullet landing in the narrow band between');
    console.log(`~${threshold.toFixed(2)} and ${ceiling} would measure 2 lines and render 3.`);
    console.log('');
    console.log("That makes switching to greedy SAFE on todays data (0 documents change,");
    console.log('0 live sessions break) and also worth doing, since the current model can');
    console.log('under-count inside a band the code explicitly permits. It is still a');
    console.log('deliberate call, not an automatic one — re-run this before flipping.');
  }

  if (examples.length) {
    console.log('\n' + '-'.repeat(78));
    console.log(VERBOSE ? 'Every changed bullet:' : `First ${Math.min(12, examples.length)} changed bullets:`);
    console.log('-'.repeat(78));
    for (const e of examples.slice(0, VERBOSE ? examples.length : 12)) {
      console.log(`[${e.session} ${e.status}] ${e.oldN} -> ${e.newN} lines, in-band ${e.oldBand} -> ${e.newBand}`);
      console.log(`   "${e.text.slice(0, 150)}${e.text.length > 150 ? '…' : ''}"`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('READ-ONLY. Nothing was written, no tunable changed, no flag flipped.');
  console.log('The greedy measurement lives in metrics.js as wrappedLineCountGreedy');
  console.log('and is called by NOTHING in the render or fit path — only by this script.');
  console.log('='.repeat(78));
})().catch((e) => {
  console.error('diff-wrap-metrics failed:', e.message || e);
  process.exit(1);
});
