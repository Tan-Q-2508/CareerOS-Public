#!/usr/bin/env node
// resumeContent.test.js — which roles a generated résumé must keep (7.5), how
// the fill pass restores left-out entries and trims an overshoot (7.12 step
// 7.5), and the opening-verb limit (7.15).
//
// The fixture is structural only (titles, dates, neutral sentences); it is not
// a résumé and nothing here is shown to a user.
//
//   node apps/server/src/generation/__tests__/resumeContent.test.js

const assert = require('assert');
const { humanizer } = require('@careeros/shared');
const { mandatoryRoleIndices, isDroppableRole, makeValidate: makeValidateDirector } = require('../contentDirector');
const { computeAddBackPool, makeValidateFill, mergeFillPass, trimFillToFit } = require('../fillPass');
const { assemble, diversifyOpeners, openersAtLimit } = require('../generateResume');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

const role = (title, start, end, n = 3) => ({
  title, company: `Company ${title}`, dates: { start, end },
  bullets: Array.from({ length: n }, (_, k) => ({ id: `${title}-${k}`, text: `Sentence ${k} for ${title}` })),
});
const profile = {
  roles: [
    role('Analyst', '2026-05', 'present'), // 0 current
    role('Planning Intern', '2026-02', '2026-05', 2), // 1 three months, finished -> droppable
    role('Operations Intern', '2025-06', '2025-12'), // 2 six months
    role('Research Intern', '2025-01', '2025-09'), // 3 eight months
    role('Associate', '2022-11', '2024-07'), // 4 full-time
    role('Engineering Intern', '2022-02', '2022-07'), // 5 five months
  ],
  projects: [
    { title: 'Project One', dates: { start: '2026-06', end: 'present' }, bullets: [{ id: 'p0-0', text: 'a' }, { id: 'p0-1', text: 'b' }, { id: 'p0-2', text: 'c' }] },
    { title: 'Project Two', dates: { start: '2024-09', end: '2024-12' }, bullets: [{ id: 'p1-0', text: 'd' }] },
  ],
  education: [],
};

console.log('7.5 — roles that must be shown');
check('every role except a finished <=3-month internship is mandatory', () => {
  assert.deepStrictEqual(mandatoryRoleIndices(profile), [0, 2, 3, 4, 5]);
  assert.strictEqual(isDroppableRole(profile.roles[1]), true);
});
check('a short role that is ongoing, or not an internship, is never droppable', () => {
  assert.strictEqual(isDroppableRole({ title: 'Intern', dates: { start: '2026-09', end: 'present' } }), false);
  assert.strictEqual(isDroppableRole({ title: 'Contract Analyst', dates: { start: '2024-01', end: '2024-03' } }), false);
  assert.strictEqual(isDroppableRole({ title: 'Intern', dates: { start: 'Summer', end: '?' } }), false);
});
check('the Director validator rejects a plan that leaves out a mandatory role', () => {
  const plan = (roles) => ({ include_roles: roles.map((index, k) => ({ index, bullet_target: k === 0 ? 4 : 3 })), include_projects: [], reasoning: '' });
  const v = makeValidateDirector(mandatoryRoleIndices(profile));
  assert.match(v(plan([0, 2, 4, 5])), /missing role index 3/);
  assert.strictEqual(makeValidateDirector(mandatoryRoleIndices(profile))(plan([0, 2, 3, 4, 5])), null);
});
check('a retry that still leaves out a mandatory role is accepted (the safety net adds it)', () => {
  const plan = (roles) => ({ include_roles: roles.map((index, k) => ({ index, bullet_target: k === 0 ? 4 : 3 })), include_projects: [], reasoning: '' });
  const v = makeValidateDirector(mandatoryRoleIndices(profile));
  v(plan([0, 2, 4, 5]));
  assert.strictEqual(v(plan([0, 2, 4, 5])), null);
});

console.log('7.12 step 7.5 — fill pass restores left-out entries');
const selected = { roleIndices: [0, 2, 3, 4, 5], projectIndices: [0] };
const addBackPool = computeAddBackPool({ profile, selected });
check('the add-back pool holds only entries not on the page', () => {
  assert.deepStrictEqual(addBackPool.roles.map((r) => r.role_index), [1]);
  assert.deepStrictEqual(addBackPool.projects.map((p) => p.project_index), [1]);
});
const fb = (entry_type, entry_index, id) => ({ entry_type, entry_index, source_bullet_id: id, short: 's', one_line: 'o', two_line: 't' });
const validateFill = makeValidateFill({ sparePool: { roles: [], projects: [] }, selected, maxBullets: 6, addBackPool });
check('a restored role needs at least 2 of its own bullets', () => {
  assert.match(validateFill({ bullets: [fb('role', 1, 'Planning Intern-0')] }), /at least 2/);
  assert.strictEqual(validateFill({ bullets: [fb('role', 1, 'Planning Intern-0'), fb('role', 1, 'Planning Intern-1')] }), null);
});
check('a restored entry whose master has 1 bullet may come back with 1', () => {
  assert.strictEqual(validateFill({ bullets: [fb('project', 1, 'p1-0')] }), null);
});
check('a bullet cited on the wrong entry is rejected', () => {
  assert.match(validateFill({ bullets: [fb('role', 1, 'Analyst-0'), fb('role', 1, 'Planning Intern-1')] }), /not an available spare bullet/);
});
check('mergeFillPass starts a group for a restored entry', () => {
  const merged = mergeFillPass({ experience: [{ role_index: 0, bullets: [] }], projects: [] }, [fb('role', 1, 'Planning Intern-0'), fb('role', 1, 'Planning Intern-1')]);
  assert.deepStrictEqual(merged.experience.map((g) => [g.role_index, g.bullets.length]), [[0, 0], [1, 2]]);
});
check('trimFillToFit cuts from the end and drops a restored entry below its floor whole', () => {
  const bullets = [fb('role', 2, 'x'), fb('role', 1, 'Planning Intern-0'), fb('role', 1, 'Planning Intern-1')];
  const fitsAtMost = (n) => (d) => (d.experience.reduce((a, g) => a + g.bullets.length, 0) <= n ? { ok: true } : null);
  const base = { experience: [], projects: [] };
  // Room for 2: removing the last bullet would leave the restored role at 1,
  // below its floor, so the whole role goes and only the first bullet stays.
  const two = trimFillToFit(base, bullets, addBackPool, fitsAtMost(2));
  assert.deepStrictEqual(two.bullets.map((b) => b.entry_index), [2]);
  const three = trimFillToFit(base, bullets, addBackPool, fitsAtMost(3));
  assert.strictEqual(three.bullets.length, 3);
  const none = trimFillToFit(base, bullets, addBackPool, () => null);
  assert.strictEqual(none.bullets.length, 0);
  assert.strictEqual(none.draft, base);
});

console.log('7.15 — no opening verb more than twice');
check('openerAlternative skips a synonym already at the limit', () => {
  const counts = new Map([['built', 3], ['created', 2]]);
  assert.strictEqual(humanizer.openerAlternative('built', counts, 2), 'Developed');
  assert.strictEqual(humanizer.openerAlternative('zzz', counts, 2), null);
});
check('swapOpener only touches the opening verb it was asked to change', () => {
  assert.strictEqual(humanizer.swapOpener('Built Excel trackers for reviews', 'built', 'Created'), 'Created Excel trackers for reviews');
  assert.strictEqual(humanizer.swapOpener('Led the Built team', 'built', 'Created'), 'Led the Built team');
});

const variants = (text) => ({ short: text, one_line: text, two_line: `${text} for the weekly review with the regional operations leads and finance partners` });
const bullet = (text, id) => ({ ...variants(text), source_bullet_id: id });
const draft = {
  professional_title: 'Analyst',
  summary: [variants('Analyst with three years in operations planning and reporting'), variants('Ran weekly reviews of open risks and milestones'), variants('Known for clear written status reporting')],
  experience: [
    { role_index: 0, bullets: [bullet('Built a reporting tracker for the planning team covering twelve sites', 'Analyst-0'), bullet('Built a vendor scorecard used in quarterly business reviews', 'Analyst-1')] },
    { role_index: 2, bullets: [bullet('Built dashboards tracking throughput and open issues for leadership', 'Operations Intern-0'), bullet('Mapped process steps for the intake workflow across two teams', 'Operations Intern-1')] },
  ],
  projects: [],
  skills: { technical: ['Excel'], management: [], business: [], certifications: [] },
};
const asm = assemble({ draft, profile, contact: { name: 'Test Person' } });
check('openersAtLimit lists a verb already used twice', () => {
  assert.ok(openersAtLimit(asm.model).includes('Built'));
});
check('diversifyOpeners swaps the third "Built" and leaves the first two', () => {
  const dv = diversifyOpeners(draft, asm);
  assert.strictEqual(dv.swaps.length, 1);
  assert.strictEqual(dv.swaps[0].from, 'built');
  const firstWords = [...dv.draft.experience[0].bullets, ...dv.draft.experience[1].bullets].map((b) => b.one_line.split(' ')[0]);
  assert.deepStrictEqual(firstWords, ['Built', 'Built', dv.swaps[0].to, 'Mapped']);
  assert.ok(dv.draft.experience[1].bullets[0].two_line.startsWith(dv.swaps[0].to), 'all three variants of the bullet change together');
  assert.ok(draft.experience[1].bullets[0].one_line.startsWith('Built'), 'the input draft is not mutated');
});
check('a stilted opener is swapped for a plain verb even when used once', () => {
  const d2 = JSON.parse(JSON.stringify(draft));
  d2.experience[1].bullets[1] = bullet('Constructed process maps for the intake workflow across two teams', 'Operations Intern-1');
  const a2 = assemble({ draft: d2, profile, contact: { name: 'Test Person' } });
  const dv = diversifyOpeners(d2, a2);
  const swapped = dv.swaps.find((s) => s.from === 'constructed');
  assert.ok(swapped, 'constructed was swapped');
  // "Built" is already at the limit (the third Built is swapped too), so the
  // stilted verb takes the next plain alternative.
  assert.strictEqual(swapped.to, 'Created');
});
check('assemble reports how much content it shed and the pre-upgrade measurement', () => {
  assert.strictEqual(typeof asm.shed, 'number');
  assert.ok(asm.baseMeas && typeof asm.baseMeas.fillFraction === 'number');
});

console.log(`${passed} checks passed`);
