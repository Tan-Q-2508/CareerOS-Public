// workday.js — the Workday-specific field adapter (spec §15 session 32).
//
// Same contract as the other adapters: DOM SHAPE only. Workday is the one
// platform whose shape needed new seams in core rather than just an adapter,
// and each is described where it is used (matcher.scanForm's extraControls,
// filler's listbox-button driver, contentScript's step watcher).
//
// The application lives at
//   <tenant>.<wdN>.myworkdayjobs.com[/<locale>]/<site>/job/<location>/<title>_<REQ>/apply/applyManually
// and `jobs.link` holds the posting's externalUrl, the same path without
// /apply. The posting id is <REQ>, the text after the last underscore of the
// title segment; the server reads it identically (routes/autofill.js). Kept in
// agreement by test.
//
// DOM facts, read off a real guest application (23andMe, 2026-09-13):
//
//   1. The flow is a five-step single-page app (My Information, My
//      Experience, Application Questions, Voluntary Disclosures, Review) under
//      [data-automation-id="applyFlowPage"], with a progress bar whose active
//      step is [data-automation-id="progressBarActiveStep"]. The URL does not
//      change between steps, so the page's own step is what says the form has
//      been swapped out underneath a plan (stepKey).
//   2. Every field is wrapped in [data-automation-id="formField-<key>"] with a
//      real <label for> — legalName--firstName, legalName--lastName,
//      emailAddress, phoneNumber, addressLine1, city, postalCode, source,
//      country, phoneType, countryPhoneCode, extension. The key is stable
//      across tenants; control ids are derived from it but not guaranteed.
//   3. Dropdowns are <button aria-haspopup="listbox" aria-controls="<ul>">
//      reading "Select One" — no input at all, so core's input/select query
//      cannot see them (extraControls). Their aria-label concatenates the
//      question with "Select One Required", which is why labelFor() reads the
//      wrapper's <label> instead.
//   4. Radio questions are <fieldset><legend><label>Question</label></legend>
//      with ordinary radios sharing a name — core's grouping handles them once
//      labelled.
//   5. Country and Country Phone Code arrive pre-set to the tenant's country;
//      the phone number sits beside that code, so core's dial-code rule
//      (§17.4) strips the "+1" from the profile number. The SMS opt-in beside
//      the phone is a consent, never ours.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillWorkday = factory();
    root.CareerOSAutofillAdapter = root.CareerOSAutofillWorkday;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function countControls(el) {
    return el.querySelectorAll('input, textarea, select, button[aria-haspopup="listbox"]').length;
  }

  function findForm(doc) {
    const d = doc || document;
    const el = d.querySelector('[data-automation-id="applyFlowPage"]');
    return el && countControls(el) >= 1 ? el : null;
  }

  // Host plus the REQ id rule (see header). Anything that is not a posting
  // path under a Workday host returns null.
  function extractPostingId(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!/(^|\.)myworkday(jobs|site)\.com$/i.test(parsed.hostname)) return null;
    const segs = parsed.pathname.split('/').filter(Boolean);
    const jobIdx = segs.indexOf('job');
    const titleSeg = jobIdx >= 0 ? segs[jobIdx + 2] : null;
    const m = titleSeg ? titleSeg.match(/_([A-Za-z0-9-]*\d[A-Za-z0-9-]*)$/) : null;
    return m ? m[1] : null;
  }

  function isApplicationPage(url, doc) {
    if (!extractPostingId(url)) return false;
    return Boolean(findForm(doc));
  }

  function formField(el) {
    return el && el.closest ? el.closest('[data-automation-id^="formField-"]') : null;
  }

  function fieldKey(el) {
    const wrapper = formField(el);
    const auto = wrapper && wrapper.getAttribute ? wrapper.getAttribute('data-automation-id') : null;
    return auto ? auto.slice('formField-'.length) : null;
  }

  const KEY_HINTS = {
    'legalName--firstName': 'firstName',
    'legalName--lastName': 'lastName',
    emailAddress: 'email',
    phoneNumber: 'phone',
    // Workday's City is the city alone; the profile's location is "City, ST".
    city: 'city',
    // Pre-set by the tenant from its own country (DOM fact #5); re-picking it
    // from a profile guess could only make it wrong.
    country: 'skip',
    countryPhoneCode: 'skip',
    extension: 'skip',
    // "Type to Add Skills" is a multi-select prompt: typed text is only a
    // search, and nothing is kept until an option pill is picked. A typed
    // answer would be banked and then replayed as a search that selects
    // nothing — so it is left for the user.
    skills: 'skip',
  };

  function fieldHint(el) {
    if (!el || !el.getAttribute) return null;
    const auto = el.getAttribute('data-automation-id') || '';
    if (/sms-opt-in/i.test(auto)) return 'skip';
    if (String(el.type || el.getAttribute('type') || '').toLowerCase() === 'file') return 'resumeFile';
    const key = fieldKey(el);
    if (!key) return null;
    // Every listbox button carries an unlabelled <input type="text"> sibling
    // in the same form field — the widget's own value mirror. It took the
    // field's label and was offered as a free-text copy of the dropdown right
    // above it (verified live). The button is the question; the mirror is not.
    const wrapper = formField(el);
    if (
      el.tagName && el.tagName.toLowerCase() === 'input' &&
      wrapper && wrapper.querySelector && wrapper.querySelector('button[aria-haspopup="listbox"]')
    ) {
      return 'skip';
    }
    return Object.prototype.hasOwnProperty.call(KEY_HINTS, key) ? KEY_HINTS[key] : null;
  }

  function cleanLabel(node) {
    if (!node) return '';
    if (typeof node.cloneNode === 'function') {
      const copy = node.cloneNode(true);
      // The required marker is an <abbr>*</abbr> inside the label.
      if (copy.querySelectorAll) for (const n of copy.querySelectorAll('abbr, svg')) n.remove();
      return String(copy.textContent || '').replace(/\s+/g, ' ').trim();
    }
    return String(node.innerText || node.textContent || '').replace(/\*/g, '').trim();
  }

  // The wrapper's own <label> (inside a <legend> for radio groups). A control
  // with its own wrapping label that is NOT the field label — an option of a
  // checkbox list — keeps its own text and falls through to core.
  //
  // Application Questions (step 3) carry no <label> at all: the question is
  // rich text inside the fieldset's legend —
  //   <fieldset><legend><div id="rich-label19"><div data-automation-id="richText"><p>…
  // — and the dropdown's aria-label is only " Select One Required". Reading
  // that fallback labelled three different questions identically (verified
  // live), which would have filed all three under one answer-bank key.
  function labelFor(el) {
    const wrapper = formField(el);
    if (!wrapper || !wrapper.querySelector) return null;
    const label = wrapper.querySelector('legend label, label');
    if (label) {
      const own = el.closest ? el.closest('label') : null;
      if (own && own !== label) return null;
      return cleanLabel(label) || null;
    }
    const rich = wrapper.querySelector('legend [data-automation-id="richText"], legend');
    return cleanLabel(rich) || null;
  }

  function extraControls(scope) {
    if (!scope || !scope.querySelectorAll) return [];
    return Array.from(scope.querySelectorAll('button[aria-haspopup="listbox"]')).filter((b) => formField(b));
  }

  function stepKey(doc) {
    const d = doc || document;
    const active = d.querySelector('[data-automation-id="progressBarActiveStep"]');
    return active ? String(active.innerText || active.textContent || '').replace(/\s+/g, ' ').trim() : null;
  }

  return {
    platform: 'workday',
    findForm,
    extractPostingId,
    isApplicationPage,
    fieldHint,
    labelFor,
    extraControls,
    stepKey,
    commitOnBlur: true,
    KEY_HINTS,
  };
});
