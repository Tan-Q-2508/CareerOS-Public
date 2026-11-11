// guards.js — the hard blocks. Spec §14 non-goals, implemented as code rather
// than as a convention, because both of these are things the extension must
// NEVER do regardless of what a matcher or an adapter decides:
//
//   1. No INFERRED self-identification data, ever. Race, ethnicity, gender,
//      pronouns, veteran and disability status are never guessed, never
//      AI-drafted, and never filled from the profile or the résumé. They are
//      offered in the review panel as ordinary one-time questions the user
//      answers from the form's OWN options, and only an answer the user
//      picked themselves is ever reused on a later form — the same discipline
//      as every other saved answer. Anything the extension would have to
//      infer stays impossible by construction.
//   1b. A hard-blocked subset remains: SSN and date of birth. Those are not
//      voluntary diversity questions, CareerOS holds neither, and replaying a
//      stored one is a different risk class than re-picking "Decline to
//      self-identify" from a dropdown.
//   2. No submission of any kind. The extension never clicks a submit/apply
//      control and never calls form.submit(). The user always presses the
//      platform's own button themselves.
//   3. No legal affirmations. "I affirm the information provided is true",
//      "I agree to the terms" — a real Greenhouse form (Vestmark, verified
//      live) asks exactly this. Checking it on the user's behalf is the user
//      making a legal representation they never read, so it's blocked in the
//      same breath as EEO rather than treated as an ordinary question.
//
// Every check runs on the NORMALIZED label (normalizeQuestion), and all are
// deliberately over-broad: a false positive means one field the user types
// themselves, a false negative means the extension did something the spec
// forbids. That asymmetry decides every judgment call in this file.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./normalizeQuestion').normalizeQuestion);
  } else {
    root.CareerOSAutofillGuards = factory(root.CareerOSAutofillNormalize.normalizeQuestion);
  }
})(typeof self !== 'undefined' ? self : this, function (normalizeQuestion) {
  // Matched as whole words/phrases against the normalized label (see
  // containsPhrase below — substring matching was wrong here).
  // Voluntary self-identification: offered as a one-time question, filled only
  // from what the user picked themselves (see the header).
  const SELF_ID_TERMS = [
    'race', 'races', 'ethnicity', 'ethnicities', 'ethnic', 'hispanic', 'latino',
    'gender', 'genders', 'sex', 'male or female', 'pronoun', 'pronouns', 'transgender',
    'sexual orientation', 'lgbtq',
    'veteran', 'veterans', 'protected veteran', 'military',
    'disability', 'disabilities', 'disabled', 'impairment', 'accommodation', 'accommodations',
    'self identification', 'self identify', 'voluntary self',
    'eeo', 'eeoc', 'equal employment', 'equal opportunity',
    'affirmative action',
    'marital status', 'religion', 'religious',
    'national origin', 'citizenship status',
  ];

  // Never filled, never stored, not offered — no matter who asks. These are
  // not diversity questions: CareerOS holds neither value, and an SSN sitting
  // in a reusable answer bank is a different thing entirely from a stored
  // "Decline to self-identify".
  const SENSITIVE_TERMS = [
    'date of birth', 'birth date', 'age',
    'social security', 'ssn',
  ];

  // Kept as the union for callers that only care "is this a protected
  // characteristic at all".
  const EEO_TERMS = SELF_ID_TERMS.concat(SENSITIVE_TERMS);

  // Matched against a control's normalized accessible name/value.
  const SUBMIT_TERMS = [
    'submit', 'submit application', 'apply', 'apply now', 'send application',
    'finish', 'complete application',
  ];

  // Affirmations/consents the user must make themselves (see #3 above).
  const CONSENT_TERMS = [
    'i affirm', 'affirm that', 'i certify', 'certify that', 'i agree', 'i acknowledge',
    'i consent', 'consent to', 'terms and conditions', 'privacy policy', 'i understand that',
  ];

  // Substring matching would be wrong here: 'age' is an EEO term and also
  // sits inside "manage", "acknowledge" and "page" — which made a live
  // Greenhouse affirmation checkbox look like an age question. Phrases are
  // matched on word boundaries instead, so 'age' only ever means the word.
  function containsPhrase(normalized, phrase) {
    if (!normalized || !phrase) return false;
    // normalizeQuestion has already reduced both sides to lowercase words
    // separated by single spaces, so a padded-substring check IS the word
    // boundary check — no regex escaping needed for text that may contain
    // regex metacharacters.
    return ` ${normalized} `.includes(` ${phrase} `);
  }

  function isEeoField(label) {
    const n = normalizeQuestion(label);
    if (!n) return false;
    return EEO_TERMS.some((t) => containsPhrase(n, t));
  }

  function isSensitiveField(label) {
    const n = normalizeQuestion(label);
    if (!n) return false;
    return SENSITIVE_TERMS.some((t) => containsPhrase(n, t));
  }

  // "This is a self-identification question" — the signal the matcher acts on.
  // It does NOT block the field; it changes what may be put in it: never the
  // profile, never an AI draft, only an answer this user picked before.
  function isSelfIdentificationField(label, el) {
    if (isSensitiveField(label)) return false; // hard-blocked instead
    const n = normalizeQuestion(label);
    if (n && SELF_ID_TERMS.some((t) => containsPhrase(n, t))) return true;
    return isEeoFieldName(el);
  }

  function isConsentField(label) {
    const n = normalizeQuestion(label);
    if (!n) return false;
    return CONSENT_TERMS.some((t) => containsPhrase(n, t));
  }

  // Controls the page has deliberately hidden from assistive tech. React-select
  // renders a required-shim input per dropdown (aria-hidden, tabindex="-1") —
  // it carries the visible field's label, so without this it shows up as a
  // duplicate row for every dropdown on the form (confirmed live).
  function isPresentationalControl(el) {
    if (!el || !el.getAttribute) return false;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.getAttribute('tabindex') === '-1') {
      // ...except a file input, which is the one control type routinely taken
      // out of the tab order ON PURPOSE while still being the real thing:
      // nearly every ATS hides the native <input type="file"> behind a styled
      // label, and Lever's résumé upload does exactly that
      // (id="resume-upload-input", class="invisible-resume-upload",
      // tabindex="-1" — verified live). Blocking it means never attaching a
      // résumé on Lever. `aria-hidden` still blocks everything, which is what
      // the react-select required-shim case this guard was written for
      // actually carries.
      const type = String((el.getAttribute('type') || el.type || '')).toLowerCase();
      if (type !== 'file') return true;
    }
    return false;
  }

  // Some platforms only identify a field as EEO/consent in its `name`, never
  // in text the user can see: Lever renders pronouns as a checkbox list where
  // each option's own label reads "He/him", and its marketing consent box's
  // label text varies per board. Matching the submitted field name is the one
  // signal that holds in those cases — and it is checked in ADDITION to the
  // label, never instead of it.
  const EEO_NAME_RE = /^(pronouns?|gender|race|ethnicity|veteran|disability|demographics?)([^a-z0-9]|$)|^(eeo|demographic|selfidentification|self_identification)[[._]/i;
  const CONSENT_NAME_RE = /^consent[[._]|^(privacyconsent|privacy_consent|marketingconsent|marketing_consent)$/i;

  function fieldNameOf(el) {
    if (!el || !el.getAttribute) return '';
    return String(el.getAttribute('name') || el.name || '');
  }

  function isEeoFieldName(el) {
    const name = fieldNameOf(el);
    return Boolean(name) && EEO_NAME_RE.test(name);
  }

  function isConsentFieldName(el) {
    const name = fieldNameOf(el);
    return Boolean(name) && CONSENT_NAME_RE.test(name);
  }

  // True for anything that could send the application. Checked before any
  // click the extension would ever perform — today it performs none, and this
  // exists so a future adapter (e.g. Workday's multi-step "Next" buttons in
  // session 32) can't accidentally grow into one.
  function isSubmitControl(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    const typeAttr = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    // A <button> element reports `.type === 'submit'` by IDL even when the
    // page never wrote a type attribute, so for a button the ATTRIBUTE is the
    // only thing that says the page actually asked for a submit control.
    // (Found live: reading the property here made every one of Ashby's Yes/No
    // answer buttons look like a submit button.)
    const declared = typeAttr || (tag === 'button' ? '' : String(el.type || '').toLowerCase());
    if (declared === 'submit' || declared === 'image') return true;
    // An untyped <button> DOES default to submit — but only inside a form,
    // which is the whole of that rule. Ashby renders its Yes/No answer options
    // as untyped <button>s on a page with no <form> element at all, so without
    // the form check every one of its screening answers is unclickable. The
    // text check below is untouched, and is what still catches Ashby's own
    // "Submit Application" button.
    if (tag === 'button' && !typeAttr && el.closest && el.closest('form')) return true;
    const text = normalizeQuestion(
      (el.innerText || el.value || el.getAttribute?.('aria-label') || '')
    );
    return SUBMIT_TERMS.some((t) => text === t || text.startsWith(t + ' '));
  }

  // The one place any code in this extension is allowed to decide a field may
  // be written to. Returns a reason string when blocked, null when allowed.
  //
  // `vouchedReal` is an adapter's verdict that a control the presentational
  // HEURISTIC would drop is in fact the real thing (matcher/filler pass
  // `adapter.isRealControl(el)`). It waives 'presentational' and nothing else:
  // Ashby's Yes/No answer sits on a hidden `tabindex="-1"` checkbox that is a
  // genuine control, but no adapter may ever wave away a consent, a sensitive
  // field, a submit control, or a disabled/readonly/password/hidden input.
  // Which reasons are waivable is decided HERE, not by the adapter.
  function blockReason(label, el, { vouchedReal = false } = {}) {
    // NOT self-identification: that is classified (isSelfIdentificationField)
    // and handled by the matcher, which allows only the user's own previously
    // given answer into such a field. Only the sensitive subset is blocked
    // outright here.
    if (isSensitiveField(label)) return 'sensitive';
    if (isConsentField(label) || isConsentFieldName(el)) return 'consent';
    if (!vouchedReal && isPresentationalControl(el)) return 'presentational';
    if (isSubmitControl(el)) return 'submit';
    if (el && el.disabled) return 'disabled';
    // A read-only COMBOBOX is not a locked field: it is a select-only dropdown,
    // read-only precisely so the user can pick but not type. Workable renders
    // every account dropdown this way (State, disability, veteran status —
    // verified live), and blocking them removed those questions from the plan
    // without a trace. Answering it means clicking one of its own options,
    // which the filler does without typing into the input.
    if (el && el.readOnly && !(el.getAttribute && el.getAttribute('role') === 'combobox')) return 'readonly';
    if (el && (el.type === 'password')) return 'password';
    if (el && (el.type === 'hidden')) return 'hidden';
    return null;
  }

  return {
    isEeoField,
    isSensitiveField,
    isSelfIdentificationField,
    isConsentField,
    isEeoFieldName,
    isConsentFieldName,
    isPresentationalControl,
    isSubmitControl,
    blockReason,
    containsPhrase,
    EEO_TERMS,
    SELF_ID_TERMS,
    SENSITIVE_TERMS,
    SUBMIT_TERMS,
    CONSENT_TERMS,
  };
});
