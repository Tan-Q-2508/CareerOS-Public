#!/usr/bin/env node
// humanizer.test.js — the anti-AI-tells detector, scrubber and retry wrapper
// (spec 7.15 / 8.7). What matters most here is the false-positive side: a
// range like 2019–2021, a word the JD itself uses, or "ensuring" as a main
// verb must never be flagged, or the humanizer would spend retries (and real
// strong-tier calls) rewriting honest text.
//
//   node packages/shared/src/writing/__tests__/humanizer.test.js

const assert = require('assert');
const h = require('../humanizer');
const tunables = require('../../tunables.json');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
const rules = (text, opts) => h.aiTellHits(text, opts).map((x) => x.rule);

console.log('aiTellHits:');
check('an AI-vocabulary word is caught in any inflection', () => {
  assert.deepStrictEqual(rules('Delved into churn data'), ['ai_word']);
  assert.deepStrictEqual(rules('Showcasing the new flow'), ['ai_word']);
  assert.deepStrictEqual(rules('Leveraged SQL to size the market'), ['ai_word']);
});
check('a word inside a longer word is not a hit', () => {
  assert.deepStrictEqual(rules('Fostered? no. Built a fosterage report'), ['ai_word']);
  assert.deepStrictEqual(rules('Wrote the realmente docs for crucible tests'), []);
});
check('a word the JD itself uses is allowed', () => {
  assert.deepStrictEqual(rules('Leveraged SQL to size the market', { allow: ['leverage'] }), []);
  const allow = h.jdAllowList({ jdText: 'You will leverage data and build robust systems.' });
  assert.ok(allow.includes('leverage') && allow.includes('robust'));
  assert.deepStrictEqual(rules('Built robust ETL', { allow }), []);
});
check('a stock phrase is caught case-insensitively', () => {
  assert.deepStrictEqual(rules('A true Team Player in logistics'), ['ai_phrase']);
});
check('a trailing significance clause is caught; "ensuring" as a main verb is not', () => {
  assert.deepStrictEqual(rules('Rebuilt the QA checklist, ensuring zero misses'), ['ing_tail']);
  assert.deepStrictEqual(rules('Owned ensuring uptime for 3 sites'), []);
});
check('dashes: a connector is a hit, a numeric range is not', () => {
  assert.deepStrictEqual(rules('Cut costs — a lot'), ['dash']);
  assert.deepStrictEqual(rules('Led the team 2019–2021 across 10–15 stores'), []);
});
check('not-only-but and curly quotes', () => {
  assert.ok(rules('Not only cut cost but also time').includes('not_only_but'));
  assert.deepStrictEqual(rules('Called it “done”'), ['curly_quote']);
});
check('plain human text has no hits', () => {
  assert.deepStrictEqual(rules('Ran weekly pricing reviews for 40 SKUs and cut returns 12%.'), []);
});

console.log('scrubTells:');
check('a dash pair becomes parentheses, a lone dash a comma, a range a hyphen', () => {
  assert.strictEqual(h.scrubTells('Built a tool — used by 40 teams — to cut costs'), 'Built a tool (used by 40 teams) to cut costs');
  assert.strictEqual(h.scrubTells('Cut costs — a lot'), 'Cut costs, a lot');
  assert.strictEqual(h.scrubTells('2019–2021'), '2019-2021');
});
check('curly quotes become straight', () => {
  assert.strictEqual(h.scrubTells('“done” and it’s'), '"done" and it\'s');
});

console.log('documentTells:');
check('the same opening verb on more than the cap is flagged', () => {
  const d = h.documentTells(['Led A', 'Led B', 'Led C', 'Led E', 'Built D']);
  assert.deepStrictEqual(d.repeatedOpeners, [{ verb: 'led', count: 4 }]);
  assert.strictEqual(d.problems.length, 1);
});
check('result tails over the cap are flagged', () => {
  const d = h.documentTells(['Did A, resulting in 5%', 'Did B, leading to 3%', 'Made C contributing to 2%'], { maxSameOpener: 9 });
  assert.strictEqual(d.resultTails, 3);
  assert.strictEqual(d.problems.length, 1);
});

console.log('nudgeOnce:');
check('the first call returns a tell as the retry message; the second accepts it', () => {
  const v = h.nudgeOnce(() => null, (p) => [p.text], { where: 'the answer' });
  assert.match(v({ text: 'I delve into data' }), /the answer reads as AI-written/);
  assert.strictEqual(v({ text: 'I delve into data' }), null);
});
check('a base-validator failure always wins and is never swallowed', () => {
  const v = h.nudgeOnce((p) => (p.ok ? null : 'broken'), (p) => [p.text]);
  assert.strictEqual(v({ ok: false, text: 'x' }), 'broken');
  assert.strictEqual(v({ ok: false, text: 'x' }), 'broken');
});

console.log('humanizerInstruction:');
check('every kind carries the shared rules plus its own, with no dash connectors in the prompt', () => {
  for (const kind of ['resume', 'bulletEdit', 'coverLetter', 'answer']) {
    const s = h.humanizerInstruction(kind);
    assert.ok(s.includes('WRITE LIKE A PERSON'));
    assert.ok(s.includes('delve'));
    assert.ok(!/[—–]/.test(s), `${kind} prompt uses a dash`);
  }
  assert.ok(h.humanizerInstruction('resume').includes(`more than ${tunables.humanizer.maxSameOpeningVerb} bullets`));
});
check('every cover-letter banned phrase (spec 8.3) is also a humanizer phrase', () => {
  const hp = new Set(tunables.humanizer.bannedPhrases);
  for (const p of tunables.coverLetter.bannedPhrases) assert.ok(hp.has(p), p);
});

console.log('grounding:');
check('a number whose unit changed, or with no source, is flagged; a spelled-out count is not', () => {
  const src = 'raising first-pass yield by 17% and cutting errors by 22% across six platforms; $425K seed ask';
  assert.deepStrictEqual(h.ungroundedNumbers('lifting yield by 17 points', src), ['17 points']);
  assert.deepStrictEqual(h.ungroundedNumbers('cut costs 30%', src), ['30%']);
  assert.deepStrictEqual(h.ungroundedNumbers('cut errors 22% across 6 platforms', src), []);
  assert.deepStrictEqual(h.ungroundedNumbers('raised a 425K seed with 4+ years of experience', src), []);
});
check('a name the source never uses is flagged; synonyms, plurals and substrings behave', () => {
  assert.deepStrictEqual(h.ungroundedNames('Migrated ERP and SAP CRM data', 'erp crm sapling'), ['SAP']);
  assert.deepStrictEqual(h.ungroundedNames('Built tools for Large Language Models and APIs', 'llm api'), []);
  assert.deepStrictEqual(h.ungroundedNames('Stored data in SQL tables', 'supabase postgres'), []);
});
check('filler tails are removed; a real "on time" is kept', () => {
  assert.strictEqual(h.stripFillerTail('Cut downtime by 30% successfully.'), 'Cut downtime by 30%.');
  assert.strictEqual(h.stripFillerTail('Sped up releases by 15% on time.'), 'Sped up releases by 15%.');
  assert.strictEqual(h.stripFillerTail('Shipped 4 releases on time.'), 'Shipped 4 releases on time.');
});
check('an ungrounded name is dropped only where it is one item of a list', () => {
  assert.strictEqual(h.dropListItem('Built dashboards in Power BI and Tableau, tracking revenue.', 'Tableau'), 'Built dashboards in Power BI, tracking revenue.');
  assert.strictEqual(h.dropListItem('Built Power BI, Excel, and Tableau dashboards.', 'Tableau'), 'Built Power BI and Excel dashboards.');
  assert.strictEqual(h.dropListItem('Built Excel, Tableau, and SQL reports.', 'Tableau'), 'Built Excel and SQL reports.');
  assert.strictEqual(h.dropListItem('Built Power BI, Excel, Tableau, and SQL reports.', 'Tableau'), 'Built Power BI, Excel, and SQL reports.');
  assert.strictEqual(h.dropListItem('Analyzed data in Tableau for 3 teams.', 'Tableau'), 'Analyzed data in Tableau for 3 teams.');
});
check('present-tense openers are found only in the lines given (finished work)', () => {
  assert.deepStrictEqual(h.presentTenseOpeners(['Deliver X', 'Building Y', 'Built Z', 'Cut A', 'Set up B']), ['Deliver', 'Building']);
});

console.log(`${passed} checks passed`);
