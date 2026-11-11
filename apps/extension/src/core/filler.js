// filler.js — writes approved values into the page.
//
// Two things make this non-trivial and are the reason it's its own module
// rather than three lines inside the panel:
//
//   1. Setting `.value` on a React-controlled input does NOT update React's
//      internal state — React overrides the value property on the element
//      instance, so the framework never sees the assignment and reverts it on
//      the next render. The fix is to call the NATIVE prototype setter and
//      then dispatch real bubbling input/change events. Greenhouse's newer
//      forms and (per spec §15 session 32) Workday both need this; doing it
//      uniformly here means the later adapters inherit it for free.
//   2. File inputs can't be assigned. The only supported route is building a
//      DataTransfer and assigning its .files, then firing change.
//
// Every write goes through guards.blockReason first — a value can only reach
// the page if the guard allows it, no matter what the caller passed.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./guards'), require('./matcher'));
  } else {
    root.CareerOSAutofillFiller = factory(root.CareerOSAutofillGuards, root.CareerOSAutofillMatcher);
  }
})(typeof self !== 'undefined' ? self : this, function (guards, matcher) {
  function nativeSetter(el) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    return desc && desc.set ? desc.set : null;
  }

  function fireInputEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // A listbox BUTTON: Workday renders every dropdown as
  // <button aria-haspopup="listbox" aria-controls="<ul id>">Select One</button>.
  // It holds no value to assign and no text to type into, so it is driven by
  // clicking — the button opens its listbox, and the answer is the option
  // clicked. aria-controls names the list exactly (verified live), so the
  // option lookup below needs no document-wide sweep.
  function isListboxButton(el) {
    return Boolean(
      el && el.tagName && el.tagName.toLowerCase() === 'button' &&
      String(el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox'
    );
  }

  // The option a listbox button shows before anything is chosen ("Select
  // One") is a real [role=option] in its list. It submits nothing, so it is
  // never offered as an answer.
  function isPlaceholderOption(text) {
    return /^(select( one| an option)?|choose( one)?|--+|please select)\W*$/i.test(String(text || '').trim());
  }

  // Whether the button's list is actually showing. Workday leaves
  // aria-expanded="true" on the button after its menu has closed (verified
  // live), so the attribute cannot answer this; the list's own box can.
  function listboxShowing(el) {
    const doc = el.ownerDocument || document;
    const id = el.getAttribute('aria-controls');
    const list = id ? doc.getElementById(id) : null;
    if (!list) return false;
    if (typeof list.getBoundingClientRect !== 'function') return el.getAttribute('aria-expanded') === 'true';
    const box = list.getBoundingClientRect();
    return box.height > 0 && box.width > 0;
  }

  async function openListboxButton(el, { timeoutMs = 1800 } = {}) {
    const known = new Set(visibleOptions(el, null));
    if (!listboxShowing(el)) el.click();
    let options = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      options = visibleOptions(el, known).filter((o) => !isPlaceholderOption(o.innerText || o.textContent));
      if (options.length) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    return options;
  }

  // Escape does not close Workday's menu and neither does a click outside it;
  // clicking the button again does (all three tried live). Only ever done
  // while the list is showing, since the click is a toggle.
  function closeListboxButton(el) {
    if (!listboxShowing(el)) return;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (listboxShowing(el)) el.click();
  }

  async function setListboxButtonValue(el, value, { field = null } = {}) {
    const target = String(value ?? '').trim();
    if (!target) return false;
    const options = await openListboxButton(el);
    let match = options.find((o) => optionTextMatches(o.innerText || o.textContent, target));
    if (!match && field === 'location') {
      match = options.find((o) => locationOptionMatches(o.innerText || o.textContent, target));
    }
    if (!match) {
      closeListboxButton(el);
      return false;
    }
    match.click();
    // Choosing an option starts Workday's own close. Checking at a fixed
    // 300ms caught the list mid-animation, still measuring open, and the
    // "close" click that followed re-opened it — every dropdown was left
    // hanging open after a fill (verified live). So wait for the list to go
    // on its own, and only then close what is genuinely still showing.
    const closeBy = Date.now() + 1200;
    await new Promise((r) => setTimeout(r, 150));
    while (listboxShowing(el) && Date.now() < closeBy) {
      await new Promise((r) => setTimeout(r, 100));
    }
    closeListboxButton(el);
    // The button's own text becomes the chosen option. Anything else — still
    // "Select One", or a different option — is a failed fill, reported as one.
    return optionTextMatches(el.innerText || el.textContent, target) ||
      String(el.innerText || el.textContent || '').trim().toLowerCase() ===
        String(match.innerText || match.textContent || '').trim().toLowerCase();
  }

  function setTextValue(el, value) {
    const setter = nativeSetter(el);
    if (setter) setter.call(el, value);
    else el.value = value;
    fireInputEvents(el);
    // Success is "the field now holds something", not "it holds exactly what
    // we wrote": input widgets legitimately reformat. Greenhouse's phone field
    // runs intl-tel-input, which rewrites "(415) 555-0100" to "4155550100" —
    // a correct fill that a strict equality check reported as a failure
    // (confirmed live).
    const written = String(value ?? '');
    return written === '' ? el.value === '' : el.value.length > 0;
  }

  function setSelectValue(el, value) {
    const target = String(value).trim().toLowerCase();
    const match =
      Array.from(el.options).find((o) => o.value.trim().toLowerCase() === target) ||
      Array.from(el.options).find((o) => o.text.trim().toLowerCase() === target) ||
      Array.from(el.options).find((o) => o.text.trim().toLowerCase().includes(target));
    if (!match) return false;
    const setter = nativeSetter(el);
    if (setter) setter.call(el, match.value);
    else el.value = match.value;
    fireInputEvents(el);
    return true;
  }

  // Radio/checkbox: `value` names which option to select, matched against the
  // option's own label rather than its (often opaque) value attribute.
  //
  // An adapter may describe the options instead, for a widget whose answer is
  // not carried by the control's own DOM siblings. Ashby's Yes/No question is
  // two <button data-option="yes|no"> plus a hidden checkbox: clicking a
  // button sets the answer, while clicking the checkbox merely toggles it, so
  // "No" is not reachable from an untouched control that way (verified live).
  // The adapter hands back the same [{text, node}] list the panel was shown,
  // and the node is clicked — after the same submit-control check every other
  // click path here runs.
  function adapterChoiceOptions(el, adapter) {
    if (!adapter || typeof adapter.choiceOptions !== 'function') return null;
    try {
      const options = adapter.choiceOptions(el);
      return Array.isArray(options) && options.length ? options : null;
    } catch {
      return null;
    }
  }

  // The other inputs answering the SAME question as `el`. An adapter gets
  // first say because sharing a `name` is not universal: Ashby renders a
  // multi-select question as one checkbox per option, each carrying the option
  // TEXT as its name ("LinkedIn", "Referral (friend, peer, professor, etc.)"),
  // so a name lookup returns a group of one and only the option the plan
  // happened to be built on is ever reachable (verified live, Base Power).
  function groupMembers(el, adapter) {
    if (adapter && typeof adapter.groupMembers === 'function') {
      try {
        const members = adapter.groupMembers(el);
        if (Array.isArray(members) && members.length) return members;
      } catch {
        /* fall through to the name lookup */
      }
    }
    const doc = el.ownerDocument || document;
    const name = el.getAttribute('name');
    return name ? Array.from(doc.querySelectorAll(`input[name="${CSS.escape(name)}"]`)) : [el];
  }

  function optionLabelOf(option) {
    return (
      (option.labels && option.labels[0] && (option.labels[0].innerText || option.labels[0].textContent)) ||
      option.getAttribute('aria-label') ||
      ''
    );
  }

  function setChoiceValue(el, value, adapter) {
    const fromAdapter = adapterChoiceOptions(el, adapter);
    if (fromAdapter) {
      const match = fromAdapter.find((o) => optionTextMatches(o.text, value));
      if (!match || !match.node) return false;
      if (guards.isSubmitControl(match.node)) return false;
      match.node.click();
      return true;
    }

    const group = groupMembers(el, adapter);
    const target = String(value).trim().toLowerCase();

    for (const option of group) {
      const label = (optionLabelOf(option) || option.value || '').trim().toLowerCase();
      if (label === target || option.value.trim().toLowerCase() === target) {
        if (guards.isSubmitControl(option)) return false;
        // A real click, not `checked = true`: assigning the property leaves a
        // React-controlled box with the framework's own state unchanged, so the
        // next render reverts it. click() is also a toggle, hence the guard —
        // re-clicking an already-checked option would clear the answer.
        if (!option.checked) option.click();
        fireInputEvents(option);
        return option.checked === true;
      }
    }
    return false;
  }

  // React-select style comboboxes (role="combobox", aria-autocomplete="list").
  // Greenhouse uses these for Location, work authorization, sponsorship and
  // most yes/no screening questions — verified live — and none of them can be
  // filled by assigning .value: the visible input is a search box, and the
  // real answer is whichever option the user clicks. So the fill has to
  // actually drive the widget: open the menu, type to filter, click the option
  // whose text matches. If no option matches, it reports failure rather than
  // leaving a typed-but-unselected value that looks filled and submits empty.
  // Two details here were established by testing against a real Greenhouse
  // form, and both are non-obvious:
  //   - The menu opens on a POINTER event sequence delivered to the select's
  //     CONTROL container, not to the input. mousedown on the input alone left
  //     aria-expanded="false" every time; pointerdown+mousedown+pointerup+
  //     mouseup+click on `.select__control` opened it immediately.
  //   - The option list is fetched, not static (location queries a remote
  //     service), so the options must be polled for rather than read once.
  const OPEN_EVENTS = [
    ['pointerdown', 'PointerEvent', { pointerId: 1, isPrimary: true, button: 0, buttons: 1 }],
    ['mousedown', 'MouseEvent', { button: 0, buttons: 1 }],
    ['pointerup', 'PointerEvent', { pointerId: 1, isPrimary: true, button: 0 }],
    ['mouseup', 'MouseEvent', { button: 0 }],
    ['click', 'MouseEvent', { button: 0 }],
  ];

  function fireSequence(node, events) {
    for (const [type, ctorName, init] of events) {
      const Ctor = ctorName === 'PointerEvent' && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
      node.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
    }
  }

  function comboboxControl(el) {
    return (
      el.closest('.select__control') ||
      el.closest('[class*="control"]') ||
      el.parentElement.parentElement ||
      el
    );
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Matches an option's text against the target answer. Every non-exact tier
  // is WORD-BOUNDARY, not a raw prefix/substring check: `"none of the
  // above".startsWith("no")` is true, and so is a raw `.includes("no")` —
  // both would let a stored answer of "No" silently commit against an
  // option reading "None of the above" (found live, testing this exact
  // fallback against a real dropdown). The boundary regex requires whatever
  // sits on either side of the match to be a non-alphanumeric character (or
  // string start/end), so "no" matches inside "San Jose, CA" (comma-bounded)
  // but not inside "none"/"north"/"not sponsored". A wrong auto-selected
  // answer is worse than no selection at all, so this stays conservative
  // rather than permissive. Exported standalone (no DOM dependency) so it's
  // unit-testable without a browser.
  // ---------------------------------------------------------------------
  // Location options, which no general text rule can match.
  //
  // A profile says "San Jose, CA". Greenhouse's location combobox offers
  // "San Jose, California, United States". Those are the same place and share
  // no matching phrase, so optionTextMatches below correctly refuses — and the
  // required Location (City) field was simply never filled, reported live.
  //
  // Subset-of-tokens is the obvious fix and is wrong: the same dropdown offers
  // "San José del Cabo, Baja California Sur, Mexico", which contains every one
  // of "san", "jose" and "california". So the rule is positional instead —
  // the option's FIRST comma-segment must be the city exactly, and the state
  // must be one of the remaining segments. That accepts the right option and
  // rejects the Mexican one, which is the whole job.
  // ---------------------------------------------------------------------
  const US_STATES = {
    al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
    co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
    hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
    ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
    ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
    mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada',
    nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
    nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
    or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
    sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
    va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin',
    wy: 'wyoming', dc: 'district of columbia', pr: 'puerto rico',
  };

  function foldAccents(s) {
    // "San José" and "San Jose" are the same city spelled two ways, and the
    // dropdown picks its own spelling.
    return typeof s.normalize === 'function'
      ? s.normalize('NFD').replace(/[̀-ͯ]/g, '')
      : s;
  }

  function locationSegments(value) {
    return foldAccents(String(value || ''))
      .toLowerCase()
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  // Both directions: a profile may say "CA" against an option saying
  // "California", or the reverse.
  function stateForms(segment) {
    const forms = new Set([segment]);
    if (US_STATES[segment]) forms.add(US_STATES[segment]);
    for (const [abbr, full] of Object.entries(US_STATES)) {
      if (full === segment) forms.add(abbr);
    }
    return forms;
  }

  function locationOptionMatches(optionText, target) {
    const want = locationSegments(target);
    const have = locationSegments(optionText);
    if (!want.length || !have.length) return false;
    // The city must BE the option's first segment, not merely appear in it.
    if (want[0] !== have[0]) return false;
    if (want.length === 1) return true;
    const rest = have.slice(1);
    return want.slice(1).every((segment) => {
      const forms = stateForms(segment);
      return rest.some((candidate) => forms.has(candidate));
    });
  }

  function optionTextMatches(optionText, target) {
    const text = String(optionText || '').trim().toLowerCase();
    const t = String(target || '').trim().toLowerCase();
    if (!text || !t) return false;
    if (text === t) return true;
    const boundary = '[^a-z0-9]';
    const re = new RegExp(`(^|${boundary})${escapeRegex(t)}(${boundary}|$)`);
    return re.test(text);
  }

  // Which [role=option]s belong to THIS combobox. `aria-controls` is the exact
  // answer when the widget sets it (Greenhouse's react-select does, once
  // open). Ashby's autocomplete never sets it, and a document-wide sweep is
  // not a safe fallback: Greenhouse's phone field keeps intl-tel-input's
  // 240-country listbox mounted at all times, so "every option on the page"
  // means a pronoun question offering "Afghanistan +93" (verified live).
  // Hence `known` — the options that already existed BEFORE this widget was
  // opened are somebody else's, whatever part of the DOM the menu portals to.
  function visibleOptions(el, known) {
    const doc = el.ownerDocument || document;
    const listboxId = el.getAttribute('aria-controls');
    const listbox = listboxId ? doc.getElementById(listboxId) : null;
    const found = Array.from((listbox || doc).querySelectorAll('[role="option"]'));
    return listbox || !known ? found : found.filter((o) => !known.has(o));
  }

  // Opens a combobox's menu and returns its option nodes.
  //
  // Two platforms, two different openers, and neither works on the other:
  //   - Greenhouse (react-select) opens on a POINTER sequence delivered to
  //     `.select__control`; mousedown on the input alone does nothing.
  //   - Ashby's autocomplete ignores mouse events entirely and opens on an
  //     INPUT event. With an empty value plus ArrowDown it lists everything,
  //     which is what makes the full option set readable without typing a
  //     guess first (both verified live).
  // So both are tried, cheapest first.
  // 1.8s: both platforms' menus were populated in well under 700ms live, and
  // the cap is what a remote-search typeahead with no fixed list costs — Ashby's
  // location field returns nothing until something is typed, so it waits out
  // the whole budget and then correctly offers no options.
  async function openCombobox(el, { timeoutMs = 1800 } = {}) {
    const known = new Set(visibleOptions(el, null));
    el.focus();
    fireSequence(comboboxControl(el), OPEN_EVENTS);

    let options = [];
    const deadline = Date.now() + timeoutMs;
    let nudged = false;
    while (Date.now() < deadline) {
      options = visibleOptions(el, known);
      if (options.length) break;
      if (!nudged && Date.now() > deadline - timeoutMs + 400) {
        nudged = true;
        setTextValue(el, el.value || '');
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return options;
  }

  function closeCombobox(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    el.blur();
  }

  // Reads a combobox's options WITHOUT answering it, so the review panel can
  // offer the form's own choices instead of a free-text box the user has to
  // guess the exact wording into. Restores whatever was in the field first —
  // this runs during the scan, before the user has approved anything.
  async function readComboboxOptions(el) {
    if (isListboxButton(el)) {
      // Opening a listbox button chooses nothing, so there is nothing to
      // restore — only the menu to close again.
      try {
        const options = await openListboxButton(el);
        return options.map((o) => (o.innerText || o.textContent || '').trim()).filter(Boolean);
      } catch {
        return [];
      } finally {
        closeListboxButton(el);
      }
    }
    const original = el.value;
    try {
      const options = await openCombobox(el);
      return options.map((o) => (o.innerText || o.textContent || '').trim()).filter(Boolean);
    } catch {
      return [];
    } finally {
      closeCombobox(el);
      if (el.value !== original) setTextValue(el, original);
    }
  }

  // Fills in each combobox question's `options` in place. Sequential for the
  // same reason applyAll is: the page has one open menu at a time.
  async function harvestComboboxOptions(questions) {
    for (const question of questions || []) {
      if (question.inputType !== 'combobox') continue;
      if (question.options && question.options.length) continue;
      question.options = await readComboboxOptions(question.el);
    }
    return questions;
  }

  async function setComboboxValue(el, value, { field = null } = {}) {
    const target = String(value).trim().toLowerCase();
    if (!target) return false;

    const known = new Set(visibleOptions(el, null));
    el.focus();
    fireSequence(comboboxControl(el), OPEN_EVENTS);
    if (el.readOnly) {
      // A select-only combobox (Workable's dropdowns) takes no typing; it is
      // opened and its whole list read. Keyboard is the fallback opener when
      // the pointer sequence alone left it closed.
      if (el.getAttribute('aria-expanded') !== 'true') {
        el.click();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      }
    } else {
      // Typing both filters react-select's list and is what opens Ashby's.
      setTextValue(el, String(value));
    }

    let options = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      options = visibleOptions(el, known);
      if (options.length) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!options.length) {
      closeCombobox(el);
      return false;
    }

    // The location rule is a SECOND chance, tried only after the general one
    // and only for the location field, so it can never loosen matching for an
    // ordinary question whose options happen to look place-like.
    let match = options.find((o) => optionTextMatches(o.innerText || o.textContent, target));
    if (!match && field === 'location') {
      match = options.find((o) => locationOptionMatches(o.innerText || o.textContent, target));
    }
    if (!match) {
      closeCombobox(el);
      return false;
    }

    fireSequence(match, OPEN_EVENTS);
    // Selection is applied on the widget's own state update, not synchronously.
    await new Promise((r) => setTimeout(r, 250));
    return el.getAttribute('aria-expanded') !== 'true';
  }

  function isCombobox(el) {
    return el.getAttribute && el.getAttribute('role') === 'combobox';
  }

  // ---------------------------------------------------------------------
  // Dates. A widget that parses what it's handed can disagree with what was
  // meant, and does so silently: react-datepicker (Ashby's "earliest
  // available start date") turns "2026-10-01" into 09/30/2026 — parsed as UTC
  // midnight, rendered local, one day early. So nothing here trusts the
  // write; every attempt is read back and re-parsed, and a value the widget
  // did not keep as the SAME calendar day is reported as a failed fill rather
  // than left on the form looking correct.
  // ---------------------------------------------------------------------
  function parseDateParts(value) {
    const s = String(value || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) return { first: +m[1], second: +m[2], y: +m[3] };
    return null;
  }

  function sameDay(a, b) {
    return Boolean(a && b && a.y === b.y && a.m === b.m && a.d === b.d);
  }

  const pad = (n) => String(n).padStart(2, '0');

  // Field order the widget itself advertises, when it advertises one — a
  // "DD/MM/YYYY" placeholder is a direct statement and beats any default.
  function placeholderOrder(el) {
    const hint = String((el.getAttribute && el.getAttribute('placeholder')) || '').toLowerCase();
    if (/d{1,2}\s*[/.-]\s*m{1,2}\s*[/.-]\s*y{2,4}/.test(hint)) return 'dmy';
    if (/m{1,2}\s*[/.-]\s*d{1,2}\s*[/.-]\s*y{2,4}/.test(hint)) return 'mdy';
    if (/y{2,4}\s*[/.-]\s*m{1,2}\s*[/.-]\s*d{1,2}/.test(hint)) return 'ymd';
    return null;
  }

  function setDateValue(el, value) {
    const want = parseDateParts(value);
    // Only an unambiguous intended date can be verified. The panel renders a
    // real <input type="date"> for these, so the value arriving here is ISO.
    if (!want || want.m === undefined) return false;

    if (String(el.type || '').toLowerCase() === 'date') {
      setTextValue(el, `${want.y}-${pad(want.m)}-${pad(want.d)}`);
      return sameDay(parseDateParts(el.value), want);
    }

    const order = placeholderOrder(el);
    const candidates = order === 'dmy'
      ? ['dmy', 'mdy', 'ymd']
      : order === 'ymd'
        ? ['ymd', 'mdy', 'dmy']
        : ['mdy', 'dmy', 'ymd'];

    for (const format of candidates) {
      const written =
        format === 'mdy'
          ? `${pad(want.m)}/${pad(want.d)}/${want.y}`
          : format === 'dmy'
            ? `${pad(want.d)}/${pad(want.m)}/${want.y}`
            : `${want.y}-${pad(want.m)}-${pad(want.d)}`;
      setTextValue(el, written);
      // Commit: react-datepicker applies a typed date on blur/Enter, not on
      // every keystroke.
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.blur();

      const readBack = parseDateParts(el.value);
      if (!readBack) continue;
      // Echoed back unchanged: the widget accepted the string as written, so
      // the format we chose is the one it reads in.
      if (el.value.trim() === written) return true;
      // Reformatted: now it has told us its own order, and that rendering
      // must still be the same calendar day.
      if (sameDay(readBack, want)) return true;
      if (readBack.m === undefined) {
        const asMdy = { y: readBack.y, m: readBack.first, d: readBack.second };
        const asDmy = { y: readBack.y, m: readBack.second, d: readBack.first };
        if (sameDay(asMdy, want) || sameDay(asDmy, want)) return true;
      }
    }

    setTextValue(el, '');
    return false;
  }

  function setFileValue(el, file) {
    if (!file) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    // Read BEFORE the events. Workday's uploader takes the file inside its
    // change handler and clears the input, so checking afterwards reported a
    // successful upload as "set it manually" (verified live — the page showed
    // "Successfully Uploaded!" beside that message).
    const accepted = el.files.length === 1;
    fireInputEvents(el);
    return accepted;
  }

  /**
   * Applies one planned fill. `plan` is an entry from matcher.scanForm's
   * `fills`, optionally with `file` (a File) for the résumé input.
   * Returns { ok, reason }.
   */
  // Async because a combobox fill has to wait for the widget's menu to render.
  // Every other control type resolves immediately.
  async function applyFill(plan, adapter) {
    const el = plan.el;
    // Same vouch the matcher used when it planned this fill, re-derived rather
    // than carried on the plan: the guard must reach its own verdict at write
    // time, from the adapter, not from whatever the plan claims. It can waive
    // only 'presentational' (see guards.blockReason).
    const vouchedReal = Boolean(adapter && adapter.isRealControl && adapter.isRealControl(el));
    const blocked = guards.blockReason(plan.label, el, { vouchedReal });
    if (blocked) return { ok: false, reason: blocked };

    const tag = el.tagName.toLowerCase();
    const type = (el.type || '').toLowerCase();

    try {
      if (type === 'file') return { ok: setFileValue(el, plan.file), reason: 'file' };
      if (isListboxButton(el)) {
        return { ok: await setListboxButtonValue(el, plan.value, { field: plan.field }), reason: 'listbox' };
      }
      if (adapter && adapter.commitOnBlur && (tag === 'input' || tag === 'textarea') && !isCombobox(el) &&
          !matcher.isDateControl(el) && type !== 'radio' && type !== 'checkbox') {
        // Workday validates and keeps a typed value on blur, not on input —
        // an input event alone left the field reading empty to the next step.
        el.focus();
        const ok = setTextValue(el, String(plan.value ?? ''));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        el.blur();
        return { ok: ok && el.value.length > 0, reason: 'text' };
      }
      if (isCombobox(el)) {
        return { ok: await setComboboxValue(el, plan.value, { field: plan.field }), reason: 'combobox' };
      }
      if (matcher.isDateControl(el)) return { ok: setDateValue(el, plan.value), reason: 'date' };
      if (tag === 'select') return { ok: setSelectValue(el, plan.value), reason: 'select' };
      if (type === 'radio' || type === 'checkbox') return { ok: setChoiceValue(el, plan.value, adapter), reason: 'choice' };
      return { ok: setTextValue(el, String(plan.value ?? '')), reason: 'text' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // Sequential, not Promise.all: two comboboxes filled at once fight over the
  // page's single open menu.
  async function applyAll(plans, adapter) {
    const results = [];
    for (const plan of plans) results.push({ plan, result: await applyFill(plan, adapter) });
    return results;
  }

  return {
    applyFill,
    applyAll,
    isCombobox,
    optionTextMatches,
    locationOptionMatches,
    setTextValue,
    setSelectValue,
    setChoiceValue,
    setComboboxValue,
    isListboxButton,
    isPlaceholderOption,
    setListboxButtonValue,
    setDateValue,
    setFileValue,
    visibleOptions,
    readComboboxOptions,
    harvestComboboxOptions,
    groupMembers,
  };
});
