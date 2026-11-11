// ashby.js — the Ashby-specific field adapter (spec §15 session 30).
//
// Same contract as greenhouse.js and lever.js: an adapter supplies DOM SHAPE
// only. All field semantics live in core/fieldMap.js and all matching in
// core/matcher.js.
//
// Ashby's application form lives at
//   jobs.ashbyhq.com/<slug>/<posting-uuid>/application
// with the posting itself at the same path without the /application suffix.
// The posting id is a UUID, and the board API's `jobUrl` — which is what lands
// in `jobs.link` — is exactly `https://jobs.ashbyhq.com/<slug>/<uuid>`, so the
// server's own extractPostingId (routes/autofill.js) already matches it via
// the same UUID branch Lever uses. Kept in agreement by test.
//
// Five DOM facts drove everything below. All five were read off real
// application pages (Linear, Ramp, OpenAI, Vanta, Ashby, Notion — 2026-08-20),
// and three of them are why this session touched core at all:
//
//   1. THERE IS NO <form> ELEMENT. The whole form is a React-rendered
//      <div class="ashby-application-form-container">. findForm() below
//      returns that div; the matcher only ever calls querySelectorAll on it,
//      so a container works exactly as well as a form. The plain posting page
//      renders ZERO controls until the user clicks Apply, at which point the
//      SPA pushState's to /application — already handled by contentScript's
//      history wrapper.
//   2. Every field sits in
//        <div class="ashby-application-form-field-entry" data-field-path="...">
//          <label class="ashby-application-form-question-title" for="...">Q</label>
//          <input ...>
//      and `data-field-path` — NOT id, which the location combobox and the
//      yes/no checkbox both lack — is Ashby's stable identifier. It is
//      `_systemfield_name`/`_email`/`_resume`/`_location` for standard fields
//      and a UUID for custom questions.
//   3. A Yes/No question is two <button data-option="yes|no"> plus a hidden
//        <input type="checkbox" tabindex="-1" name="<uuid>">
//      with no id and no label of its own. The buttons carry the answer:
//      clicking one sets both aria-pressed and the checkbox. Clicking the
//      checkbox directly only toggles, and an untouched checkbox is neither
//      Yes nor No, so "No" is unreachable that way. Hence choiceOptions().
//   4. A field entry can hold MORE than its own control: Ramp's "Phone" entry
//      also carries an SMS-consent radio pair, each radio wrapped in its own
//      <label> reading "Yes - I consent to receiving text messages". Handing
//      those radios the entry's title ("Phone") would label a consent control
//      as a standard field and walk it straight past the consent guard — so
//      labelFor() steps aside for any control that has its own wrapping label.
//   5. Location is an input[role=combobox] whose aria-controls points at a
//      [role=listbox] of [role=option]s — core's existing combobox driver
//      fills it unchanged, no adapter involvement at all.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillAshby = factory();
    // Also registered under the generic name the content script reads, so
    // contentScript.js stays platform-neutral (one adapter is injected per
    // page by the manifest's content_scripts matches).
    root.CareerOSAutofillAdapter = root.CareerOSAutofillAshby;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FORM_SELECTORS = [
    '.ashby-application-form-container',
    '#form',
    'form',
    'main',
  ];

  // Scoping to .ashby-application-form-container rather than the outer #form
  // wrapper is deliberate: Ashby's own résumé-parsing "autofill pane" renders
  // a second, unlabelled <input type="file"> as a SIBLING of the container,
  // and the reCAPTCHA badge parks a <textarea name="g-recaptcha-response"> at
  // the end of <body>. Neither is ours to touch, and neither is inside the
  // container.
  // Returns EVERY matching container, not the first.
  //
  // Ashby splits one application across two sibling
  // .ashby-application-form-container elements: the questions in the first,
  // the entire U.S. EEO section (gender, race, veteran status) in the second.
  // Returning only the first — which is what `querySelector` did — put 23 of
  // the form's 37 controls in scope and made the self-identification questions
  // invisible to the extension (verified live, Base Power). Widening to a
  // shared ancestor is not the fix: Ashby's own résumé-parsing autofill pane
  // renders an unlabelled <input type="file"> outside both containers, and a
  // common ancestor would pull that back in — see the note above.
  function findForm(doc) {
    const d = doc || document;
    for (const selector of FORM_SELECTORS) {
      const found = Array.from(d.querySelectorAll(selector)).filter(
        // A container with no fillable controls is the posting page, not the
        // application (same check as the other two adapters).
        (el) => el.querySelectorAll('input, textarea, select').length >= 3
      );
      if (found.length) return found.length === 1 ? found[0] : found;
    }
    return null;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // jobs.ashbyhq.com/<slug>/<uuid>              (posting — the board API's jobUrl)
  // jobs.ashbyhq.com/<slug>/<uuid>/application  (application form — applyUrl)
  function extractPostingId(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!/(^|\.)ashbyhq\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    for (const part of parts) {
      if (UUID_RE.test(part)) return part.toLowerCase();
    }
    return null;
  }

  function isApplicationPage(url, doc) {
    if (!extractPostingId(url)) return false;
    return Boolean(findForm(doc));
  }

  const FIELD_ENTRY_SELECTOR = '.ashby-application-form-field-entry, [data-field-path]';
  const QUESTION_TITLE_SELECTOR = '.ashby-application-form-question-title';
  const YESNO_SELECTOR = '.ashby-application-form-input-yesno';

  function fieldEntry(el) {
    if (!el || !el.closest) return null;
    return el.closest(FIELD_ENTRY_SELECTOR);
  }

  function fieldPath(el) {
    const entry = fieldEntry(el);
    if (!entry || !entry.getAttribute) return null;
    return entry.getAttribute('data-field-path');
  }

  // Keyed on `data-field-path`, the only identifier Ashby puts on every field
  // (see DOM fact #2). Custom questions carry a UUID here and get no hint at
  // all, which is correct: their visible label is a real question, so core's
  // fieldMap decides — that is what makes "LinkedIn Profile", "Phone Number"
  // and "Current/Most Recent Company Name" fill without a per-board entry.
  const PATH_HINTS = {
    _systemfield_name: 'fullName',
    _systemfield_email: 'email',
    _systemfield_resume: 'resumeFile',
    _systemfield_location: 'location',
  };

  // Ashby renders an optional SMS-consent radio pair INSIDE the phone field's
  // entry (DOM fact #4). Its own wrapping labels say "I consent to...", so the
  // consent guard catches it on the label alone — this is the belt to that
  // braces, and names it explicitly rather than relying on wording.
  const SKIP_NAMES = ['communicationConsent'];

  function fieldHint(el) {
    if (!el || !el.getAttribute) return null;
    const name = el.getAttribute('name');
    if (name && SKIP_NAMES.includes(name)) return 'skip';
    const path = fieldPath(el);
    if (!path) return null;
    if (Object.prototype.hasOwnProperty.call(PATH_HINTS, path)) return PATH_HINTS[path];
    return null;
  }

  // The real question text for an Ashby control: the title label of its field
  // entry. Anything outside an entry returns null and falls through to core's
  // own label cascade.
  //
  // The wrapping-label check is the important half. A control that carries its
  // OWN <label> is not the entry's headline control — it is one option of
  // something else living in the same entry (Ramp's SMS-consent radios). Those
  // must keep their own text, both because it is the honest label and because
  // the consent guard reads it.
  function labelFor(el) {
    const entry = fieldEntry(el);
    if (!entry || !entry.querySelector) return null;
    const titleEl = entry.querySelector(QUESTION_TITLE_SELECTOR);
    if (!titleEl) return null;
    const own = el.closest ? el.closest('label') : null;
    if (own && own !== titleEl) return null;
    const text = (titleEl.innerText || titleEl.textContent || '').trim();
    return text || null;
  }

  function yesNoWidget(el) {
    if (!el || !el.closest) return null;
    const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
    if (type !== 'checkbox') return null;
    return el.closest(YESNO_SELECTOR);
  }

  // The hidden checkbox behind a Yes/No widget is a real control the page has
  // merely taken out of the tab order (DOM fact #3) — not a react-select
  // required-shim, which is what core's presentational guard exists to drop.
  // Vouching for it here waives ONLY that heuristic; guards.js decides what is
  // waivable, and consent/sensitive/submit never are.
  function isRealControl(el) {
    return Boolean(yesNoWidget(el));
  }

  // Which options a control offers, and the node that picks each one. Ashby's
  // Yes/No answer lives on two buttons, not on the checkbox's own siblings, so
  // core cannot find it by walking the DOM — the checkbox's only readable
  // "option" is its default value attribute, "on".
  function choiceOptions(el) {
    const widget = yesNoWidget(el);
    if (!widget || !widget.querySelectorAll) return null;
    const buttons = Array.from(widget.querySelectorAll('button[data-option]'));
    if (!buttons.length) return null;
    const options = buttons
      .map((node) => {
        const text = (node.innerText || node.textContent || node.getAttribute('data-option') || '').trim();
        return text ? { text, node } : null;
      })
      .filter(Boolean);
    return options.length ? options : null;
  }

  // Which question a radio/checkbox belongs to. Core's default identity is the
  // shared `name` attribute, and Ashby breaks that assumption in the one place
  // it matters most: a multi-select question renders one checkbox per option
  // and gives each the OPTION TEXT as its name (name="LinkedIn",
  // name="Referral (friend, peer, professor, etc.)"). So nine checkboxes
  // answering "How did you hear about Base Power Company?" looked like nine
  // separate questions, each offering the single option it happened to be —
  // exactly what was seen live. The field entry's `data-field-path` is the
  // real identity and is shared by every option of the question.
  //
  // The EEO radios go the other way (one shared name across the group), so
  // both paths have to agree; keying on the entry makes them the same answer.
  function groupIdentity(el) {
    const path = fieldPath(el);
    if (!path) return null;
    return `${fieldEntry(el).getAttribute('data-field-entry-id') || ''}|${path}`;
  }

  function groupMembers(el) {
    const entry = fieldEntry(el);
    if (!entry || !entry.querySelectorAll) return null;
    const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
    if (type !== 'radio' && type !== 'checkbox') return null;
    // Scoped to the entry, so the phone field's SMS-consent radios can never
    // be swept into the question they merely sit beside (DOM fact #4).
    const members = Array.from(entry.querySelectorAll(`input[type="${type}"]`)).filter(
      (node) => !SKIP_NAMES.includes(node.getAttribute('name'))
    );
    return members.length ? members : null;
  }

  return {
    platform: 'ashby',
    findForm,
    extractPostingId,
    isApplicationPage,
    fieldHint,
    labelFor,
    isRealControl,
    choiceOptions,
    groupIdentity,
    groupMembers,
    PATH_HINTS,
    SKIP_NAMES,
  };
});
