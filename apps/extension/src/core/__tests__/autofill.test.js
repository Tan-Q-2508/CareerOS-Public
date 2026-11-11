#!/usr/bin/env node
// autofill.test.js — regression suite for the Application Autofill core
// (spec §15 session 28). Plain Node + assert, matching the repo's existing
// test style:
//   node apps/extension/src/core/__tests__/autofill.test.js
//
// Covers the pure logic only — label derivation and value writing need a real
// DOM and real framework-controlled inputs, which are verified against a live
// Greenhouse form instead (see the session handoff). What IS covered here is
// everything whose failure would be silent:
//   - the answer-bank reuse key (a wrong collapse stores a wrong answer
//     forever; a wrong split silently defeats cross-platform reuse)
//   - the EEO guard (a miss means the extension does something §14 forbids)
//   - standard-field matching (a wrong hit puts the wrong data in a field)
//   - the posting-id parser, which server and extension must agree on
//   - drift between the shared normalizer and the extension's copy of it

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { normalizeQuestion } = require('../normalizeQuestion');
const guards = require('../guards');
const matcher = require('../matcher');
const filler = require('../filler');
const greenhouse = require('../../adapters/greenhouse');
const lever = require('../../adapters/lever');
const ashby = require('../../adapters/ashby');
const panel = require('../../ui/panel');
const { extractPostingId: serverExtractPostingId } = require('../../../../server/src/routes/autofill');

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

console.log('normalizeQuestion — the answer-bank reuse key:');

check('the same question across three ATS renderings collapses to one key', () => {
  const greenhouseText = 'Are you legally authorized to work in the United States? *';
  const leverText = 'Are you legally authorized to work in the United States?';
  const workdayText = '  are you legally authorized to work in the united states  ';
  const key = normalizeQuestion(greenhouseText);
  assert.strictEqual(normalizeQuestion(leverText), key);
  assert.strictEqual(normalizeQuestion(workdayText), key);
  assert.strictEqual(key, 'are you legally authorized to work in the united states');
});

check('smart quotes and straight quotes produce the same key', () => {
  assert.strictEqual(
    normalizeQuestion("What's your notice period?"),
    normalizeQuestion('What’s your notice period?')
  );
});

check('noise parentheticals are stripped', () => {
  assert.strictEqual(normalizeQuestion('Cover letter (optional)'), 'cover letter');
  assert.strictEqual(normalizeQuestion('Start date (required)'), 'start date');
});

check('meaningful parentheticals are KEPT (they change the question)', () => {
  assert.ok(normalizeQuestion('Experience (in years)').includes('in years'));
  assert.ok(normalizeQuestion('Location (city, state)').includes('city'));
});

check('leading filler is stripped, mid-sentence filler is not', () => {
  assert.strictEqual(normalizeQuestion('Please describe your experience'), 'describe your experience');
  assert.strictEqual(
    normalizeQuestion('Tell us why please'),
    'tell us why please'
  );
});

check('two genuinely different questions do NOT collapse', () => {
  assert.notStrictEqual(
    normalizeQuestion('Why do you want to work here?'),
    normalizeQuestion('Why do you want to leave your current role?')
  );
  assert.notStrictEqual(
    normalizeQuestion('Are you authorized to work in the US?'),
    normalizeQuestion('Will you now or in the future require sponsorship?')
  );
});

check('empty/garbage input returns an empty key rather than throwing', () => {
  assert.strictEqual(normalizeQuestion(null), '');
  assert.strictEqual(normalizeQuestion(undefined), '');
  assert.strictEqual(normalizeQuestion('   *  '), '');
  assert.strictEqual(normalizeQuestion('please'), '');
});

console.log('\nSelf-identification classification — §17.5: never inferred, only ever the user\'s own answer:');

const EEO_LABELS = [
  'Race / Ethnicity',
  'Are you Hispanic or Latino?',
  'Gender',
  'What are your pronouns?',
  'Veteran Status',
  'Protected Veteran Status *',
  'Disability Status',
  'Voluntary Self-Identification of Disability',
  'Do you identify as LGBTQ+?',
  'Date of Birth',
  'Social Security Number',
  'Equal Employment Opportunity information',
];
for (const label of EEO_LABELS) {
  check(`classifies as protected: "${label}"`, () => {
    assert.strictEqual(guards.isEeoField(label), true);
  });
}

const NON_EEO_LABELS = ['First Name', 'Email', 'LinkedIn Profile', 'Why do you want to join?', 'Resume/CV'];
for (const label of NON_EEO_LABELS) {
  check(`ordinary field, not protected: "${label}"`, () => {
    assert.strictEqual(guards.isEeoField(label), false);
    assert.strictEqual(guards.isSelfIdentificationField(label, null), false);
  });
}

console.log('\nWord-boundary matching — the live false positive that motivated it:');

check("'age' does not match inside 'manage'/'acknowledge'/'page'", () => {
  assert.strictEqual(guards.isEeoField('How many people did you manage?'), false);
  assert.strictEqual(guards.isEeoField('Which page did you land on?'), false);
  assert.strictEqual(guards.isEeoField('Age'), true);
  assert.strictEqual(guards.isEeoField('What is your age?'), true);
});

console.log('\nConsent/affirmation guard — §14: the user makes their own legal statements:');

check('a real Greenhouse affirmation checkbox is blocked as consent, not filled', () => {
  const label =
    'By applying to this job, I affirm that the information provided on this application and resume is true and complete to the best of my knowledge.';
  assert.strictEqual(guards.isConsentField(label), true);
  assert.strictEqual(guards.blockReason(label, { type: 'text', getAttribute: () => null }), 'consent');
});

check('terms/privacy consents are blocked', () => {
  assert.strictEqual(guards.isConsentField('I agree to the terms and conditions'), true);
  assert.strictEqual(guards.isConsentField('I consent to the processing of my data'), true);
});

check('an ordinary question is not mistaken for a consent', () => {
  assert.strictEqual(guards.isConsentField('Why do you want to work here?'), false);
  assert.strictEqual(guards.isConsentField('Describe a project you led'), false);
});

console.log('\nPresentational controls — react-select duplicate shims:');

check("aria-hidden / tabindex=-1 shim inputs are blocked", () => {
  const shim = { type: 'text', getAttribute: (a) => (a === 'aria-hidden' ? 'true' : null) };
  assert.strictEqual(guards.isPresentationalControl(shim), true);
  assert.strictEqual(guards.blockReason('Phone', shim), 'presentational');

  const offscreen = { type: 'text', getAttribute: (a) => (a === 'tabindex' ? '-1' : null) };
  assert.strictEqual(guards.isPresentationalControl(offscreen), true);
});

check('a real focusable input is not presentational', () => {
  assert.strictEqual(
    guards.isPresentationalControl({ type: 'text', getAttribute: (a) => (a === 'tabindex' ? '0' : null) }),
    false
  );
});

console.log('\nAdapter field hints — labels alone cannot separate these:');

check('Greenhouse ids map résumé and cover-letter file inputs apart', () => {
  assert.strictEqual(greenhouse.fieldHint({ id: 'resume' }), 'resumeFile');
  assert.strictEqual(greenhouse.fieldHint({ id: 'cover_letter' }), 'coverLetterFile');
  assert.strictEqual(greenhouse.fieldHint({ id: 'candidate-location' }), 'location');
  assert.strictEqual(greenhouse.fieldHint({ id: 'question_68272023' }), null);
  assert.strictEqual(greenhouse.fieldHint({}), null);
});

console.log('\nYears-of-experience must not answer a tool-specific question:');

check('"How many years of experience do you have using Jira and Confluence?" is NOT total experience', () => {
  const match = matcher.matchStandardField('How many years of experience do you have using Jira and Confluence?');
  if (match) assert.fail(`wrongly matched "${match.key}" — that question is about one tool, not total experience`);
});

check('a plain total-experience question still matches', () => {
  const match = matcher.matchStandardField('Years of experience');
  assert.ok(match && match.key === 'yearsOfExperience');
});

check('"Location (City)" still matches location, but a mailing address does not', () => {
  const loc = matcher.matchStandardField('Location (City)*');
  assert.ok(loc && loc.key === 'location', 'Location (City) should match the location field');
  const addr = matcher.matchStandardField('Please provide your legal mailing address:');
  if (addr) assert.fail(`mailing address wrongly matched "${addr.key}" — city/state is not a mailing address`);
});

check('blockReason blocks password, hidden, disabled and readonly controls', () => {
  assert.strictEqual(guards.blockReason('Password', { type: 'password' }), 'password');
  assert.strictEqual(guards.blockReason('Token', { type: 'hidden' }), 'hidden');
  assert.strictEqual(guards.blockReason('Name', { type: 'text', disabled: true }), 'disabled');
  assert.strictEqual(guards.blockReason('Name', { type: 'text', readOnly: true }), 'readonly');
  assert.strictEqual(guards.blockReason('Name', { type: 'text' }), null);
});

console.log('\nStandard-field matching:');

const FIELD_CASES = [
  ['First Name *', 'firstName'],
  ['Given name', 'firstName'],
  ['Last Name', 'lastName'],
  ['Full name', 'fullName'],
  ['Email', 'email'],
  ['Email Address *', 'email'],
  ['Phone', 'phone'],
  ['Mobile number', 'phone'],
  ['LinkedIn Profile', 'linkedin'],
  ['GitHub URL', 'github'],
  ['Website', 'portfolio'],
  ['Current Company', 'currentCompany'],
  ['School', 'school'],
  ['Degree', 'degree'],
  ['Resume/CV', 'resumeFile'],
];
for (const [label, expected] of FIELD_CASES) {
  check(`"${label}" -> ${expected}`, () => {
    const match = matcher.matchStandardField(label);
    assert.ok(match, `expected a match for "${label}"`);
    assert.strictEqual(match.key, expected);
  });
}

console.log('\nCombobox option matching — must not select the wrong option on a substring hit:');

const OPTION_MATCH_CASES = [
  ['None of the above', 'no', false],
  ['No', 'no', true],
  ['NO', 'no', true],
  ['San Jose, California, United States', 'san jose', true],
  ['Requires Sponsorship', 'yes', false],
  ['Not sponsored', 'no', false],
  ['Yes, I require sponsorship', 'yes', true],
  ['H-1B visa required', 'h-1b', true],
  ['5+ years', '5', true],
  ['15+ years', '5', false],
  ['North America', 'no', false],
];
for (const [text, target, expected] of OPTION_MATCH_CASES) {
  check(`"${text}" vs "${target}" -> ${expected}`, () => {
    assert.strictEqual(filler.optionTextMatches(text, target), expected);
  });
}

console.log('\nStandard-field matching — the near-misses that must NOT match:');

const NON_MATCHES = [
  'What is the name of the person who referred you?',
  'Company website',
  'Why do you want to work at this company?',
  'How did you hear about us?',
  'Preferred work location',
  'Are you willing to relocate?',
  'Cover Letter',
  'Reference email',
];
for (const label of NON_MATCHES) {
  check(`no standard-field match: "${label}"`, () => {
    const match = matcher.matchStandardField(label);
    if (match) {
      assert.fail(`"${label}" wrongly matched field "${match.key}" (score ${match.score})`);
    }
  });
}

console.log('\nName splitting:');

check('splits a two-part name', () => {
  assert.deepStrictEqual(matcher.splitName('Jane Doe'), { first: 'Jane', last: 'Doe' });
});
check('a three-part name keeps everything after the first as the surname', () => {
  assert.deepStrictEqual(matcher.splitName('Ana Maria Silva'), { first: 'Ana', last: 'Maria Silva' });
});
check('a single-word name leaves the surname empty rather than duplicating', () => {
  assert.deepStrictEqual(matcher.splitName('Cher'), { first: 'Cher', last: '' });
});
check('empty name does not throw', () => {
  assert.deepStrictEqual(matcher.splitName(''), { first: '', last: '' });
  assert.deepStrictEqual(matcher.splitName(null), { first: '', last: '' });
});

console.log('\nPosting-id extraction — server and extension must agree:');

const URL_CASES = [
  ['https://job-boards.greenhouse.io/vestmark/jobs/8089140', '8089140'],
  ['https://boards.greenhouse.io/justworks/jobs/8113972?gh_jid=8113972', '8113972'],
  ['https://app.careerpuck.com/job-board/lyft/job/8697679002?gh_jid=8697679002', '8697679002'],
  ['https://job-boards.greenhouse.io/habitathealth/jobs/5386711008', '5386711008'],
  // The JS embed's iframe, which is what the extension sees when a company
  // serves the application from its own domain (fastly.com/about/jobs/apply).
  ['https://job-boards.greenhouse.io/embed/job_app?for=fastly&token=8188597', '8188597'],
  ['https://boards.greenhouse.io/embed/job_app?for=fastly&token=8188597', '8188597'],
  // `token` is only a posting id on that one path — everywhere else it is an
  // auth token, and reading it would match the wrong job or leak a secret into
  // a query.
  ['https://example.com/apply?token=8188597', null],
  ['https://job-boards.greenhouse.io/embed/job_app?for=fastly&token=abc123def', null],
  ['https://example.com/careers', null],
  ['not a url', null],
];
for (const [url, expected] of URL_CASES) {
  check(`extension: ${url.slice(0, 60)} -> ${expected}`, () => {
    assert.strictEqual(greenhouse.extractPostingId(url), expected);
  });
  check(`server agrees on: ${url.slice(0, 60)}`, () => {
    assert.strictEqual(serverExtractPostingId(url), greenhouse.extractPostingId(url));
  });
}

console.log('\nShared-normalizer copy must not drift:');

check('extension copy is byte-identical to packages/shared canonical', () => {
  const canonical = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'autofill', 'normalizeQuestion.js'),
    'utf8'
  );
  const copy = fs.readFileSync(path.join(__dirname, '..', 'normalizeQuestion.js'), 'utf8');
  assert.strictEqual(
    copy.replace(/\r\n/g, '\n'),
    canonical.replace(/\r\n/g, '\n'),
    'run `npm run sync:extension-shared` — the extension copy has drifted from the canonical shared normalizer'
  );
});

check('server and extension normalizers produce identical keys', () => {
  const serverNormalize = require('@careeros/shared').normalizeQuestion;
  const samples = [
    'Are you legally authorized to work in the United States? *',
    'How did you hear about us?',
    'Please describe your experience (optional)',
    "What's your desired salary?",
  ];
  for (const s of samples) {
    assert.strictEqual(serverNormalize(s), normalizeQuestion(s), `mismatch on: ${s}`);
  }
});


// ---------------------------------------------------------------------------
// Lever (spec §15 session 29). The adapter is DOM shape only, so the fake
// nodes below mirror the markup read off a real posting
// (jobs.lever.co/ro/<uuid>/apply, 2026-08-20) rather than an idealised one:
// custom questions have no <label> at all, and each multiple-choice option is
// wrapped in a <label> reading just "Yes".
// ---------------------------------------------------------------------------
console.log('\nLever adapter:');

// Minimal stand-ins for the three DOM methods the adapter uses. Not a DOM
// implementation — just enough shape that the adapter's real code runs.
function node({ classes = [], text = '', children = [] } = {}) {
  const self = {
    classList: classes,
    textContent: text,
    children,
    querySelector(sel) {
      const want = sel.replace('.', '');
      for (const child of self.children) {
        if (child.classList.includes(want)) return child;
        const nested = child.querySelector ? child.querySelector(sel) : null;
        if (nested) return nested;
      }
      return null;
    },
  };
  return self;
}

function control({ name = '', type = 'text', ancestor = null } = {}) {
  return {
    tagName: 'INPUT',
    type,
    name,
    getAttribute: (k) => (k === 'name' ? name || null : k === 'type' ? type : null),
    closest: (sel) => (ancestor && sel.includes('application-question') ? ancestor : null),
  };
}

check('a custom question takes its text from the card wrapper, not its name attribute', () => {
  const wrapper = node({
    classes: ['application-question', 'custom-question'],
    children: [
      node({
        classes: ['application-label'],
        children: [node({ classes: ['text'], text: 'How did you hear about us?' })],
      }),
    ],
  });
  const el = control({ name: 'cards[06e54799-8fbd-41b0-b37d-da1d3014c432][field1]', type: 'textarea', ancestor: wrapper });
  assert.strictEqual(lever.labelFor(el), 'How did you hear about us?');
  // The cascade fallback it replaces would have been unusable as a key.
  assert.strictEqual(normalizeQuestion('cards[06e54799][field1]'), 'cards 06e54799 field1');
});

check('a multiple-choice option is labelled by its question, not by its own option text', () => {
  const wrapper = node({
    classes: ['application-question', 'custom-question'],
    children: [
      node({
        classes: ['application-label'],
        children: [node({ classes: ['text'], text: 'Are you able to reliably commute to this facility?' })],
      }),
    ],
  });
  const yes = control({ name: 'cards[e6a8b66e][field0]', type: 'radio', ancestor: wrapper });
  assert.strictEqual(lever.labelFor(yes), 'Are you able to reliably commute to this facility?');
});

check('a standard field reads its visible label, required marker and all', () => {
  const wrapper = node({
    classes: ['application-question'],
    children: [node({ classes: ['application-label'], text: 'Full name✱' })],
  });
  const el = control({ name: 'name', ancestor: wrapper });
  assert.strictEqual(lever.labelFor(el), 'Full name✱');
  assert.strictEqual(normalizeQuestion(lever.labelFor(el)), 'full name');
});

check('a control outside a question wrapper falls through to the core cascade', () => {
  assert.strictEqual(lever.labelFor(control({ name: 'timezone' })), null);
});

check("field hints map Lever's name attributes to profile keys", () => {
  const hint = (name) => lever.fieldHint(control({ name }));
  assert.strictEqual(hint('name'), 'fullName');
  assert.strictEqual(hint('email'), 'email');
  assert.strictEqual(hint('phone'), 'phone');
  assert.strictEqual(hint('location'), 'location');
  assert.strictEqual(hint('org'), 'currentCompany');
  assert.strictEqual(hint('resume'), 'resumeFile');
  assert.strictEqual(hint('urls[LinkedIn]'), 'linkedin');
  assert.strictEqual(hint('urls[GitHub]'), 'github');
  assert.strictEqual(hint('urls[Portfolio]'), 'portfolio');
});

check('catch-all URL boxes and consent fields are hinted out of scope', () => {
  const hint = (name) => lever.fieldHint(control({ name }));
  // A nameless catch-all URL box would otherwise become an answer-bank row
  // ("other url") replayed on every future company's form.
  assert.strictEqual(hint('urls[Other]'), 'skip');
  assert.strictEqual(hint('urls[Twitter]'), 'skip');
  assert.strictEqual(hint('selectedLocation'), 'skip');
  assert.strictEqual(hint('consent[marketing]'), 'skip');
  // Self-identification fields are NOT hinted away: they are offered as
  // one-time questions and filled from the user's own saved answer.
  assert.strictEqual(hint('pronouns'), null);
  assert.strictEqual(hint('eeo[gender]'), null);
});

check('an unrecognised field gets no hint, so labels decide instead', () => {
  assert.strictEqual(lever.fieldHint(control({ name: 'cards[abc][field0]' })), null);
  assert.strictEqual(lever.fieldHint({}), null);
});

const LEVER_POSTING_IDS = [
  ['https://jobs.lever.co/ro/f25a6c49-5ed4-4aa0-a5bb-b30e9790f90c/apply', 'f25a6c49-5ed4-4aa0-a5bb-b30e9790f90c'],
  ['https://jobs.lever.co/ro/f25a6c49-5ed4-4aa0-a5bb-b30e9790f90c', 'f25a6c49-5ed4-4aa0-a5bb-b30e9790f90c'],
  ['https://jobs.eu.lever.co/acme/aaaaaaaa-1111-2222-3333-444444444444/apply', 'aaaaaaaa-1111-2222-3333-444444444444'],
  ['https://jobs.lever.co/ro/f25a6c49-5ed4-4aa0-a5bb-b30e9790f90c/apply?lever-origin=applied', 'f25a6c49-5ed4-4aa0-a5bb-b30e9790f90c'],
  ['https://jobs.lever.co/ro', null],
  ['https://jobs.lever.co/', null],
  ['https://job-boards.greenhouse.io/vestmark/jobs/8089140', null],
  ['not a url', null],
];

for (const [postingUrl, expected] of LEVER_POSTING_IDS) {
  check(`lever posting id: ${postingUrl} -> ${expected}`, () => {
    assert.strictEqual(lever.extractPostingId(postingUrl), expected);
  });
}

check('server and Lever adapter agree on every posting id', () => {
  // A disagreement here means the extension asks about one posting and the
  // server answers about another — the wrong résumé on a real application.
  for (const [postingUrl, expected] of LEVER_POSTING_IDS) {
    if (expected === null) continue;
    assert.strictEqual(serverExtractPostingId(postingUrl), expected, `server mismatch on: ${postingUrl}`);
  }
});

console.log('\nLever DOM realities the core had to absorb:');

check('a file input taken out of the tab order is still fillable', () => {
  // Lever's résumé upload: id="resume-upload-input", tabindex="-1", hidden
  // behind a styled label. Blocking it means never attaching a résumé.
  const fileEl = {
    type: 'file',
    name: 'resume',
    getAttribute: (k) => ({ type: 'file', tabindex: '-1', name: 'resume' })[k] ?? null,
  };
  assert.strictEqual(guards.isPresentationalControl(fileEl), false);
  assert.strictEqual(guards.blockReason('Resume/CV', fileEl), null);
});

check('a non-file control taken out of the tab order is still blocked', () => {
  const shim = { type: 'text', getAttribute: (k) => ({ type: 'text', tabindex: '-1' })[k] ?? null };
  assert.strictEqual(guards.isPresentationalControl(shim), true);
});

check('an aria-hidden file input stays blocked', () => {
  const hidden = { type: 'file', getAttribute: (k) => ({ type: 'file', 'aria-hidden': 'true' })[k] ?? null };
  assert.strictEqual(guards.isPresentationalControl(hidden), true);
});

check('self-identification is recognised by field name, not just by label', () => {
  // Lever's pronoun checkboxes are labelled "He/him" per option — the word
  // "pronoun" appears nowhere on the control, so without the name check these
  // would look like ordinary questions and could take a profile value.
  const byName = (name, type) => ({
    type: type || 'checkbox',
    name,
    getAttribute: (k) => (k === 'name' ? name : null),
  });
  assert.strictEqual(guards.isSelfIdentificationField('He/him', byName('pronouns')), true);
  assert.strictEqual(guards.isSelfIdentificationField('Ze/hir', byName('pronouns')), true);
  assert.strictEqual(guards.isSelfIdentificationField('Select ...', byName('eeo[gender]', 'select')), true);
  assert.strictEqual(guards.isSelfIdentificationField('Select ...', byName('eeo[race]', 'select')), true);
  // ...and they are offered, not blocked — the user answers them once.
  assert.strictEqual(guards.blockReason('Select ...', byName('eeo[gender]', 'select')), null);
  // Consent is a different thing and stays blocked outright.
  assert.strictEqual(guards.blockReason('Keep me in the loop', byName('consent[marketing]')), 'consent');
});

check('ordinary fields are not blocked by the name check', () => {
  const byName = (name) => ({ type: 'text', name, getAttribute: (k) => (k === 'name' ? name : null) });
  for (const name of ['name', 'org', 'email', 'phone', 'location', 'urls[GitHub]', 'cards[abc][field0]']) {
    assert.strictEqual(guards.blockReason('Some question', byName(name)), null, `blocked: ${name}`);
  }
});

// A radio group as Lever renders it: <label><input value="Yes"><span>Yes</span></label>
function radioGroup(name, values) {
  const inputs = values.map((value) => ({
    tagName: 'INPUT',
    type: 'radio',
    name,
    value,
    labels: [{ innerText: value }],
    getAttribute: (k) => (k === 'name' ? name : k === 'type' ? 'radio' : null),
  }));
  const doc = { querySelectorAll: () => inputs };
  for (const input of inputs) input.ownerDocument = doc;
  return inputs;
}

check('a yes/no radio group still reports as boolean', () => {
  const [yes] = radioGroup('cards[a][field0]', ['Yes', 'No']);
  assert.strictEqual(matcher.controlType(yes), 'boolean');
  assert.deepStrictEqual(matcher.optionsFor(yes), ['Yes', 'No']);
});

check('a radio group with real options reports as a select, with its options', () => {
  // Otherwise the panel shows a free-text box and the user retypes an option
  // by hand — and a typo there fills nothing.
  const [first] = radioGroup('cards[b][field0]', ['0-2 years', '3-5 years', '6+ years']);
  assert.strictEqual(matcher.controlType(first), 'select');
  assert.deepStrictEqual(matcher.optionsFor(first), ['0-2 years', '3-5 years', '6+ years']);
});

check('a lone checkbox with no option text still reports as boolean', () => {
  const el = { tagName: 'INPUT', type: 'checkbox', name: '', value: '', getAttribute: () => null };
  assert.strictEqual(matcher.controlType(el), 'boolean');
});

check('the adapter label wins over the DOM cascade, and a missing one falls through', () => {
  const el = {
    tagName: 'INPUT',
    type: 'text',
    getAttribute: (k) => (k === 'name' ? 'cards[abc][field0]' : null),
    closest: () => null,
    // The cascade looks ids up in a document; there is no DOM here, so it
    // gets one that finds nothing and falls all the way through.
    ownerDocument: { getElementById: () => null, querySelector: () => null },
  };
  // No adapter: the cascade's last resort is the name attribute.
  assert.strictEqual(matcher.labelFor(el, null), 'cards abc field0');
  // With one: the real question text.
  assert.strictEqual(
    matcher.labelFor(el, null, { labelFor: () => 'What is your notice period?' }),
    'What is your notice period?'
  );
  // An adapter that returns nothing — or throws — must not break the cascade.
  assert.strictEqual(matcher.labelFor(el, null, { labelFor: () => null }), 'cards abc field0');
  assert.strictEqual(
    matcher.labelFor(el, null, {
      labelFor: () => {
        throw new Error('boom');
      },
    }),
    'cards abc field0'
  );
});

check('a Greenhouse answer is reused on the Lever rendering of the same question', () => {
  // The §29 deliverable, at the level this suite can prove without a browser:
  // the two platforms' renderings collapse to one answer-bank key.
  const fromGreenhouse = 'Are you legally authorized to work in the United States? *';
  const fromLever = 'Are you legally authorized to work in the United States?✱';
  assert.strictEqual(normalizeQuestion(fromLever), normalizeQuestion(fromGreenhouse));
  const bank = { [normalizeQuestion(fromGreenhouse)]: { answer_text: 'Yes' } };
  assert.strictEqual(bank[normalizeQuestion(fromLever)].answer_text, 'Yes');
});


// ---------------------------------------------------------------------------
// Self-identification: answered once by the user, then reused (§17.5). The
// rule these checks defend is narrow — nothing may reach such a field except
// an answer this user picked themselves.
// ---------------------------------------------------------------------------
console.log('\nSelf-identification fills:');

function selectControl({ name = '', label = '', options = [] } = {}) {
  const el = {
    tagName: 'SELECT',
    type: 'select-one',
    name,
    options: options.map((text) => ({ text, value: text })),
    getAttribute: (k) => (k === 'name' ? name || null : null),
    closest: () => null,
    ownerDocument: { getElementById: () => null, querySelector: () => null },
  };
  el.__label = label;
  return el;
}

// A tiny adapter that just reports the label we want, the way a real one does.
const labelAdapter = (map) => ({
  labelFor: (el) => map.get(el) || null,
  fieldHint: () => null,
});

check('a gender field is offered as a question, never filled from the profile', () => {
  const el = selectControl({ name: 'eeo[gender]', options: ['Select ...', 'Male', 'Female', 'Decline to self-identify'] });
  const map = new Map([[el, 'Gender']]);
  const scope = { ownerDocument: null, querySelectorAll: () => [el] };
  const plan = matcher.scanForm(scope, { fullName: 'Jane Doe', gender: 'Male' }, {}, labelAdapter(map));
  assert.strictEqual(plan.fills.length, 0, 'nothing may be filled from the profile');
  assert.strictEqual(plan.questions.length, 1);
  assert.strictEqual(plan.questions[0].selfIdentification, true);
  assert.deepStrictEqual(plan.questions[0].options, ['Select ...', 'Male', 'Female', 'Decline to self-identify']);
});

check("a previously given answer IS reused on the next form", () => {
  const el = selectControl({ name: 'eeo[race]', options: ['Select ...', 'Asian', 'Decline to self-identify'] });
  const map = new Map([[el, 'Race']]);
  const scope = { ownerDocument: null, querySelectorAll: () => [el] };
  const key = normalizeQuestion('Race');
  const plan = matcher.scanForm(scope, {}, { [key]: { answer_text: 'Decline to self-identify' } }, labelAdapter(map));
  assert.strictEqual(plan.fills.length, 1);
  assert.strictEqual(plan.fills[0].source, 'answer_bank');
  assert.strictEqual(plan.fills[0].value, 'Decline to self-identify');
  assert.strictEqual(plan.fills[0].selfIdentification, true);
});

check('a standard field that merely sits near one is unaffected', () => {
  const el = selectControl({ name: 'name', options: [] });
  el.tagName = 'INPUT';
  el.type = 'text';
  const map = new Map([[el, 'Full name']]);
  const scope = { ownerDocument: null, querySelectorAll: () => [el] };
  const plan = matcher.scanForm(scope, { fullName: 'Jane Doe' }, {}, labelAdapter(map));
  assert.strictEqual(plan.fills.length, 1);
  assert.strictEqual(plan.fills[0].source, 'profile');
});

check('SSN and date of birth stay blocked outright', () => {
  const el = (label) => ({ type: 'text', getAttribute: () => null });
  assert.strictEqual(guards.blockReason('Social Security Number', el()), 'sensitive');
  assert.strictEqual(guards.blockReason('SSN', el()), 'sensitive');
  assert.strictEqual(guards.blockReason('Date of Birth', el()), 'sensitive');
  assert.strictEqual(guards.isSelfIdentificationField('Social Security Number', null), false);
});

check('legal affirmations are still never checked', () => {
  const box = { type: 'checkbox', getAttribute: () => null };
  assert.strictEqual(guards.blockReason('I certify that the information provided is true', box), 'consent');
  assert.strictEqual(guards.blockReason('I agree to the terms and conditions', box), 'consent');
});


check("Lever's custom-pronoun escape hatch is skipped, the option list is not", () => {
  // All three controls carry the label "Pronouns", so one saved answer would
  // otherwise be ticked in the list AND typed into the custom text box.
  const byId = (id) => ({ id, getAttribute: (k) => (k === 'name' ? 'pronouns' : null) });
  assert.strictEqual(lever.fieldHint(byId('customPronounsOption')), 'skip');
  assert.strictEqual(lever.fieldHint(byId('customPronounsTextField')), 'skip');
  assert.strictEqual(lever.fieldHint(byId('useNameOnlyPronounsOption')), 'skip');
  assert.strictEqual(lever.fieldHint(control({ name: 'pronouns' })), null);
});

check("a select's placeholder row is not offered as an answer", () => {
  const el = {
    tagName: 'SELECT',
    options: [
      { text: 'Select ...', value: '' },
      { text: 'Male', value: 'Male' },
      { text: 'Decline to self-identify', value: 'Decline to self-identify' },
    ],
    getAttribute: () => null,
  };
  assert.deepStrictEqual(matcher.optionsFor(el), ['Male', 'Decline to self-identify']);
  // ...unless every option is value-less, in which case they are all we have.
  const textOnly = { tagName: 'SELECT', options: [{ text: 'Yes', value: '' }, { text: 'No', value: '' }], getAttribute: () => null };
  assert.deepStrictEqual(matcher.optionsFor(textOnly), ['Yes', 'No']);
});


check("an adapter's 'skip' still applies to a self-identification control", () => {
  // Regression: self-ID controls briefly bypassed adapter hints entirely,
  // which also bypassed 'skip' — so Lever's custom-pronoun text box became a
  // third "Pronouns" question and got the same saved answer typed into it.
  const el = {
    tagName: 'INPUT',
    type: 'text',
    id: 'customPronounsTextField',
    name: 'pronouns',
    getAttribute: (k) => (k === 'name' ? 'pronouns' : null),
    closest: () => null,
    ownerDocument: { getElementById: () => null, querySelector: () => null },
  };
  const scope = { ownerDocument: null, querySelectorAll: () => [el], querySelector: () => null, getElementById: () => null };
  const plan = matcher.scanForm(scope, {}, {}, lever);
  assert.strictEqual(plan.questions.length, 0);
  assert.strictEqual(plan.fills.length, 0);
  assert.strictEqual(plan.blocked[0].reason, 'out_of_scope');
});

// ---------------------------------------------------------------------------
// Ashby (spec §15 session 30). The adapter is DOM shape only, so the fake
// nodes below mirror markup read off real application pages (Linear, Ramp,
// OpenAI, Vanta, Ashby, Notion — 2026-08-20) rather than an idealised one:
// there is no <form> element anywhere, fields are identified by
// `data-field-path` rather than id, and a Yes/No question is two <button
// data-option> plus a hidden, unlabelled, tabindex="-1" checkbox.
// ---------------------------------------------------------------------------
console.log('\nAshby adapter:');

// Minimal stand-ins for the DOM methods the adapter and core actually call.
// Not a DOM implementation — just enough shape that the real code runs.
function ashbyButton(option, text) {
  const node = {
    tagName: 'BUTTON',
    innerText: text,
    clicked: 0,
    getAttribute: (k) => (k === 'data-option' ? option : null),
    closest: () => null, // Ashby has no <form> on the page at all
    click() {
      node.clicked += 1;
    },
  };
  return node;
}

/**
 * One .ashby-application-form-field-entry. `kind` is 'text' | 'yesno' |
 * 'consentRadio' — the three shapes that behave differently.
 */
function ashbyField({ path, title, kind = 'text', type = 'text', id = '', name = '', optionLabel = '' }) {
  const titleEl = { innerText: title, textContent: title };
  const yesButton = ashbyButton('yes', 'Yes');
  const noButton = ashbyButton('no', 'No');
  const widget = {
    querySelectorAll: (sel) => (sel === 'button[data-option]' ? [yesButton, noButton] : []),
  };
  const entry = {
    getAttribute: (k) => (k === 'data-field-path' ? path : null),
    querySelector: (sel) => (sel.includes('question-title') ? titleEl : null),
  };
  // A consent radio carries its OWN wrapping <label>; the entry's headline
  // control never does (the title label is a SIBLING, not a wrapper).
  const ownLabel = kind === 'consentRadio' ? { innerText: optionLabel, textContent: optionLabel } : null;
  const attrs = { type, name: name || null, id: id || null };
  if (kind === 'yesno') attrs.tabindex = '-1';
  const el = {
    tagName: type === 'textarea' ? 'TEXTAREA' : 'INPUT',
    type,
    id,
    name,
    value: '',
    labels: ownLabel ? [ownLabel] : [],
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    closest: (sel) => {
      if (sel.includes('data-field-path') || sel.includes('field-entry')) return entry;
      if (sel === 'label') return ownLabel;
      if (sel.includes('input-yesno')) return kind === 'yesno' ? widget : null;
      return null;
    },
  };
  return { el, entry, titleEl, widget, yesButton, noButton };
}

const ASHBY_POSTING_IDS = [
  ['https://jobs.ashbyhq.com/notion/3f842011-eb04-4b75-bf92-8be5a5ce02b2', '3f842011-eb04-4b75-bf92-8be5a5ce02b2'],
  ['https://jobs.ashbyhq.com/notion/3f842011-eb04-4b75-bf92-8be5a5ce02b2/application', '3f842011-eb04-4b75-bf92-8be5a5ce02b2'],
  ['https://jobs.ashbyhq.com/vanta/40F80A35-39D7-4272-ACEB-7AD91EDABF4A', '40f80a35-39d7-4272-aceb-7ad91edabf4a'],
  ['https://jobs.ashbyhq.com/openai', null],
  ['https://jobs.lever.co/ro/f25a6c49-5ed4-4aa0-a5bb-b30e9790f90c/apply', null],
  ['not a url', null],
];

for (const [postingUrl, expected] of ASHBY_POSTING_IDS) {
  check(`ashby posting id: ${postingUrl.slice(0, 60)} -> ${expected}`, () => {
    assert.strictEqual(ashby.extractPostingId(postingUrl), expected);
  });
}

check('server and Ashby adapter agree on every posting id', () => {
  // `jobs.link` holds the board API's jobUrl, which is exactly the posting URL
  // above — so the server must read the same id out of it that the extension
  // does, or the extension asks about one posting and the server answers
  // about another.
  for (const [postingUrl, expected] of ASHBY_POSTING_IDS) {
    if (expected === null) continue;
    assert.strictEqual(serverExtractPostingId(postingUrl), expected, `server mismatch on: ${postingUrl}`);
  }
});

const ashbyDoc = (containers) => ({
  querySelectorAll: (sel) => (sel === '.ashby-application-form-container' ? containers : []),
});
const ashbyContainer = (controlCount) => ({ querySelectorAll: () => new Array(controlCount).fill(0) });

check('the form is a container div, because Ashby renders no <form> at all', () => {
  const container = ashbyContainer(4);
  const doc = ashbyDoc([container]);
  assert.strictEqual(ashby.findForm(doc), container);
  assert.strictEqual(
    ashby.isApplicationPage('https://jobs.ashbyhq.com/vanta/40f80a35-39d7-4272-aceb-7ad91edabf4a/application', doc),
    true
  );
});

// The EEO section is a SECOND sibling container, so querySelector returned two
// thirds of the form and the self-identification questions were never offered.
check('both of Ashby’s containers are returned — the second one holds the EEO section', () => {
  const questions = ashbyContainer(23);
  const eeo = ashbyContainer(14);
  const found = ashby.findForm(ashbyDoc([questions, eeo]));
  assert.deepStrictEqual(found, [questions, eeo]);
});

// A container that is only the posting page's chrome is not the application.
check('a container with too few controls is not counted', () => {
  const real = ashbyContainer(9);
  const found = ashby.findForm(ashbyDoc([ashbyContainer(1), real]));
  assert.strictEqual(found, real);
});

check('the posting page — no controls until the SPA navigates to /application — is not an application page', () => {
  const empty = ashbyDoc([]);
  assert.strictEqual(ashby.findForm(empty), null);
  assert.strictEqual(
    ashby.isApplicationPage('https://jobs.ashbyhq.com/vanta/40f80a35-39d7-4272-aceb-7ad91edabf4a', empty),
    false
  );
});

check('a field takes its text from the question title of its entry', () => {
  const { el } = ashbyField({ path: '_systemfield_name', title: 'Legal Name' });
  assert.strictEqual(ashby.labelFor(el), 'Legal Name');
});

check('a hidden yes/no checkbox — no id, no label of its own — still gets the real question', () => {
  const { el } = ashbyField({
    path: 'bda78810-f000-4f1c-99c5-f783e161f2f7',
    title: 'Will you now or in the future require sponsorship for employment visa status?',
    kind: 'yesno',
    type: 'checkbox',
    name: 'bda78810-f000-4f1c-99c5-f783e161f2f7',
  });
  assert.strictEqual(
    ashby.labelFor(el),
    'Will you now or in the future require sponsorship for employment visa status?'
  );
});

check('a control with its OWN wrapping label keeps that label, not the entry title', () => {
  // Ramp's Phone entry carries an SMS-consent radio pair. Labelling those
  // "Phone" would walk a consent control straight past the consent guard AND
  // match it as a standard phone field.
  const { el } = ashbyField({
    path: '84e7fde5-a83a-4efc-b1c4-4b3ae53d8182',
    title: 'Phone',
    kind: 'consentRadio',
    type: 'radio',
    name: 'communicationConsent',
    optionLabel: 'Yes - I consent to receiving text messages',
  });
  assert.strictEqual(ashby.labelFor(el), null);
  assert.strictEqual(guards.isConsentField('Yes - I consent to receiving text messages'), true);
});

check('a control outside a field entry falls through to the core cascade', () => {
  assert.strictEqual(ashby.labelFor({ closest: () => null, getAttribute: () => null }), null);
  assert.strictEqual(ashby.labelFor({}), null);
});

check('field hints map Ashby data-field-path values to profile keys', () => {
  const hint = (path) => ashby.fieldHint(ashbyField({ path, title: 'x' }).el);
  assert.strictEqual(hint('_systemfield_name'), 'fullName');
  assert.strictEqual(hint('_systemfield_email'), 'email');
  assert.strictEqual(hint('_systemfield_resume'), 'resumeFile');
  assert.strictEqual(hint('_systemfield_location'), 'location');
});

check('a custom question gets no hint, so its visible label decides', () => {
  // This is what makes "LinkedIn Profile"/"Phone Number"/"Current Company"
  // fill through the shared fieldMap with no per-board entry.
  assert.strictEqual(
    ashby.fieldHint(ashbyField({ path: '95cbdfbb-073e-4684-b35e-ca456c7e0a6f', title: 'LinkedIn Profile' }).el),
    null
  );
  assert.strictEqual(ashby.fieldHint({}), null);
});

check('the SMS-consent radio pair is hinted out of scope by name', () => {
  const { el } = ashbyField({
    path: '84e7fde5-a83a-4efc-b1c4-4b3ae53d8182',
    title: 'Phone',
    kind: 'consentRadio',
    type: 'radio',
    name: 'communicationConsent',
    optionLabel: 'No - I do not consent to receiving text messages',
  });
  assert.strictEqual(ashby.fieldHint(el), 'skip');
});

check('a yes/no widget offers its two buttons, with the nodes that pick them', () => {
  const { el, yesButton, noButton } = ashbyField({ path: 'q', title: 'Q?', kind: 'yesno', type: 'checkbox', name: 'q' });
  const options = ashby.choiceOptions(el);
  assert.deepStrictEqual(options.map((o) => o.text), ['Yes', 'No']);
  assert.strictEqual(options[0].node, yesButton);
  assert.strictEqual(options[1].node, noButton);
});

check('an ordinary checkbox has no adapter-supplied options', () => {
  const { el } = ashbyField({ path: 'q', title: 'Q?', type: 'checkbox', name: 'q' });
  assert.strictEqual(ashby.choiceOptions(el), null);
  assert.strictEqual(ashby.isRealControl(el), false);
});

check('a yes/no question is offered as Yes/No, not as the checkbox value "on"', () => {
  const { el } = ashbyField({ path: 'q', title: 'Do you speak fluent German?', kind: 'yesno', type: 'checkbox', name: 'q' });
  assert.strictEqual(matcher.controlType(el, ashby), 'boolean');
  assert.deepStrictEqual(matcher.optionsFor(el, ashby), ['Yes', 'No']);
});

console.log('\nAshby DOM realities the core had to absorb:');

check('an adapter can vouch for a control the presentational heuristic would drop', () => {
  const { el } = ashbyField({ path: 'q', title: 'Q?', kind: 'yesno', type: 'checkbox', name: 'q' });
  // Ashby's real answer control: a genuine checkbox the page merely took out
  // of the tab order. Without the vouch it looks exactly like a react-select
  // required-shim, which is what that guard exists to drop.
  assert.strictEqual(guards.blockReason('Q?', el), 'presentational');
  assert.strictEqual(ashby.isRealControl(el), true);
  assert.strictEqual(guards.blockReason('Q?', el, { vouchedReal: true }), null);
});

check('a vouch cannot waive consent, sensitive, submit or disabled — only presentational', () => {
  const consent = ashbyField({ path: 'c', title: 'I agree to the terms and conditions', type: 'checkbox', name: 'c' }).el;
  assert.strictEqual(guards.blockReason('I agree to the terms and conditions', consent, { vouchedReal: true }), 'consent');
  const dob = ashbyField({ path: 'd', title: 'Date of birth' }).el;
  assert.strictEqual(guards.blockReason('Date of birth', dob, { vouchedReal: true }), 'sensitive');
  const submit = { tagName: 'INPUT', type: 'submit', getAttribute: (k) => (k === 'type' ? 'submit' : null) };
  assert.strictEqual(guards.blockReason('Submit', submit, { vouchedReal: true }), 'submit');
  const disabled = ashbyField({ path: 'x', title: 'X' }).el;
  disabled.disabled = true;
  assert.strictEqual(guards.blockReason('X', disabled, { vouchedReal: true }), 'disabled');
});

check('an untyped button is a submit control inside a form, and not outside one', () => {
  // "A <button> defaults to submit" is a statement about buttons in forms.
  // Ashby's Yes/No options are untyped buttons on a page with no form at all,
  // so without the form check every screening answer is unclickable.
  //
  // `type: 'submit'` on these stands in for the IDL property a REAL <button>
  // always reports even with no type attribute — reading that property instead
  // of the attribute is exactly the bug this catches, and a stub without it
  // passed while the live page failed.
  const button = (closest) => ({
    tagName: 'BUTTON',
    type: 'submit',
    innerText: 'Yes',
    getAttribute: () => null,
    closest,
  });
  assert.strictEqual(guards.isSubmitControl(button((s) => (s === 'form' ? {} : null))), true);
  assert.strictEqual(guards.isSubmitControl(button(() => null)), false);
  // An explicit type attribute is still decisive, form or no form.
  assert.strictEqual(
    guards.isSubmitControl({
      tagName: 'BUTTON',
      type: 'submit',
      innerText: 'Continue',
      getAttribute: (k) => (k === 'type' ? 'submit' : null),
      closest: () => null,
    }),
    true
  );
});

check('the Submit Application button is still recognised as a submit control', () => {
  const submit = { tagName: 'BUTTON', innerText: 'Submit Application', getAttribute: () => null, closest: () => null };
  assert.strictEqual(guards.isSubmitControl(submit), true);
});

check('a yes/no answer clicks the matching option button', () => {
  const { el, yesButton, noButton } = ashbyField({ path: 'q', title: 'Q?', kind: 'yesno', type: 'checkbox', name: 'q' });
  assert.strictEqual(filler.setChoiceValue(el, 'Yes', ashby), true);
  assert.strictEqual(yesButton.clicked, 1);
  assert.strictEqual(noButton.clicked, 0);
  assert.strictEqual(filler.setChoiceValue(el, 'No', ashby), true);
  assert.strictEqual(noButton.clicked, 1);
});

check('an answer matching neither option fills nothing rather than guessing', () => {
  const { el, yesButton, noButton } = ashbyField({ path: 'q', title: 'Q?', kind: 'yesno', type: 'checkbox', name: 'q' });
  assert.strictEqual(filler.setChoiceValue(el, 'Prefer not to say', ashby), false);
  assert.strictEqual(yesButton.clicked + noButton.clicked, 0);
});

check('"No" never commits against an option reading "None of the above"', () => {
  // The word-boundary rule (§17.4) applies to adapter-supplied options too —
  // it is the same optionTextMatches, not a second matcher.
  const { el, widget } = ashbyField({ path: 'q', title: 'Q?', kind: 'yesno', type: 'checkbox', name: 'q' });
  widget.querySelectorAll = () => [ashbyButton('yes', 'None of the above')];
  assert.strictEqual(filler.setChoiceValue(el, 'No', ashby), false);
});

check('the yes/no checkbox is fillable WITH the adapter and blocked without it', async () => {
  const withAdapter = ashbyField({ path: 'q', title: 'Q?', kind: 'yesno', type: 'checkbox', name: 'q' });
  const applied = await filler.applyFill({ el: withAdapter.el, label: 'Q?', value: 'Yes' }, ashby);
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(withAdapter.yesButton.clicked, 1);

  // The guard reaches its own verdict at write time: no adapter, no vouch.
  const noAdapter = ashbyField({ path: 'q', title: 'Q?', kind: 'yesno', type: 'checkbox', name: 'q' });
  const refused = await filler.applyFill({ el: noAdapter.el, label: 'Q?', value: 'Yes' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'presentational');
  assert.strictEqual(noAdapter.yesButton.clicked, 0);
});

check('a whole Ashby form scans into fills, a Yes/No question and a blocked consent', () => {
  const name = ashbyField({ path: '_systemfield_name', title: 'Legal Name', id: '_systemfield_name', name: '_systemfield_name' });
  const email = ashbyField({ path: '_systemfield_email', title: 'Email', type: 'email', id: '_systemfield_email', name: '_systemfield_email' });
  const linkedin = ashbyField({ path: '95cbdfbb-073e-4684-b35e-ca456c7e0a6f', title: 'LinkedIn Profile', id: '95cbdfbb', name: '95cbdfbb' });
  const sponsorship = ashbyField({
    path: 'bda78810-f000-4f1c-99c5-f783e161f2f7',
    title: 'Will you now or in the future require sponsorship?',
    kind: 'yesno',
    type: 'checkbox',
    name: 'bda78810-f000-4f1c-99c5-f783e161f2f7',
  });
  const smsConsent = ashbyField({
    path: '84e7fde5-a83a-4efc-b1c4-4b3ae53d8182',
    title: 'Phone',
    kind: 'consentRadio',
    type: 'radio',
    name: 'communicationConsent',
    optionLabel: 'Yes - I consent to receiving text messages',
  });
  const controls = [name.el, email.el, linkedin.el, sponsorship.el, smsConsent.el];
  const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [smsConsent.el] };
  for (const el of controls) el.ownerDocument = doc;
  const scope = { ownerDocument: doc, querySelectorAll: () => controls };

  const profile = {
    fullName: 'Alex Chen',
    email: 'alex@example.com',
    linkedin: 'https://linkedin.com/in/alexchen',
  };
  const plan = matcher.scanForm(scope, profile, {}, ashby);

  assert.deepStrictEqual(
    plan.fills.map((f) => [f.field, f.value]),
    [['fullName', 'Alex Chen'], ['email', 'alex@example.com'], ['linkedin', 'https://linkedin.com/in/alexchen']]
  );
  assert.strictEqual(plan.questions.length, 1);
  assert.strictEqual(plan.questions[0].label, 'Will you now or in the future require sponsorship?');
  assert.strictEqual(plan.questions[0].inputType, 'boolean');
  assert.deepStrictEqual(plan.questions[0].options, ['Yes', 'No']);
  // The SMS consent is blocked as a consent — the truthful reason — rather
  // than silently answered or mislabelled "Phone".
  assert.deepStrictEqual(plan.blocked.map((b) => b.reason), ['consent']);
});

check('a Yes/No question that merely CONTAINS a field word is not filled from the profile', () => {
  // Found live on a real Ashby form: "Are you legally authorized to work in
  // the LOCATION where this role is based?" scored as the location field on
  // the word-aligned containment tier. That both proposed writing "Boston"
  // into a checkbox and consumed the question, so it was never offered.
  const label = 'Are you legally authorized to work in the location where this role is based?';
  const authorized = ashbyField({
    path: '6cff3ad4-d55b-4de3-a5af-af16ce17c820',
    title: label,
    kind: 'yesno',
    type: 'checkbox',
    name: '6cff3ad4-d55b-4de3-a5af-af16ce17c820',
  });
  // The label really does score as `location` — the fix is the control type,
  // not a new exclusion word.
  assert.strictEqual(matcher.matchStandardField(label).key, 'location');

  const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  authorized.el.ownerDocument = doc;
  const scope = { ownerDocument: doc, querySelectorAll: () => [authorized.el] };
  const plan = matcher.scanForm(scope, { location: 'Boston' }, {}, ashby);

  assert.deepStrictEqual(plan.fills, []);
  assert.strictEqual(plan.questions.length, 1);
  assert.strictEqual(plan.questions[0].inputType, 'boolean');
  assert.deepStrictEqual(plan.questions[0].options, ['Yes', 'No']);
});

check('a file-typed standard field only matches a file input', () => {
  const labelled = (tagName, type) => ({
    tagName,
    type,
    getAttribute: (k) => (k === 'aria-label' ? 'Resume/CV' : k === 'type' ? type : null),
    closest: () => null,
    ownerDocument: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  });
  const asFile = labelled('INPUT', 'file');
  const asTextarea = labelled('TEXTAREA', 'textarea');

  const filePlan = matcher.scanForm({ ownerDocument: asFile.ownerDocument, querySelectorAll: () => [asFile] }, {}, {}, null);
  assert.strictEqual(filePlan.fills.length, 1);
  assert.strictEqual(filePlan.fills[0].field, 'resumeFile');

  // "Paste your resume below" in a textarea is a question, not the upload.
  const textPlan = matcher.scanForm(
    { ownerDocument: asTextarea.ownerDocument, querySelectorAll: () => [asTextarea] },
    {},
    {},
    null
  );
  assert.strictEqual(textPlan.fills.length, 0);
  assert.strictEqual(textPlan.questions.length, 1);
});

check('an adapter hint still outranks the control-type heuristic', () => {
  // A platform naming its own field knows better than a type heuristic:
  // Greenhouse identifies its résumé input by id, Ashby by data-field-path.
  const { el } = ashbyField({ path: '_systemfield_resume', title: 'Resume', type: 'file', id: '_systemfield_resume' });
  const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  el.ownerDocument = doc;
  const plan = matcher.scanForm({ ownerDocument: doc, querySelectorAll: () => [el] }, {}, {}, ashby);
  assert.strictEqual(plan.fills.length, 1);
  assert.strictEqual(plan.fills[0].source, 'resume');
});

// ---------------------------------------------------------------------------
// Live-form regressions: every fixture below is the real attribute shape read
// off a running application form, not an invented one. Sources are named per
// block, because the whole point of these is that the invented version of the
// same markup is what let the bugs through.
// ---------------------------------------------------------------------------

console.log('\nA question is one group, however the platform names its options:');

// jobs.ashbyhq.com/base-power — "How did you hear about Base Power Company?"
// is nine checkboxes in one field entry, each with the OPTION TEXT as its
// name. Keyed on `name` that is nine questions offering one option each.
function ashbyOption(entry, optionText) {
  const el = {
    tagName: 'INPUT',
    type: 'checkbox',
    value: 'on',
    checked: false,
    attrs: { type: 'checkbox', name: optionText },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    get name() {
      return this.attrs.name;
    },
    labels: [{ innerText: optionText, textContent: optionText }],
    closest(sel) {
      if (sel === 'label') return null;
      return sel.includes('field-entry') || sel.includes('data-field-path') ? entry : null;
    },
    click() {
      this.checked = true;
    },
    dispatchEvent() {
      return true;
    },
  };
  entry.options.push(el);
  return el;
}

function ashbyEntry(path, entryId, title) {
  const entry = {
    options: [],
    getAttribute: (k) =>
      k === 'data-field-path' ? path : k === 'data-field-entry-id' ? entryId : null,
    querySelector: (sel) => (sel.includes('question-title') ? { innerText: title, textContent: title } : null),
    querySelectorAll: (sel) => (sel.includes('checkbox') || sel.includes('radio') ? entry.options : []),
  };
  return entry;
}

const HEAR_OPTIONS = [
  'Base Power Company website',
  'LinkedIn',
  'Job Board (e.g., Indeed, Built In, AngelList, Handshake, 12Twenty, etc.)',
  'Base employee or recruiter',
  'Referral (friend, peer, professor, etc.)',
  'Career fair or on-campus event',
  'Social media (e.g., Instagram, Twitter, TikTok)',
  'News article, podcast, or media mention',
  'Other',
];

const hearEntry = ashbyEntry(
  '3f5771ba-4bd2-4e64-8ec1-bfcff9bab549',
  '3bf29234-61fb-4651-80fe-5c6df09d31ba_3f5771ba-4bd2-4e64-8ec1-bfcff9bab549',
  'How did you hear about Base Power Company?'
);
const hearBoxes = HEAR_OPTIONS.map((text) => ashbyOption(hearEntry, text));

check('options that differ by `name` still share one group identity', () => {
  const identities = new Set(hearBoxes.map((el) => matcher.groupIdentity(el, ashby)));
  assert.strictEqual(identities.size, 1, 'nine options must be one question');
  // Without the adapter, `name` is the identity — which is the bug.
  assert.strictEqual(new Set(hearBoxes.map((el) => matcher.groupIdentity(el, null))).size, 9);
});

check('a multi-select question offers every one of its options, not just its own', () => {
  const options = matcher.optionsFor(hearBoxes[0], ashby);
  assert.deepStrictEqual(options, HEAR_OPTIONS);
  // The first option's own `name` lookup would have returned exactly one.
  assert.strictEqual(matcher.controlType(hearBoxes[0], ashby), 'select');
});

check('a multi-select question is planned once, not once per option', () => {
  const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  for (const el of hearBoxes) el.ownerDocument = doc;
  const plan = matcher.scanForm({ ownerDocument: doc, querySelectorAll: () => hearBoxes }, {}, {}, ashby);
  assert.strictEqual(plan.questions.length, 1);
  assert.strictEqual(plan.questions[0].label, 'How did you hear about Base Power Company?');
  assert.strictEqual(plan.questions[0].options.length, 9);
});

check('filling picks the named option, not whichever one the plan was built on', () => {
  assert.strictEqual(filler.setChoiceValue(hearBoxes[0], 'LinkedIn', ashby), true);
  assert.strictEqual(hearBoxes[1].checked, true, 'the LinkedIn box is the one that gets checked');
  assert.strictEqual(hearBoxes[0].checked, false);
});

check('an EEO radio group keyed on a shared name still resolves to one question', () => {
  const eeo = ashbyEntry('_systemfield_eeoc_gender', 'c60d598a__systemfield_eeoc_gender', 'Gender');
  const radios = ['Male', 'Female', 'Decline to self-identify'].map((text) => {
    const el = ashbyOption(eeo, text);
    el.type = 'radio';
    el.attrs.type = 'radio';
    el.attrs.name = 'c60d598a-f2e8-47ca-ba74-82871850f27b__systemfield_eeoc_gender';
    return el;
  });
  assert.strictEqual(new Set(radios.map((el) => matcher.groupIdentity(el, ashby))).size, 1);
  assert.deepStrictEqual(matcher.optionsFor(radios[0], ashby), [
    'Male',
    'Female',
    'Decline to self-identify',
  ]);
  assert.strictEqual(guards.isSelfIdentificationField('Gender', radios[0]), true);
});

console.log('\nDates are verified against what the widget kept:');

// filler.setTextValue reaches for the native value setter (the only way to
// make a React-controlled input notice an assignment) and for KeyboardEvent.
// Neither exists in Node. Declaring them as empty stand-ins is what lets the
// value-writing path run here at all: with no `value` descriptor on the
// prototype, nativeSetter() correctly finds none and falls back to a plain
// assignment against the fixture object.
for (const name of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']) {
  if (typeof global[name] === 'undefined') {
    global[name] = function () {};
    global[name].prototype = {};
  }
}
if (typeof global.KeyboardEvent === 'undefined') {
  global.KeyboardEvent = class extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.key = init.key;
    }
  };
}

// jobs.ashbyhq.com/base-power — "What is your earliest available start date?"
// is react-datepicker: a text input that reformats what it parses. Handing it
// an ISO date lands a day early, silently.
function dateInput({ reformat, placeholder = 'Pick date...' } = {}) {
  return {
    tagName: 'INPUT',
    type: 'text',
    value: '',
    className: 'ashby-application-form-input-date',
    attrs: { type: 'text', placeholder },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    closest: (sel) => (sel.includes('datepicker') ? {} : null),
    focus() {},
    blur() {},
    dispatchEvent() {
      return true;
    },
    set _v(v) {
      this.value = v;
    },
  };
}

check('a react-datepicker text input is recognised as a date control', () => {
  assert.strictEqual(matcher.isDateControl(dateInput()), true);
  assert.strictEqual(matcher.controlType(dateInput(), null), 'date');
  // A plain text input next to nothing datey stays text.
  const plain = {
    tagName: 'INPUT',
    type: 'text',
    className: 'input',
    attrs: {},
    getAttribute: () => null,
    closest: () => null,
  };
  assert.strictEqual(matcher.isDateControl(plain), false);
});

check('a widget that echoes the written date back accepts it', () => {
  const el = dateInput();
  assert.strictEqual(filler.setDateValue(el, '2026-10-01'), true);
  assert.strictEqual(el.value, '10/01/2026', 'written in the widget’s own order, never ISO');
});

check('a widget that shifts the date by a day is a FAILED fill, not a silent one', () => {
  // The real observed behaviour: whatever it is handed, it renders 09/30/2026.
  const el = dateInput();
  Object.defineProperty(el, 'value', {
    get() {
      return this._stored === undefined ? '' : '09/30/2026';
    },
    set(v) {
      this._stored = v;
    },
  });
  assert.strictEqual(filler.setDateValue(el, '2026-10-01'), false);
});

check('a DD/MM placeholder is believed over the US default', () => {
  const el = dateInput({ placeholder: 'DD/MM/YYYY' });
  assert.strictEqual(filler.setDateValue(el, '2026-10-01'), true);
  assert.strictEqual(el.value, '01/10/2026');
});

check('an ambiguous or unparseable answer never reaches a date widget', () => {
  const el = dateInput();
  assert.strictEqual(filler.setDateValue(el, 'next monday'), false);
  assert.strictEqual(el.value, '');
});

console.log('\nA dropdown’s options come from the dropdown, not from the page:');

check('options are read from the widget’s own listbox when it names one', () => {
  const mine = [{ innerText: 'He/Him' }, { innerText: 'She/Her' }, { innerText: 'They/Them' }];
  const listbox = { querySelectorAll: () => mine };
  const el = {
    tagName: 'INPUT',
    type: 'text',
    attrs: { role: 'combobox', 'aria-controls': 'react-select-question_69045535-listbox' },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    ownerDocument: {
      getElementById: (id) => (id === 'react-select-question_69045535-listbox' ? listbox : null),
      // Greenhouse keeps intl-tel-input's 240-country listbox mounted at all
      // times, so a document-wide sweep offers "Afghanistan +93" as a pronoun.
      querySelectorAll: () => mine.concat([{ innerText: 'Afghanistan+93' }]),
    },
  };
  const texts = filler.visibleOptions(el, null).map((o) => o.innerText);
  assert.deepStrictEqual(texts, ['He/Him', 'She/Her', 'They/Them']);
});

check('a widget with no aria-controls only claims options that appeared when it opened', () => {
  const country = { innerText: 'Afghanistan+93' };
  const opened = [{ innerText: 'Yes' }, { innerText: 'No' }];
  let isOpen = false;
  const el = {
    tagName: 'INPUT',
    type: 'text',
    attrs: { role: 'combobox' },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    ownerDocument: { getElementById: () => null, querySelectorAll: () => (isOpen ? [country].concat(opened) : [country]) },
  };
  const known = new Set(filler.visibleOptions(el, null));
  isOpen = true;
  assert.deepStrictEqual(filler.visibleOptions(el, known), opened);
});

console.log('\nA phone field beside its own country selector (Greenhouse, live):');

// Greenhouse renders "Country" (showing the flag and "+1") and "Phone" as two
// controls in one row. Filling the profile's full "+1 4155550100" put the code
// in twice — the form already had +1 selected.
function phoneRow({ withDialCode }) {
  const phone = { tagName: 'INPUT', type: 'tel', getAttribute: () => null };
  const sibling = { tagName: 'INPUT', type: 'text', getAttribute: () => null };
  const row = {
    innerText: withDialCode ? 'Country * +1 Phone *' : 'Phone *',
    querySelectorAll: () => [phone, sibling],
    parentElement: null,
  };
  phone.parentElement = row;
  return phone;
}

check('the country code is dropped when the form has its own country selector', () => {
  assert.strictEqual(matcher.phoneForField('+1 4155550100', phoneRow({ withDialCode: true })), '4155550100');
});

check('a lone phone field still gets the whole number', () => {
  assert.strictEqual(
    matcher.phoneForField('+1 4155550100', phoneRow({ withDialCode: false })),
    '+1 4155550100'
  );
});

check('a non-US code is handled the same way', () => {
  assert.strictEqual(
    matcher.phoneForField('+971 (050) 555-0123', phoneRow({ withDialCode: true })),
    '(050) 555-0123'
  );
});

check('a number too short to survive stripping is left exactly as it was', () => {
  assert.strictEqual(matcher.phoneForField('+1 5551', phoneRow({ withDialCode: true })), '+1 5551');
});

console.log('\nThe phone field\'s own country/dial-code selector gets filled too:');

// Reported live: a required "Country" combobox sat right beside Phone,
// showing a flag and "+1" — but our own labelFor cascade resolved its
// accessible name to "Search" (the widget's internal filter-box hint, not
// "Country"), so it surfaced as an unanswered question with all ~240
// countries listed, rather than being filled.
check('findDialCodeControl returns the sibling control, not just whether one exists', () => {
  const phone = { tagName: 'INPUT', type: 'tel', getAttribute: () => null };
  const country = {
    tagName: 'INPUT',
    type: 'text',
    getAttribute: (name) => (name === 'role' ? 'combobox' : null),
  };
  const row = {
    innerText: 'Country * +1 Phone *',
    querySelectorAll: () => [phone, country],
    parentElement: null,
  };
  phone.parentElement = row;
  country.parentElement = row;
  assert.strictEqual(matcher.findDialCodeControl(phone), country);
});

check('countryForDialCode resolves an unambiguous code outright', () => {
  assert.strictEqual(matcher.countryForDialCode('44', null), 'United Kingdom');
  assert.strictEqual(matcher.countryForDialCode('91', 'Bangalore'), 'India');
});

check('"+1" resolves to United States only when the profile\'s own location corroborates it', () => {
  assert.strictEqual(matcher.countryForDialCode('1', 'San Jose, CA'), 'United States');
  assert.strictEqual(matcher.countryForDialCode('1', 'Washington, DC'), 'United States');
  // NANP is shared by ~25 territories — no state signal means no guess.
  assert.strictEqual(matcher.countryForDialCode('1', null), null);
  assert.strictEqual(matcher.countryForDialCode('1', 'Toronto, ON'), null);
});

check('an unmapped code is left alone rather than guessed', () => {
  assert.strictEqual(matcher.countryForDialCode('999', 'Anywhere'), null);
});

// Full integration, against the REAL Greenhouse adapter. Confirmed against
// the live static markup: Greenhouse's own <label for="country"> genuinely
// reads "Country*" — the "Search" label the user actually saw is a
// hydration-time quirk of that one posting's live DOM, not something a
// generic label rule can be built around. So the real fix is the adapter's
// existing id-based fieldHint (already used for résumé/cover-letter, whose
// two file inputs are BOTH labelled just "Attach") — id="country" is stable
// across both captured postings and needs no label at all.
function phoneAndCountryForm({ location }) {
  const phone = {
    tagName: 'INPUT',
    type: 'tel',
    id: 'phone',
    getAttribute: (name) => (name === 'id' ? 'phone' : null),
    closest: () => null,
  };
  const country = {
    tagName: 'INPUT',
    type: 'text',
    id: 'country',
    // Its fallback label — the actual reported one, when no adapter value
    // can be derived and it falls through to an ordinary question, exactly
    // as it does live today.
    getAttribute: (name) => (name === 'id' ? 'country' : name === 'role' ? 'combobox' : name === 'aria-label' ? 'Search' : null),
    closest: () => null,
  };
  // Shared wrapper so hasSeparateDialCode/phoneForField (unrelated to the
  // adapter-hint fix, but coexisting with it) still strips the dial code
  // from the phone value itself — unaffected by this fix either way.
  const row = { innerText: 'Country * +1 Phone *', querySelectorAll: () => [phone, country], parentElement: null };
  phone.parentElement = row;
  country.parentElement = row;
  const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [phone, country] };
  const profile = { phone: '+1 4155550100', location };
  return {
    plan: matcher.scanForm({ ownerDocument: doc, querySelectorAll: () => [phone, country] }, profile, {}, greenhouse),
    phone,
    country,
  };
}

check('Greenhouse\'s Country selector is planned as a FILL from the adapter hint, not left unanswered', () => {
  const { plan, country } = phoneAndCountryForm({ location: 'San Jose, CA' });
  const countryFill = plan.fills.find((f) => f.el === country);
  assert.ok(countryFill, 'expected a fill for id="country"');
  assert.strictEqual(countryFill.value, 'United States');
  assert.strictEqual(countryFill.field, 'phoneCountryCode');
  assert.ok(!plan.questions.some((q) => q.el === country), 'must not ALSO appear as an unanswered question');
  // The phone number itself still gets planned, unaffected by this.
  assert.strictEqual(plan.fills.find((f) => f.field === 'phone').value, '4155550100');
});

check('with no corroborating location, the same field is left as an ordinary question', () => {
  const { plan, country } = phoneAndCountryForm({ location: null });
  assert.ok(!plan.fills.some((f) => f.el === country), 'must not guess a country from +1 alone');
  assert.ok(plan.questions.some((q) => q.el === country), 'must still be answerable by the user, same as today');
});

console.log('\nLocation options name the same place differently (Greenhouse, live):');

check('"San Jose, CA" matches "San Jose, California, United States"', () => {
  assert.ok(filler.locationOptionMatches('San Jose, California, United States', 'San Jose, CA'));
});

check('it does NOT match San José del Cabo, which the same dropdown offers', () => {
  // The live dropdown for "San Jose, CA" listed this second. A subset-of-words
  // rule accepts it — it contains "san", "jose" and "california".
  assert.ok(!filler.locationOptionMatches('San José del Cabo, Baja California Sur, Mexico', 'San Jose, CA'));
  assert.ok(!filler.locationOptionMatches('San Jose, Camarines Sur, Philippines', 'San Jose, CA'));
});

check('accents are folded, so "San José" and "San Jose" are one city', () => {
  assert.ok(filler.locationOptionMatches('San José, California, United States', 'San Jose, CA'));
});

check('the abbreviation works in either direction', () => {
  assert.ok(filler.locationOptionMatches('Boston, MA, United States', 'Boston, Massachusetts'));
  assert.ok(filler.locationOptionMatches('Boston, Massachusetts, United States', 'Boston, MA'));
});

check('a city-only profile value matches on the city alone', () => {
  assert.ok(filler.locationOptionMatches('London, England, United Kingdom', 'London'));
});

check('the right city in the wrong state is refused', () => {
  assert.ok(!filler.locationOptionMatches('Portland, Oregon, United States', 'Portland, ME'));
});

console.log('\nInside an embedded form, the panel follows the user (Greenhouse on a company domain):');

// The embed host sizes the ATS iframe to its full content height, so the frame
// never scrolls and cannot read its parent's scroll offset. The panel is placed
// from where the user was last SEEN (pointer, wheel or focus), which in a
// non-scrolling frame is a document coordinate directly.
const DOC = 8000;
const PANEL_H = 560;

check('with no sighting of the user yet, nothing moves', () => {
  assert.strictEqual(
    panel.nextFollowTop({ viewportY: null, currentTop: NaN, elementHeight: PANEL_H, docHeight: DOC }),
    null
  );
});

check('the panel centres on the user rather than aligning to them', () => {
  // elementHeight is capped at 400 for the centring offset, so 2400 - 200.
  assert.strictEqual(
    panel.nextFollowTop({ viewportY: 2400, currentTop: NaN, elementHeight: PANEL_H, docHeight: DOC }),
    2200
  );
});

check('a small movement is ignored, so the panel settles instead of chasing', () => {
  assert.strictEqual(
    panel.nextFollowTop({ viewportY: 2450, currentTop: 2200, elementHeight: PANEL_H, docHeight: DOC }),
    null
  );
});

check('a real scroll away DOES move it', () => {
  assert.strictEqual(
    panel.nextFollowTop({ viewportY: 4200, currentTop: 2200, elementHeight: PANEL_H, docHeight: DOC }),
    4000
  );
});

check('it never rides above the top of the form', () => {
  assert.strictEqual(
    panel.nextFollowTop({ viewportY: 10, currentTop: 4000, elementHeight: PANEL_H, docHeight: DOC }),
    8
  );
});

check('it never hangs off the bottom of the form', () => {
  // 8000 - 560 - 8
  assert.strictEqual(
    panel.nextFollowTop({ viewportY: 7990, currentTop: 100, elementHeight: PANEL_H, docHeight: DOC }),
    7432
  );
});

check('a pointer at the very top of the document is a real sighting, not a missing one', () => {
  // clientY of 0 is falsy; treating it as "unknown" would freeze the panel
  // exactly when the user scrolled to the top of the form.
  assert.strictEqual(
    panel.nextFollowTop({ viewportY: 0, currentTop: 4000, elementHeight: PANEL_H, docHeight: DOC }),
    8
  );
});

check('an unpositioned element always places, however small the move', () => {
  assert.strictEqual(
    panel.nextFollowTop({ viewportY: 300, currentTop: NaN, elementHeight: 40, docHeight: DOC }),
    280
  );
});

console.log('\nWorkable (§15 #31) — posting ids, labels, radio wrappers:');

const workable = require('../../adapters/workable');
const workday = require('../../adapters/workday');
const { autofillFilename, extensionOf } = require('../../../../server/src/routes/autofill');

const WORKABLE_POSTING_IDS = [
  // jobs.link as the board API stores it
  ['https://apply.workable.com/j/1FDD960433', '1FDD960433'],
  // the form the permalink redirects to
  ['https://apply.workable.com/saalex/j/1FDD960433/apply', '1FDD960433'],
  ['https://apply.workable.com/1000heads/j/e4335d00d8/', 'E4335D00D8'],
  ['https://apply.workable.com/saalex/', null],
  ['https://apply.workable.com/j/short', null],
  ['https://jobs.lever.co/ro/f25a6c49-5ed4-4aa0-a5bb-b30e9790f90c/apply', null],
];
for (const [postingUrl, expected] of WORKABLE_POSTING_IDS) {
  check(`workable posting id: ${postingUrl} -> ${expected}`, () => {
    assert.strictEqual(workable.extractPostingId(postingUrl), expected);
  });
}
check('server and Workable adapter agree on every posting id', () => {
  for (const [postingUrl, expected] of WORKABLE_POSTING_IDS) {
    if (expected === null) continue;
    assert.strictEqual(serverExtractPostingId(postingUrl), expected, `server mismatch on: ${postingUrl}`);
  }
});

// A minimal element graph for Workable's markup: nodes by id, a data-ui field
// ancestor, and the radio fieldset → role=radio wrapper → hidden input shape.
function workableDoc() {
  const byId = {};
  const doc = { getElementById: (id) => byId[id] || null };
  const textNode = (id, text, withSvg) => {
    const node = {
      id,
      textContent: withSvg ? `SVGs not supported by this browser.${text}` : text,
      cloneNode() {
        const svgs = withSvg ? [{ remove: () => { copy.textContent = text; } }] : [];
        const copy = { textContent: node.textContent, querySelectorAll: () => svgs };
        return copy;
      },
    };
    byId[id] = node;
    return node;
  };
  const field = (key) => {
    const node = { getAttribute: (k) => (k === 'data-ui' ? key : null), parentElement: null };
    return node;
  };
  const input = ({ key, type = 'text', labelledby = null, id = null }) => {
    const wrapper = field(key);
    const attrs = { type, 'aria-labelledby': labelledby, id };
    return {
      tagName: type === 'textarea' ? 'TEXTAREA' : 'INPUT',
      type,
      id,
      ownerDocument: doc,
      getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
      closest: (sel) => (sel === '[data-ui]' ? wrapper : null),
    };
  };
  const radioGroup = (key, labelId, options) => {
    const fieldset = {
      getAttribute: (k) => (k === 'data-ui' ? key : k === 'aria-labelledby' ? labelId : k === 'role' ? 'radiogroup' : null),
      querySelectorAll: () => inputs,
    };
    const inputs = options.map((text, i) => {
      const id = `${key}_opt${i}`;
      textNode(`radio_label_${id}`, text, false);
      const wrapper = { clicked: 0, click() { this.clicked += 1; }, textContent: text, getAttribute: () => null, closest: () => null };
      const attrs = { type: 'radio', 'aria-hidden': 'true', tabindex: '-1', id, name: key };
      return {
        tagName: 'INPUT',
        type: 'radio',
        id,
        name: key,
        value: String(300000 + i),
        labels: [],
        ownerDocument: doc,
        wrapper,
        getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
        closest: (sel) => {
          if (sel.includes('radiogroup')) return fieldset;
          if (sel.includes('[role="radio"]')) return wrapper;
          if (sel === '[data-ui]') return fieldset;
          return null;
        },
      };
    });
    return inputs;
  };
  return { doc, textNode, input, radioGroup };
}

check('the résumé upload is hinted by its data-ui key, not its SVG-polluted label', () => {
  const w = workableDoc();
  w.textNode('lbl_resume', 'Resume', true);
  const el = w.input({ key: 'resume', type: 'file', labelledby: 'lbl_resume desc_resume' });
  assert.strictEqual(workable.fieldHint(el), 'resumeFile');
  assert.strictEqual(workable.labelFor(el), 'Resume');
});

check('standard Workable keys map to profile fields', () => {
  const w = workableDoc();
  assert.strictEqual(workable.fieldHint(w.input({ key: 'firstname' })), 'firstName');
  assert.strictEqual(workable.fieldHint(w.input({ key: 'lastname' })), 'lastName');
  assert.strictEqual(workable.fieldHint(w.input({ key: 'email', type: 'email' })), 'email');
  assert.strictEqual(workable.fieldHint(w.input({ key: 'CA_4446' })), null);
});

check('a pasted cover-letter textarea is skipped, an upload is attached', () => {
  const w = workableDoc();
  assert.strictEqual(workable.fieldHint(w.input({ key: 'cover_letter', type: 'textarea' })), 'skip');
  assert.strictEqual(workable.fieldHint(w.input({ key: 'cover_letter', type: 'file' })), 'coverLetterFile');
});

check('a radio takes its group question, and offers the wrappers the user clicks', () => {
  const w = workableDoc();
  w.textNode('q_label', 'Are you legally eligible to be employed in the United States?', true);
  const [yes, no] = w.radioGroup('CA_31132', 'q_label', ['Yes', 'No']);
  assert.strictEqual(workable.labelFor(yes), 'Are you legally eligible to be employed in the United States?');
  assert.strictEqual(workable.isRealControl(yes), true);
  assert.strictEqual(workable.groupIdentity(no), 'CA_31132');
  const options = workable.choiceOptions(yes);
  assert.deepStrictEqual(options.map((o) => o.text), ['Yes', 'No']);
  assert.strictEqual(filler.setChoiceValue(yes, 'No', workable), true);
  assert.strictEqual(no.wrapper.clicked, 1);
  assert.strictEqual(yes.wrapper.clicked, 0);
});

check('a hidden radio is waived as presentational only because the adapter vouches', () => {
  const w = workableDoc();
  w.textNode('q2', 'Have you ever worked for this Company before?', false);
  const [yes] = w.radioGroup('CA_31134', 'q2', ['Yes', 'No']);
  assert.strictEqual(guards.blockReason('Have you ever worked for this Company before?', yes), 'presentational');
  assert.strictEqual(guards.blockReason('Have you ever worked for this Company before?', yes, { vouchedReal: true }), null);
});

check('the non-compete affirmation is blocked as a consent even when vouched', () => {
  const w = workableDoc();
  const label = 'Affirmation: I affirm that I have not entered into any non-competition agreement';
  w.textNode('aff', label, false);
  const [yes] = w.radioGroup('CA_31319', 'aff', ['Yes', 'No']);
  assert.strictEqual(guards.blockReason(workable.labelFor(yes), yes, { vouchedReal: true }), 'consent');
});

check('a text input with a MM/DD/YYYY placeholder is a date control', () => {
  const dateInput = { tagName: 'INPUT', type: 'text', className: 'styles--2e9Cp', getAttribute: (k) => (k === 'placeholder' ? 'MM/DD/YYYY' : k === 'type' ? 'text' : null), closest: () => null };
  assert.strictEqual(matcher.isDateControl(dateInput), true);
  const plain = { tagName: 'INPUT', type: 'text', className: '', getAttribute: (k) => (k === 'placeholder' ? 'Your answer' : null), closest: () => null };
  assert.strictEqual(matcher.isDateControl(plain), false);
});

check('a read-only combobox is a select-only dropdown, not a locked field', () => {
  // Workable's State / disability / veteran dropdowns are readonly
  // role=combobox inputs; blocking them dropped the questions silently.
  const combo = { tagName: 'INPUT', type: 'text', readOnly: true, getAttribute: (k) => (k === 'role' ? 'combobox' : null), closest: () => null };
  assert.strictEqual(guards.blockReason('State', combo), null);
  const locked = { tagName: 'INPUT', type: 'text', readOnly: true, getAttribute: () => null, closest: () => null };
  assert.strictEqual(guards.blockReason('Employee ID', locked), 'readonly');
});

check('a follow-up question or a two-part label is not a standard field by containment', () => {
  assert.strictEqual(matcher.matchStandardField('If Yes, please provide details (Where/When/Job Title):'), null);
  assert.strictEqual(matcher.matchStandardField('Highschool Name & Location:'), null);
  assert.strictEqual(matcher.matchStandardField('Supervisor Name & Title:'), null);
  // ...while an exact label, and ordinary containment, still match.
  assert.strictEqual(matcher.matchStandardField('City').key, 'location');
  assert.strictEqual(matcher.matchStandardField('LinkedIn Profile').key, 'linkedin');
});

check('an upload nothing claims is left for the user, never asked as text', () => {
  const upload = {
    tagName: 'INPUT', type: 'file', id: 'cert', name: 'cert', ownerDocument: { getElementById: () => null, querySelector: () => null },
    getAttribute: (k) => (k === 'type' ? 'file' : k === 'aria-label' ? 'Please upload any relevant certifications:' : null),
    closest: () => null,
  };
  const scope = { querySelectorAll: () => [upload], ownerDocument: upload.ownerDocument };
  const plan = matcher.scanForm(scope, {}, {}, null);
  assert.strictEqual(plan.questions.length, 0);
  assert.deepStrictEqual(plan.blocked.map((b) => b.reason), ['out_of_scope']);
});

check('Workable’s street Address is asked, not filled with the profile’s city', () => {
  const w = workableDoc();
  const address = w.input({ key: 'address' });
  assert.strictEqual(workable.fieldHint(address), 'streetAddress');
  assert.strictEqual(matcher.profileValue({ location: 'San Jose, CA' }, 'streetAddress'), null);
});

console.log('\nWorkday (§15 #32) — posting ids, labels, listbox buttons:');

const WORKDAY_POSTING_IDS = [
  ['https://dealertire.wd5.myworkdayjobs.com/DealerTireLLC-Careers/job/Cleveland-OH/Business-Analyst--Salesforce-_R14177-1', 'R14177-1'],
  ['https://autonation.wd5.myworkdayjobs.com/Careers/job/AutoNation-Headquarters/Analyst--Risk-Management_JR2026140895', 'JR2026140895'],
  ['https://entegris.wd1.myworkdayjobs.com/EntegrisCareers/job/Bedford-MA/IT-Program-Management-Co-Op_REQ-14463', 'REQ-14463'],
  ['https://rbc.wd3.myworkdayjobs.com/RBCEARLYTALENT1/job/BROOKFIELD-PLACE-NEW-YORK/XMLNAME-2027-Capital-Markets--Winter-Analyst_R-0000186586', 'R-0000186586'],
  // the application itself: locale prefix plus /apply/applyManually
  ['https://23andme.wd5.myworkdayjobs.com/en-US/23/job/Palo-Alto-HQ/Senior-Accountant_2026049/apply/applyManually', '2026049'],
  // a numeric location segment must not be read as a Greenhouse id
  ['https://acme.wd1.myworkdayjobs.com/Careers/job/2000-Main-St/Analyst_R5521', 'R5521'],
  ['https://acme.wd1.myworkdayjobs.com/Careers', null],
];
for (const [postingUrl, expected] of WORKDAY_POSTING_IDS) {
  check(`workday posting id: ${postingUrl.slice(8, 70)} -> ${expected}`, () => {
    assert.strictEqual(workday.extractPostingId(postingUrl), expected);
  });
}
check('server and Workday adapter agree on every posting id, including the numeric location', () => {
  for (const [postingUrl, expected] of WORKDAY_POSTING_IDS) {
    assert.strictEqual(serverExtractPostingId(postingUrl), expected, `server mismatch on: ${postingUrl}`);
  }
});

check('a req id that prefixes another is told apart by re-parsing the stored link', () => {
  const stored = 'https://dealertire.wd5.myworkdayjobs.com/DealerTireLLC-Careers/job/Cleveland-OH/Analyst_R14177-10';
  assert.notStrictEqual(serverExtractPostingId(stored), 'R14177-1');
});

function workdayField(key, { tag = 'INPUT', type = 'text', auto = null, ownLabel = null } = {}) {
  const label = {
    textContent: 'How Did You Hear About Us?*',
    cloneNode() {
      return { textContent: 'How Did You Hear About Us?', querySelectorAll: () => [] };
    },
  };
  const wrapper = {
    getAttribute: (k) => (k === 'data-automation-id' ? `formField-${key}` : null),
    // Only what real markup would return: the field's label, and a dropdown
    // button only in a field that is a dropdown.
    querySelector: (sel) => (sel.includes('label') ? label : sel.includes('aria-haspopup') && tag === 'BUTTON' ? {} : null),
  };
  const attrs = { type, 'data-automation-id': auto, 'aria-haspopup': tag === 'BUTTON' ? 'listbox' : null };
  return {
    tagName: tag,
    type,
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    closest: (sel) => (sel.startsWith('[data-automation-id^="formField-"]') ? wrapper : sel === 'label' ? ownLabel : null),
    label,
  };
}

check('Workday field keys map to profile fields, and pre-set country fields are left alone', () => {
  assert.strictEqual(workday.fieldHint(workdayField('legalName--firstName')), 'firstName');
  assert.strictEqual(workday.fieldHint(workdayField('legalName--lastName')), 'lastName');
  assert.strictEqual(workday.fieldHint(workdayField('emailAddress')), 'email');
  assert.strictEqual(workday.fieldHint(workdayField('phoneNumber')), 'phone');
  assert.strictEqual(workday.fieldHint(workdayField('countryPhoneCode')), 'skip');
  assert.strictEqual(workday.fieldHint(workdayField('country', { tag: 'BUTTON' })), 'skip');
  assert.strictEqual(workday.fieldHint(workdayField('source', { tag: 'BUTTON' })), null);
});

check('the SMS opt-in beside the phone is out of scope', () => {
  assert.strictEqual(workday.fieldHint(workdayField('phoneNumber', { type: 'checkbox', auto: 'phone-sms-opt-in' })), 'skip');
});

check('a Workday dropdown takes the field label, not its "Select One Required" aria-label', () => {
  assert.strictEqual(workday.labelFor(workdayField('source', { tag: 'BUTTON' })), 'How Did You Hear About Us?');
});

check('a listbox button is planned as a combobox question', () => {
  const button = workdayField('phoneType', { tag: 'BUTTON' });
  assert.strictEqual(filler.isListboxButton(button), true);
  assert.strictEqual(matcher.controlType(button, workday), 'combobox');
});

check('extraControls hands the scan only dropdown buttons that sit inside a form field', () => {
  const inField = workdayField('source', { tag: 'BUTTON' });
  const loose = { tagName: 'BUTTON', getAttribute: () => 'listbox', closest: () => null };
  const scope = { querySelectorAll: () => [inField, loose] };
  assert.deepStrictEqual(workday.extraControls(scope), [inField]);
});

check('"Select One" is a placeholder, never an answer', () => {
  assert.strictEqual(filler.isPlaceholderOption('Select One'), true);
  assert.strictEqual(filler.isPlaceholderOption('Mobile'), false);
  assert.strictEqual(filler.isPlaceholderOption('Selected by recruiter'), false);
});

check('the hidden text mirror beside a Workday dropdown is not a second question', () => {
  const button = { tagName: 'BUTTON' };
  const wrapper = {
    getAttribute: (k) => (k === 'data-automation-id' ? 'formField-source' : null),
    querySelector: (sel) => (sel.includes('aria-haspopup') ? button : null),
  };
  const mirror = { tagName: 'INPUT', type: 'text', getAttribute: (k) => (k === 'type' ? 'text' : null), closest: () => wrapper };
  assert.strictEqual(workday.fieldHint(mirror), 'skip');
});

check('Workday City takes the city alone, derived from the stored location', () => {
  assert.strictEqual(workday.fieldHint(workdayField('city')), 'city');
  assert.strictEqual(matcher.profileValue({ location: 'San Jose, CA' }, 'city'), 'San Jose');
  assert.strictEqual(matcher.profileValue({ location: '' }, 'city'), null);
});

check('a field labelled exactly "City" is given the city, not "City, ST"', () => {
  const city = {
    tagName: 'INPUT', type: 'text', id: 'CA_49610', name: 'CA_49610',
    ownerDocument: { getElementById: () => null, querySelector: () => null },
    getAttribute: (k) => (k === 'type' ? 'text' : k === 'aria-label' ? 'City' : null),
    closest: () => null,
  };
  const scope = { querySelectorAll: () => [city], ownerDocument: city.ownerDocument };
  const plan = matcher.scanForm(scope, { location: 'San Jose, CA' }, {}, null);
  assert.strictEqual(plan.fills.length, 1);
  assert.strictEqual(plan.fills[0].value, 'San Jose');
  // "Current location" still takes the whole thing.
  city.getAttribute = (k) => (k === 'type' ? 'text' : k === 'aria-label' ? 'Current Location' : null);
  assert.strictEqual(matcher.scanForm(scope, { location: 'San Jose, CA' }, {}, null).fills[0].value, 'San Jose, CA');
  // So does a question that merely contains "city" (Greenhouse, Box).
  city.getAttribute = (k) =>
    k === 'type' ? 'text' : k === 'aria-label' ? 'In what City, State and Zip are you currently residing?' : null;
  assert.strictEqual(matcher.scanForm(scope, { location: 'San Jose, CA' }, {}, null).fills[0].value, 'San Jose, CA');
});

check('Workday’s Skills prompt is left for the user, not banked as typed text', () => {
  assert.strictEqual(workday.fieldHint(workdayField('skills')), 'skip');
});

check('an upload the page consumes and clears is still a successful fill', () => {
  global.DataTransfer = class {
    constructor() { this.list = []; this.items = { add: (f) => this.list.push(f) }; }
    get files() { return this.list; }
  };
  global.Event = global.Event || class { constructor(type) { this.type = type; } };
  const input = {
    files: [],
    // Workday's handler takes the file and empties the input on change.
    dispatchEvent(e) { if (e.type === 'change') this.files = []; return true; },
  };
  assert.strictEqual(filler.setFileValue(input, { name: 'Jane_Doe_Resume.docx' }), true);
  assert.strictEqual(input.files.length, 0);
  assert.strictEqual(filler.setFileValue(input, null), false);
});

check('a Workday question with no <label> is read from its legend’s rich text', () => {
  const rich = {
    textContent: 'Do you now, or would you in the future, require sponsorship for work authorization?*',
    cloneNode() {
      return { textContent: 'Do you now, or would you in the future, require sponsorship for work authorization?', querySelectorAll: () => [] };
    },
  };
  const wrapper = {
    getAttribute: (k) => (k === 'data-automation-id' ? 'formField-0a559e442ec8100162702fb32e8d0000' : null),
    querySelector: (sel) => (sel === 'legend label, label' ? null : sel.includes('richText') ? rich : null),
  };
  const button = { tagName: 'BUTTON', getAttribute: () => null, closest: (sel) => (sel.includes('formField-') ? wrapper : null) };
  assert.strictEqual(
    workday.labelFor(button),
    'Do you now, or would you in the future, require sponsorship for work authorization?'
  );
});

check('a label that is only a widget placeholder is never offered as a question', () => {
  const doc = { getElementById: () => null, querySelector: () => null };
  const control = (aria) => ({
    tagName: 'INPUT', type: 'text', ownerDocument: doc,
    getAttribute: (k) => (k === 'type' ? 'text' : k === 'aria-label' ? aria : null),
    closest: () => null,
  });
  for (const aria of [' Select One Required', 'Select One', 'Search', 'Select an option…']) {
    const plan = matcher.scanForm({ querySelectorAll: () => [control(aria)], ownerDocument: doc }, {}, {}, null);
    assert.strictEqual(plan.questions.length, 0, `asked: "${aria}"`);
    assert.deepStrictEqual(plan.blocked.map((b) => b.reason), ['unlabelled'], `not blocked: "${aria}"`);
  }
  // A real question that merely starts with "Select" is still asked.
  const real = matcher.scanForm({ querySelectorAll: () => [control('Select your preferred office')], ownerDocument: doc }, {}, {}, null);
  assert.strictEqual(real.questions.length, 1);
});

check('the active progress step is the step key', () => {
  const doc = { querySelector: () => ({ innerText: 'current step 2 of 5\nMy Experience' }) };
  assert.strictEqual(workday.stepKey(doc), 'current step 2 of 5 My Experience');
});

console.log('\nAttached file names (FirstName_LastName_Resume / _Cover_Letter):');

check('a two-part name', () => {
  assert.strictEqual(autofillFilename('Jane Doe', 'resume', 'docx'), 'Jane_Doe_Resume.docx');
  assert.strictEqual(autofillFilename('Jane Doe', 'cover_letter', 'docx'), 'Jane_Doe_Cover_Letter.docx');
});

check('a middle name is dropped, accents folded, punctuation removed', () => {
  assert.strictEqual(autofillFilename('José María de la Cruz', 'resume', 'pdf'), 'Jose_Cruz_Resume.pdf');
  assert.strictEqual(autofillFilename("  Mary-Jane O'Neil ", 'resume', '.DOCX'), 'Mary-Jane_ONeil_Resume.docx');
});

check('one name, or none at all, still yields a usable file name', () => {
  assert.strictEqual(autofillFilename('Cher', 'resume', 'docx'), 'Cher_Resume.docx');
  assert.strictEqual(autofillFilename('', 'cover_letter', null), 'Cover_Letter.docx');
});

check('the extension comes from the stored file, not a guess', () => {
  assert.strictEqual(extensionOf('user/generated/abc.docx'), 'docx');
  assert.strictEqual(extensionOf('My Resume.pdf'), 'pdf');
  assert.strictEqual(extensionOf('noext'), null);
});



console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('\nSome checks FAILED.');
} else {
  console.log('All checks passed.');
}
