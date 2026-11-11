// workable.js — the Workable-specific field adapter (spec §15 session 31).
//
// Same contract as greenhouse.js, lever.js and ashby.js: an adapter supplies
// DOM SHAPE only. All field semantics live in core/fieldMap.js and all
// matching in core/matcher.js.
//
// Workable's application form lives at
//   apply.workable.com/<slug>/j/<SHORTCODE>/apply
// and the board API's `url` — which is what lands in `jobs.link` — is the
// slugless permalink apply.workable.com/j/<SHORTCODE>, which redirects there.
// The posting id is that 10-character shortcode in both shapes, and the
// server's extractPostingId (routes/autofill.js) reads it the same way. Kept
// in agreement by test.
//
// Five DOM facts drove everything below, all read off real application pages
// (1000heads, Saalex — 2026-09-13):
//
//   1. A real <form data-ui="application-form">. Every field sits under an
//      element carrying `data-ui="<key>"` — firstname, lastname, email, phone,
//      address, resume, cover_letter for standard fields, `CA_<n>` for the
//      account's own questions and `QA_<n>` for per-job screening questions.
//      That key is the stable identifier; ids on custom controls are random.
//   2. Labels are <span id="<key>_label"> elements referenced by
//      aria-labelledby, and several of them contain an inline <svg> whose
//      <desc> reads "SVGs not supported by this browser." Core's cascade reads
//      textContent, so the résumé upload's label came out as exactly that
//      sentence — labelFor() below reads text with every <svg> removed.
//   3. A radio question is <fieldset role="radiogroup" data-ui="CA_n">. The
//      real <input type="radio"> is aria-hidden="true" and tabindex="-1",
//      sitting INSIDE a <div role="radio"> wrapper that is what the user
//      clicks; the option text is <span id="radio_label_<input id>">. Two
//      wrappings exist (a presentation <label> around the div, or the div
//      around a <label>) and both are covered by `closest('[role=radio]')`.
//      Clicking the hidden input does not move the widget's state, so
//      choiceOptions() hands back the wrappers — the Ashby Yes/No shape.
//   4. `cover_letter` is a <textarea> on boards that ask for pasted text, not
//      an upload. A letter written for one company must never become an
//      answer-bank row replayed at the next one, so that shape is skipped.
//   5. Dropdowns are input[role=combobox] with aria-controls pointing at a
//      [role=listbox], plus an aria-hidden shim input carrying the submitted
//      value — core's combobox driver and presentational guard handle both
//      unchanged.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillWorkable = factory();
    // Also registered under the generic name the content script reads, so
    // contentScript.js stays platform-neutral.
    root.CareerOSAutofillAdapter = root.CareerOSAutofillWorkable;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FORM_SELECTORS = ['form[data-ui="application-form"]', 'form'];

  function findForm(doc) {
    const d = doc || document;
    for (const selector of FORM_SELECTORS) {
      const el = d.querySelector(selector);
      // The job description page has a search box and no application; three
      // controls is the same floor the other adapters use.
      if (el && el.querySelectorAll('input, textarea, select').length >= 3) return el;
    }
    return null;
  }

  const SHORTCODE_RE = /^[0-9a-z]{10}$/i;

  // apply.workable.com/j/<SC>                (board API's url — jobs.link)
  // apply.workable.com/<slug>/j/<SC>/apply   (the application form)
  function extractPostingId(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!/(^|\.)workable\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const j = parts.indexOf('j');
    if (j === -1 || !SHORTCODE_RE.test(parts[j + 1] || '')) return null;
    return parts[j + 1].toUpperCase();
  }

  function isApplicationPage(url, doc) {
    if (!extractPostingId(url)) return false;
    return Boolean(findForm(doc));
  }

  function attr(el, name) {
    return el && el.getAttribute ? el.getAttribute(name) : null;
  }

  function typeOf(el) {
    return String(attr(el, 'type') || (el && el.type) || '').toLowerCase();
  }

  // The nearest data-ui key that names a FIELD. `option` (a radio wrapper's
  // own data-ui on QA_ questions) and `application-form` are structure, not
  // fields.
  function fieldKey(el) {
    let node = el && el.closest ? el.closest('[data-ui]') : null;
    while (node) {
      const key = attr(node, 'data-ui');
      if (key && key !== 'option' && key !== 'application-form') return key;
      node = node.parentElement && node.parentElement.closest ? node.parentElement.closest('[data-ui]') : null;
    }
    return null;
  }

  // Visible text of a label node, minus any <svg> inside it (DOM fact #2).
  function textWithoutSvg(node) {
    if (!node) return '';
    if (typeof node.cloneNode === 'function') {
      const copy = node.cloneNode(true);
      if (copy.querySelectorAll) for (const svg of copy.querySelectorAll('svg')) svg.remove();
      return String(copy.textContent || '').replace(/\s+/g, ' ').trim();
    }
    return String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function labelledByText(el, docHint) {
    const ids = String(attr(el, 'aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const doc = docHint || el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || !ids.length) return '';
    // Only the FIRST id: the résumé input also references a description node
    // ("PDF, DOC… up to 5MB"), which is help text, not the question.
    return textWithoutSvg(doc.getElementById(ids[0]));
  }

  function radioGroup(el) {
    if (!el || !el.closest) return null;
    const type = typeOf(el);
    if (type !== 'radio' && type !== 'checkbox') return null;
    return el.closest('fieldset[role="radiogroup"], fieldset[role="group"], [role="radiogroup"], [role="group"]');
  }

  // Keyed on the field's data-ui key (DOM fact #1). Custom CA_/QA_ questions
  // get no hint, so their visible label decides through core's fieldMap.
  const KEY_HINTS = {
    firstname: 'firstName',
    lastname: 'lastName',
    email: 'email',
    phone: 'phone',
    resume: 'resumeFile',
    // Workable's `address` is a street-address autocomplete. The profile holds
    // a city and state, and "Address" is an exact alias of the location field,
    // so without this "San Jose, CA" was proposed as a street address. A key
    // the profile has no value for makes it an ordinary question instead.
    address: 'streetAddress',
  };

  function fieldHint(el) {
    const key = fieldKey(el);
    if (!key) return null;
    if (key === 'cover_letter') {
      // An upload is ours to attach; pasted text is a job-specific letter
      // (DOM fact #4) and never ours to save or replay.
      return typeOf(el) === 'file' ? 'coverLetterFile' : 'skip';
    }
    if (key === 'resume') return typeOf(el) === 'file' ? 'resumeFile' : null;
    return Object.prototype.hasOwnProperty.call(KEY_HINTS, key) ? KEY_HINTS[key] : null;
  }

  // The question text for a Workable control. A radio/checkbox takes its
  // GROUP's label — its own wrapping <label> reads just "Yes". Anything else
  // takes its own first aria-labelledby target, else the `<key>_label` span of
  // its field. Returning null falls through to core's cascade.
  function labelFor(el) {
    if (!el || !el.getAttribute) return null;
    const group = radioGroup(el);
    // The group is looked up in the CONTROL's document — the one this scan is
    // running against, which a detached or framed group node may not report.
    if (group) return labelledByText(group, el.ownerDocument) || null;
    const own = labelledByText(el);
    if (own) return own;
    const key = fieldKey(el);
    if (!key) return null;
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const node = doc && doc.getElementById ? doc.getElementById(`${key}_label`) : null;
    return textWithoutSvg(node) || null;
  }

  // The hidden radio inside a role=radio wrapper is the real control the page
  // took out of the accessibility tree (DOM fact #3), not a react-select shim.
  // Vouching waives ONLY the presentational heuristic; guards.js decides that.
  function isRealControl(el) {
    return Boolean(radioGroup(el) && el.closest('[role="radio"], [role="checkbox"]'));
  }

  function groupMembers(el) {
    const group = radioGroup(el);
    if (!group || !group.querySelectorAll) return null;
    const members = Array.from(group.querySelectorAll(`input[type="${typeOf(el)}"]`));
    return members.length ? members : null;
  }

  function choiceOptions(el) {
    const members = groupMembers(el);
    if (!members) return null;
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const options = members
      .map((input) => {
        const node = input.closest ? input.closest('[role="radio"], [role="checkbox"]') : null;
        const labelNode = doc && input.id ? doc.getElementById(`radio_label_${input.id}`) : null;
        const text = textWithoutSvg(labelNode) || textWithoutSvg(node);
        return node && text ? { text, node } : null;
      })
      .filter(Boolean);
    return options.length ? options : null;
  }

  function groupIdentity(el) {
    const group = radioGroup(el);
    return group ? attr(group, 'data-ui') || null : null;
  }

  return {
    platform: 'workable',
    findForm,
    extractPostingId,
    isApplicationPage,
    fieldHint,
    labelFor,
    isRealControl,
    choiceOptions,
    groupIdentity,
    groupMembers,
    KEY_HINTS,
  };
});
