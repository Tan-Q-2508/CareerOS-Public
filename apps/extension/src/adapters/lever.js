// lever.js — the Lever-specific field adapter (spec §15 session 29).
//
// Same contract as greenhouse.js: an adapter supplies DOM SHAPE only. All
// field semantics live in core/fieldMap.js and all matching in core/matcher.js.
//
// Lever's application form is server-rendered (not a SPA form) and lives at
//   jobs.lever.co/<slug>/<posting-uuid>/apply      (also jobs.eu.lever.co)
// with the posting also reachable at the same path without /apply. The posting
// id is a UUID, not a number — the server's own extractPostingId
// (routes/autofill.js) parses it the same way and the two must stay in
// agreement, which is enforced by test.
//
// Three DOM facts drove everything below; all three were read off a real
// posting (jobs.lever.co/ro/<uuid>/apply, verified 2026-08-20):
//
//   1. Standard fields carry NO id and no `label[for]` — they are wrapped in a
//      <label> whose text is right, but they all carry a stable `name`
//      attribute, so the hints here key on `name` rather than `id`.
//   2. Custom screening questions have no <label> at ALL. The markup is
//        <li class="application-question custom-question">
//          <div class="application-label ..."><div class="text">Question?</div></div>
//          <div class="application-field"><textarea name="cards[uuid][field0]">
//      so core's label cascade would fall through to the `name` attribute and
//      produce "cards uuid field0" as the question text — garbage in the form,
//      and garbage written into the shared answer bank. labelFor() below is
//      the fix, and is consulted by the matcher ahead of its own cascade.
//   3. Multiple-choice questions render each option as
//        <label><input type="radio" value="Yes"><span>Yes</span></label>
//      so the wrapping-label rule yields "Yes" as the QUESTION text. The same
//      labelFor() rule fixes this, because the real question sits on the
//      enclosing li.application-question.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillLever = factory();
    // Also registered under the generic name the content script reads, so
    // contentScript.js stays platform-neutral (one adapter is injected per
    // page by the manifest's content_scripts matches).
    root.CareerOSAutofillAdapter = root.CareerOSAutofillLever;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FORM_SELECTORS = [
    'form#application-form',
    'form[enctype="multipart/form-data"]',
    'main form',
    'form',
  ];

  function findForm(doc) {
    const d = doc || document;
    for (const selector of FORM_SELECTORS) {
      const el = d.querySelector(selector);
      // A form with no fillable controls is a search box or a newsletter
      // signup, not the application (same check as the Greenhouse adapter).
      if (el && el.querySelectorAll('input, textarea, select').length >= 3) return el;
    }
    return null;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // jobs.lever.co/<slug>/<uuid>            (posting)
  // jobs.lever.co/<slug>/<uuid>/apply      (application form)
  // jobs.eu.lever.co/<slug>/<uuid>/apply   (EU-hosted boards)
  function extractPostingId(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!/(^|\.)lever\.co$/i.test(parsed.hostname)) return null;
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

  // Keyed on `name`, which is the only stable identifier Lever gives its
  // standard fields (see DOM fact #1 above).
  //
  // The 'skip' entries are deliberate rather than incidental:
  //   urls[Other]      — an unlabelled catch-all URL box. Left as a question
  //                      it would become an answer-bank row ("other url")
  //                      replayed on every future company's form.
  //   selectedLocation — the hidden partner of the location autocomplete;
  //                      writing it without the widget's own state is worse
  //                      than leaving it empty.
  //   consent[]        — a legal/marketing affirmation, never ours to check.
  //
  // Pronouns and eeo[...] are deliberately NOT hinted here: they are
  // voluntary self-identification questions, which the panel offers the user
  // once and then reuses from their own saved answer (§17.5). guards.js
  // classifies them by field name, which matters on Lever because each
  // pronoun checkbox's own label reads "He/him", not "Pronouns".
  const NAME_HINTS = {
    name: 'fullName',
    email: 'email',
    phone: 'phone',
    location: 'location',
    org: 'currentCompany',
    resume: 'resumeFile',
    'urls[LinkedIn]': 'linkedin',
    'urls[GitHub]': 'github',
    'urls[Portfolio]': 'portfolio',
    'urls[Other]': 'skip',
    'urls[Twitter]': 'skip',
    selectedLocation: 'skip',
  };

  // The "Custom" pronoun escape hatch: a checkbox plus the text box it
  // reveals, both carrying the same "Pronouns" label as the option list above
  // them. Left in, one saved answer would be applied to all three controls at
  // once — ticked in the list AND typed into the custom box.
  const SKIP_IDS = ['customPronounsOption', 'customPronounsTextField', 'useNameOnlyPronounsOption'];

  function fieldHint(el) {
    if (!el || !el.getAttribute) return null;
    if (el.id && SKIP_IDS.includes(el.id)) return 'skip';
    const name = el.getAttribute('name');
    if (!name) return null;
    if (Object.prototype.hasOwnProperty.call(NAME_HINTS, name)) return NAME_HINTS[name];
    if (/^consent\[/i.test(name)) return 'skip';
    return null;
  }

  // The real question text for a Lever control. Every field Lever renders —
  // standard, custom, or EEO — sits inside a .application-question wrapper
  // carrying a .application-label, so this answers for all of them; anything
  // outside that structure returns null and falls through to core's own label
  // cascade.
  function labelFor(el) {
    if (!el || !el.closest) return null;
    const question = el.closest('li.application-question, .application-question');
    if (!question || !question.querySelector) return null;
    const labelEl = question.querySelector('.application-label');
    if (!labelEl) return null;
    // Custom questions nest the text one level deeper; standard/EEO ones put
    // it directly on .application-label.
    const inner = labelEl.querySelector ? labelEl.querySelector('.text') : null;
    const node = inner || labelEl;
    const text = (node.innerText || node.textContent || '').trim();
    return text || null;
  }

  return {
    platform: 'lever',
    findForm,
    extractPostingId,
    isApplicationPage,
    fieldHint,
    labelFor,
    NAME_HINTS,
    SKIP_IDS,
  };
});
