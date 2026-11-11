// Client-side half of spec 7.14.13's Live ATS Scoreboard. Computes the SAME
// summary the server does (packages/shared/src/ats/atsSummary.js's
// summarizeAts, built on the one synonym-aware matcher in
// calculateAtsScore.js) so the optimistic number shown between edits and the
// authoritative number returned by the next debounced PATCH are never two
// independently-tuned implementations — only the section-TEXT extraction
// below can differ, and that's covered by the parity check in this
// session's verification.
//
// @careeros/shared is a CommonJS workspace package resolved via an npm
// workspace symlink; see vite.config.js's optimizeDeps/commonjsOptions
// comment for why the subpath import (never the package index, which pulls
// in Node-only deps like @google/genai) is required.
import sharedAtsSummary from '@careeros/shared/src/ats/atsSummary.js';
import sharedCalc from '@careeros/shared/src/ats/calculateAtsScore.js';

const { summarizeAts } = sharedAtsSummary;
const { skillPresent, DEFAULT_WEIGHTS } = sharedCalc;

// bulletText — duplicated in Workbench.jsx/ResumeCanvas.jsx too (flagged as
// a follow-up cleanup in the Session 21b handoff, not done here to keep this
// diff scoped to the ATS feature).
function bulletText(b) {
  return b.picked === 'custom' ? b.custom_text : b.variants && b.variants[b.picked];
}

// Mirrors apps/server/src/generation/atsCheck.js's coreKeywordText /
// summaryTitleText / skillsKeywordText, reading content_tree directly
// instead of the server's assembleFromTree model. PARITY INVARIANTS (kept
// in sync deliberately — a change here without the matching server change
// breaks the reconciliation guarantee 7.14.13 promises):
//   - title is tree.professional_title, verbatim (== model.header.title).
//   - experience/project entries contribute header.title ONLY — never
//     header.company, header.dates, or education (coreKeywordText doesn't
//     read them either).
//   - graveyarded entries excluded; tree.graveyard_bullets is NEVER read
//     (assembleFromTree doesn't fold it in either).
//   - bullets sorted by `order` (byte-identical join order to the server).
//   - tree.skills rows used verbatim ({label, items}) — same as model.skills.
//   - separator ' \n ' between parts, then .toLowerCase() per section.
export function sectionsFromTree(tree) {
  const sortedB = (list) => (list || []).slice().sort((a, b) => a.order - b.order);
  const active = (kind) => (tree.entries || [])
    .filter((e) => e.kind === kind && !e.graveyard)
    .slice()
    .sort((a, b) => a.order - b.order);

  const summaryBullets = sortedB(tree.summary).map(bulletText);

  const core = [tree.professional_title, ...summaryBullets];
  for (const e of active('experience')) core.push(e.header.title, ...sortedB(e.bullets).map(bulletText));
  for (const e of active('project')) core.push(e.header.title, ...sortedB(e.bullets).map(bulletText));

  const skills = [];
  for (const row of tree.skills || []) skills.push(row.label, ...(row.items || []));

  const join = (parts) => parts.filter((p) => p != null).join(' \n ').toLowerCase();
  return {
    core: join(core),
    summaryTitle: join([tree.professional_title, ...summaryBullets]),
    skills: join(skills),
  };
}

// Rebuilds a { required_skills, nice_to_have_skills } jdProfile losslessly
// from the server's `ats.terms` — so the client never needs a separate JD
// payload field, only the one `ats` object already carried on session state.
export function jdProfileFromTerms(ats) {
  const required_skills = [];
  const nice_to_have_skills = [];
  for (const t of (ats && ats.terms) || []) (t.required ? required_skills : nice_to_have_skills).push(t.term);
  return { required_skills, nice_to_have_skills };
}

// The optimistic local score for the CURRENT (possibly unsaved) tree.
// weights/target come from the last server `ats` (echoed exactly so the
// client never needs to import tunables.json into the browser); falls back
// to the shared engine's own DEFAULT_WEIGHTS, which are byte-identical to
// tunables.generation.atsWeightsV2 today.
export function computeLocalAts(tree, serverAts) {
  if (!tree || !serverAts) return null;
  const jdProfile = jdProfileFromTerms(serverAts);
  if (!jdProfile.required_skills.length && !jdProfile.nice_to_have_skills.length) return null;
  return summarizeAts({
    sections: sectionsFromTree(tree),
    jdProfile,
    weights: serverAts.weights || DEFAULT_WEIGHTS,
    target: serverAts.target,
  });
}

// spec 7.14.13's gaming guardrail: a soft, non-blocking, non-scoring hint —
// "if an edit adds a keyword but the bullet's word count barely changes,
// that's a sign the term was tacked on rather than written into a real
// sentence." Fires only for genuinely NEW terms (present after, absent
// before) whose net word delta doesn't clear wordsPerAddedTerm per term —
// so a straight word-swap (delta <= 0) always fires, and a term woven into
// a real sentence (delta >= ~2 per term) never does. Deliberately excludes
// variant-cycling (treeOps.setVariant/cycleVariant) — swapping between
// pre-authored short/one_line/two_line text changes word count by design
// with no authorship involved; only text an AI edit or the Custom Bullet
// Injector (7.14.14, which has since shipped) actually WROTE is checked.
const wc = (s) => (String(s || '').match(/\S+/g) || []).length;

export function naturalnessHint({ before, after, jdTerms, wordsPerAddedTerm }) {
  const beforeLc = String(before || '').toLowerCase();
  const afterLc = String(after || '').toLowerCase();
  const addedTerms = (jdTerms || []).filter((t) => skillPresent(afterLc, t) && !skillPresent(beforeLc, t));
  if (!addedTerms.length) return null;
  const delta = wc(after) - wc(before);
  return delta < addedTerms.length * wordsPerAddedTerm ? { terms: addedTerms } : null;
}

export { skillPresent };
