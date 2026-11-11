// matcher.js — the DOM label-matching engine (spec §15 session 28).
//
// Walks a form's controls, derives the best available human label for each,
// and decides what (if anything) belongs in it. Zero AI, zero network: every
// decision here is deterministic string work against fieldMap's synonym list
// and the answer bank the background worker already fetched.
//
// Deliberately platform-agnostic. Sessions 29–32 add adapters that supply
// container selectors and URL parsing; none of them should need to touch this
// file, which is the whole point of building the core first.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./normalizeQuestion').normalizeQuestion,
      require('./fieldMap').MATCH_FIELDS,
      require('./guards')
    );
  } else {
    root.CareerOSAutofillMatcher = factory(
      root.CareerOSAutofillNormalize.normalizeQuestion,
      root.CareerOSAutofillFieldMap.MATCH_FIELDS,
      root.CareerOSAutofillGuards
    );
  }
})(typeof self !== 'undefined' ? self : this, function (normalizeQuestion, MATCH_FIELDS, guards) {
  // ---------------------------------------------------------------------
  // Label derivation — in confidence order. The first source that yields
  // real text wins; nothing is concatenated, because merging a placeholder
  // into a label reliably produces phrases that match the wrong synonym.
  // ---------------------------------------------------------------------
  function labelFor(el, doc, adapter) {
    const d = doc || el.ownerDocument || document;

    // The adapter gets first say, for the same reason fieldHint does: a
    // platform knows its own question markup better than any generic
    // heuristic can. Lever needs this and is not an edge case — its custom
    // questions have NO <label> element anywhere (the question text sits in a
    // sibling div), so the cascade below would fall through to the `name`
    // attribute and key the answer bank on "cards uuid field0"; and each
    // multiple-choice option IS wrapped in a <label> reading just "Yes", so
    // the wrapping-label rule would name the question after one of its own
    // answers. Returning nothing falls through to the cascade unchanged.
    if (adapter && typeof adapter.labelFor === 'function') {
      let adapterLabel = null;
      try {
        adapterLabel = adapter.labelFor(el);
      } catch {
        adapterLabel = null;
      }
      if (adapterLabel && String(adapterLabel).trim()) return String(adapterLabel).trim();
    }

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => d.getElementById(id))
        .filter(Boolean)
        .map((n) => n.innerText || n.textContent || '')
        .join(' ')
        .trim();
      if (text) return text;
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    if (el.id) {
      // CSS.escape guards ids containing '.', ':' etc., which Greenhouse's
      // question ids do use.
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
      const explicit = d.querySelector(`label[for="${escaped}"]`);
      if (explicit) {
        const text = (explicit.innerText || explicit.textContent || '').trim();
        if (text) return text;
      }
    }

    const wrapping = el.closest('label');
    if (wrapping) {
      const text = (wrapping.innerText || wrapping.textContent || '').trim();
      if (text) return text;
    }

    // A labelled container (fieldset/legend, or the platform's own question
    // wrapper) — used by radio/checkbox groups, which have no per-input label
    // worth matching on.
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) {
        const text = (legend.innerText || legend.textContent || '').trim();
        if (text) return text;
      }
    }

    // Last resorts, weakest first: these are frequently decorative.
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();

    const name = el.getAttribute('name');
    if (name) return name.replace(/[_\-.[\]]+/g, ' ').trim();

    return '';
  }

  // ---------------------------------------------------------------------
  // Standard-field scoring. Exact normalized equality is the strong signal;
  // containment is accepted only when the alias is a substantial part of the
  // label, which is what stops "name" matching "what is the name of your
  // current manager".
  // ---------------------------------------------------------------------
  function scoreAlias(normalizedLabel, alias) {
    if (!normalizedLabel) return 0;
    if (normalizedLabel === alias) return 1;
    if (normalizedLabel.startsWith(alias + ' ')) return 0.85;
    if (normalizedLabel.endsWith(' ' + alias)) return 0.8;
    if (normalizedLabel.includes(' ' + alias + ' ')) return 0.7;
    // Substring hit that isn't word-aligned is too weak to act on.
    return 0;
  }

  const CONFIDENCE_THRESHOLD = 0.7;

  // A widget's own placeholder text, standing where a question's label should
  // be (see scanForm). Whole-label only: "Select your preferred office" is a
  // real question and is not matched.
  const PLACEHOLDER_LABEL_RE =
    /^(select( one| an option)?|choose( one| an option)?|please select|search)[\s.…]*(required)?[\s*]*$/i;

  // A standard field carries a VALUE we hold — a name, a URL, a number, a
  // file. A radio/checkbox answers with a choice among the page's own options
  // instead, so no profile value belongs in one however well its label scores.
  //
  // Found live on a real Ashby form: "Are you legally authorized to work in
  // the LOCATION where this role is based?" is a Yes/No question, and the
  // word-aligned containment tier scored it as the location field — which
  // both proposed writing "Boston" into a checkbox and, worse, consumed the
  // question so it was never offered to the user at all. fieldMap has always
  // documented its `type` as "used to skip obviously wrong controls"; this is
  // where that finally happens. Adapter hints are exempt: a platform naming
  // its own field outranks a type heuristic.
  function fieldTypeAllows(fieldType, el) {
    const controlType = String((el && (el.type || (el.getAttribute && el.getAttribute('type')))) || 'text').toLowerCase();
    const isChoice = controlType === 'radio' || controlType === 'checkbox';
    const isFile = controlType === 'file';
    if (fieldType === 'file') return isFile;
    return !isChoice && !isFile;
  }

  function matchStandardField(label) {
    const n = normalizeQuestion(label);
    if (!n) return null;

    // Two label shapes are a standard field only by an EXACT match, never by
    // containment. A follow-up question ("If Yes, please provide details
    // (Where/When/Job Title):") names a field word but asks about something
    // else; and a label joining two things ("Highschool Name & Location:",
    // "Supervisor Name & Title:") is not the one thing its last word names.
    // Both were filled from the profile on a real Workable form.
    const containmentAllowed = !/^if\b/.test(n) && !/&/.test(String(label || ''));

    let best = null;
    for (const field of MATCH_FIELDS) {
      if (field.exclude.some((bad) => n.includes(bad))) continue;
      const strict = field.strict || [];
      for (const alias of field.aliases) {
        const score = scoreAlias(n, alias);
        // A strict alias is one broad enough to appear inside an unrelated
        // question ("name", "company", "title"). It only counts when it IS
        // the whole label, never when it's merely contained in one.
        if (strict.includes(alias) && score !== 1) continue;
        if (score !== 1 && !containmentAllowed) continue;
        if (score >= CONFIDENCE_THRESHOLD && (!best || score > best.score)) {
          best = { key: field.key, score, alias, type: field.type };
        }
      }
      // A field earlier in MATCH_FIELDS that matched exactly wins outright —
      // no need to let a broader later field tie it.
      if (best && best.score === 1) break;
    }
    return best;
  }

  // ---------------------------------------------------------------------
  // The scan. Returns a plan the review panel renders; NOTHING is written to
  // the page here — planning and filling are separate on purpose, so the
  // preview the user approves is exactly what gets applied.
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // A phone field that has its own country selector must not also be given
  // the country code.
  //
  // The stored profile number carries one ("+1 4155550100"), which is right
  // for a résumé header and right for a lone phone box. Greenhouse's form
  // splits them: a "Country" dropdown already showing "+1" sits beside the
  // Phone field, so filling the whole number produced "+1 415-555-0100"
  // against a +1 the form had already set — reported live.
  //
  // Detected from what the page SHOWS rather than from ids or class names, so
  // it holds on a platform whose markup we have not seen: a dial code is a
  // visible "+<digits>" sitting next to another control near this input. An
  // input's value is not text content, so the phone box's own contents can
  // never be mistaken for the neighbouring selector's.
  // ---------------------------------------------------------------------
  const DIAL_CODE_RE = /(^|[^\d+])\+\d{1,4}([^\d]|$)/;

  // Returns the sibling control itself (a real DOM node), not just whether one
  // exists — phoneForField only ever needed the boolean, but filling the
  // selector's own VALUE (below) needs the element to plan a fill against.
  // Prefers a select/combobox over a stray text input among the candidates:
  // a calling-code picker is always one of those, never free text.
  function findDialCodeControl(el) {
    if (!el) return null;
    let node = el.parentElement;
    for (let climbed = 0; node && climbed < 4; climbed += 1) {
      const others = typeof node.querySelectorAll === 'function'
        ? Array.from(node.querySelectorAll('input, select, [role="combobox"]')).filter((c) => c !== el)
        : [];
      if (others.length && DIAL_CODE_RE.test(node.innerText || node.textContent || '')) {
        return (
          others.find(
            (c) => c.tagName.toLowerCase() === 'select' || (c.getAttribute && c.getAttribute('role') === 'combobox')
          ) || others[0]
        );
      }
      node = node.parentElement;
    }
    return null;
  }

  function hasSeparateDialCode(el) {
    return Boolean(findDialCodeControl(el));
  }

  function phoneForField(value, el) {
    if (!hasSeparateDialCode(el)) return value;
    // Only whitespace/dots/dashes separate the code from the number — never a
    // bracket, which belongs to the number that follows ("+971 (050) …").
    const parsed = String(value).trim().match(/^\+(\d{1,4})[\s.\-]*(.+)$/);
    if (!parsed) return value;
    const rest = parsed[2].replace(/^[\s.\-]+/, '');
    // Only strip when what remains is still a plausible number — never turn a
    // short or oddly-formatted entry into something shorter.
    return rest.replace(/\D/g, '').length >= 7 ? rest : value;
  }

  // ---------------------------------------------------------------------
  // The country the dial-code selector should be set TO — not the phone
  // number, a country name. Greenhouse's own list concatenates name and code
  // with no separator ("United States+1", "Afghanistan+93" — verified live),
  // which the ordinary word-boundary option matcher (filler.optionTextMatches)
  // already accepts without any special-casing: "united states" is a bounded
  // match inside "united states+1" because '+' is non-alphanumeric.
  //
  // Deliberately conservative. A code assigned to exactly one common country
  // is used outright. "+1" is NANP — shared by the US, Canada and ~20
  // Caribbean/Pacific territories — so it resolves to United States only when
  // the profile's own location corroborates it (a US state abbreviation);
  // otherwise this returns null and the selector is left as an ordinary
  // question rather than guessing among two dozen countries.
  //
  // Not exhaustive on purpose: every code left out here simply falls through
  // to "no fill", which is exactly today's (safe) behaviour. Extend the map
  // as real users hit it, never by guessing ahead of evidence.
  // ---------------------------------------------------------------------
  const CALLING_CODE_COUNTRY = {
    44: 'United Kingdom', 91: 'India', 61: 'Australia', 49: 'Germany',
    33: 'France', 39: 'Italy', 34: 'Spain', 31: 'Netherlands',
    971: 'United Arab Emirates', 65: 'Singapore', 86: 'China', 81: 'Japan',
    82: 'South Korea', 52: 'Mexico', 55: 'Brazil', 27: 'South Africa',
    64: 'New Zealand', 353: 'Ireland', 41: 'Switzerland', 46: 'Sweden',
    47: 'Norway', 45: 'Denmark', 48: 'Poland', 966: 'Saudi Arabia',
    92: 'Pakistan', 880: 'Bangladesh', 84: 'Vietnam', 63: 'Philippines',
    62: 'Indonesia', 20: 'Egypt', 234: 'Nigeria', 254: 'Kenya',
  };

  // The same 50-state-plus-DC-and-Puerto-Rico set filler.js keeps for
  // location option matching (§17.4) — duplicated rather than shared,
  // because filler.js REQUIRES this module and matcher.js cannot require it
  // back. Narrow use here: only "does this location corroborate the US",
  // never a full address parse.
  const US_STATE_ABBR = new Set([
    'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id',
    'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms',
    'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok',
    'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv',
    'wi', 'wy', 'dc', 'pr',
  ]);

  function looksLikeUsLocation(location) {
    const segments = String(location || '')
      .split(',')
      .map((s) => s.trim());
    const last = segments[segments.length - 1] || '';
    return US_STATE_ABBR.has(last.toLowerCase());
  }

  function countryForDialCode(code, location) {
    if (code === '1') return looksLikeUsLocation(location) ? 'United States' : null;
    return CALLING_CODE_COUNTRY[code] || null;
  }

  function isFillableControl(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag !== 'input') return false;
    const type = (el.type || 'text').toLowerCase();
    return ['text', 'email', 'tel', 'url', 'number', 'search', 'file', 'radio', 'checkbox', 'date'].includes(type);
  }

  // Radio/checkbox groups are planned once per group, not once per option —
  // the answer is which option to pick, not a value per input.
  //
  // `name` is the usual group identity but not a universal one, and the
  // failure is loud when it doesn't hold: Ashby gives each checkbox of a
  // multi-select question the option TEXT as its name, so "How did you hear
  // about us?" was planned nine times, each rendering a one-option dropdown
  // (verified live). An adapter that knows its own grouping says so.
  function groupIdentity(el, adapter) {
    if (adapter && typeof adapter.groupIdentity === 'function') {
      try {
        const id = adapter.groupIdentity(el);
        if (id) return String(id);
      } catch {
        /* fall through */
      }
    }
    return el.name || labelFor(el, null, adapter);
  }

  function groupKey(el, adapter) {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio' || type === 'checkbox') return `${type}:${groupIdentity(el, adapter)}`;
    return null;
  }

  /**
   * @param {Document|Element} scope   form/container to scan
   * @param {Object} profile          from GET /api/autofill/profile
   * @param {Object} answersByKey     normalizedQuestion -> answer row
   * @returns {{fills: Array, questions: Array, blocked: Array}}
   */
  // `scope` may be several containers. Ashby splits one application across two
  // sibling .ashby-application-form-container elements — the questions in the
  // first, the whole U.S. EEO section (gender, race, veteran status) in the
  // second — so a single querySelector found 23 of the form's 37 controls and
  // the self-identification questions were never offered at all (verified
  // live). Widening to a common ancestor instead would drag in Ashby's own
  // résumé-parsing file input, which sits outside both and is not ours.
  function scanForm(scope, profile, answersByKey, adapter) {
    const scopes = (Array.isArray(scope) ? scope : [scope]).filter(Boolean);
    const doc = (scopes[0] && (scopes[0].ownerDocument || scopes[0])) || document;
    const seenControls = new Set();
    const controls = [];
    for (const container of scopes) {
      for (const el of container.querySelectorAll('input, textarea, select')) {
        if (seenControls.has(el) || !isFillableControl(el)) continue;
        seenControls.add(el);
        controls.push(el);
      }
      // Controls the query above cannot see, named by the adapter. Workday's
      // dropdowns are <button aria-haspopup="listbox"> elements, not inputs —
      // "How Did You Hear About Us?", Phone Device Type and State were simply
      // absent from the plan without this (verified live, 23andMe). An adapter
      // names them; the guards below still run on every one.
      if (adapter && typeof adapter.extraControls === 'function') {
        let extra = [];
        try {
          extra = adapter.extraControls(container) || [];
        } catch {
          extra = [];
        }
        for (const el of extra) {
          if (!el || seenControls.has(el)) continue;
          seenControls.add(el);
          controls.push(el);
        }
      }
    }

    const fills = [];
    const questions = [];
    const blocked = [];
    const seenGroups = new Set();

    for (const el of controls) {
      const label = labelFor(el, doc, adapter);
      const normalized = normalizeQuestion(label);

      // Group dedupe runs BEFORE the guard so a blocked group is reported
      // once, not once per option: Lever's pronoun question is twelve
      // checkboxes sharing one name, which otherwise reads as twelve blocked
      // fields in the panel's count.
      const gk = groupKey(el, adapter);
      if (gk) {
        if (seenGroups.has(gk)) continue;
        seenGroups.add(gk);
      }

      // A "label" that is only the widget's own placeholder names no question.
      // Workday's Application Questions fell back to " Select One Required"
      // for three different questions, and Greenhouse's Country once read
      // "Search". Offered as questions they would share one answer-bank key,
      // and the answer to one would be replayed into the others — so they are
      // left for the user instead. An adapter that can read the real question
      // (Workday's legend rich text) never reaches this.
      // A control the adapter names is identified by the adapter, not by its
      // label — Greenhouse's id="country" reads "Search" and is still ours.
      const hintedByAdapter = Boolean(adapter && adapter.fieldHint && adapter.fieldHint(el));
      if (!hintedByAdapter && PLACEHOLDER_LABEL_RE.test(String(label || '').trim())) {
        blocked.push({ label, reason: 'unlabelled', el });
        continue;
      }

      // An adapter may vouch that a control the presentational heuristic would
      // drop is the real thing — Ashby's Yes/No answer lives on a hidden
      // tabindex="-1" checkbox. guards.blockReason decides what that vouch is
      // allowed to waive (only 'presentational'), never the adapter.
      const vouchedReal = Boolean(adapter && adapter.isRealControl && adapter.isRealControl(el));
      const reason = guards.blockReason(label, el, { vouchedReal });
      if (reason) {
        blocked.push({ label, reason, el });
        continue;
      }

      // A voluntary self-identification field (gender, race, veteran,
      // disability, pronouns). It is NOT blocked — the user answers it once
      // from the form's own options and that answer is reused afterwards —
      // but nothing may reach it except an answer the user picked
      // themselves: no profile value, no adapter hint, no AI draft. Skipping
      // the standard-field branch below is what enforces that.
      const selfIdentification = guards.isSelfIdentificationField(label, el);

      // 1. A standard field we can fill straight from the profile. The
      //    adapter gets first say: a platform that gives its fields stable
      //    ids knows better than any label heuristic (Greenhouse labels BOTH
      //    file inputs "Attach"), and can also mark a control as deliberately
      //    not ours to touch.
      const hint = adapter && adapter.fieldHint ? adapter.fieldHint(el) : null;
      if (hint === 'skip') {
        blocked.push({ label, reason: 'out_of_scope', el });
        continue;
      }
      // A self-identification control takes no profile value and no adapter
      // field mapping — only an answer the user gave before (step 2) or gives
      // now (step 3). The 'skip' hint above still applies to it.
      const labelMatch = selfIdentification || hint ? null : matchStandardField(label);
      const std = selfIdentification
        ? null
        : hint
          ? { key: hint, score: 1, alias: `adapter:${hint}`, type: null }
          : labelMatch && fieldTypeAllows(labelMatch.type, el)
            ? labelMatch
            : null;
      if (std) {
        const value = profileValue(profile, std.key);
        if (std.key === 'resumeFile') {
          if ((el.type || '').toLowerCase() === 'file') {
            fills.push({ el, label, field: std.key, source: 'resume', value: null, confidence: std.score });
            continue;
          }
        } else if (std.key === 'coverLetterFile') {
          // Planned unconditionally here — the caller (contentScript.js)
          // knows whether a cover letter actually exists for this job and
          // drops this fill afterward if not, since there's no master
          // fallback for it the way there is for résumés.
          if ((el.type || '').toLowerCase() === 'file') {
            fills.push({ el, label, field: std.key, source: 'coverLetter', value: null, confidence: std.score });
            continue;
          }
        } else if (value !== null && value !== undefined && value !== '') {
          // A label that is exactly "City" asks for the city alone, not the
          // stored "City, ST" location it matches through fieldMap's alias —
          // Workable's City took "San Jose, CA" (verified live).
          // Exact only: "In what City, State and Zip are you currently residing?"
          // contains the same alias and wants the whole location (Greenhouse, live).
          const cityOnly =
            std.key === 'location' && std.alias === 'city' && std.score === 1 ? profileValue(profile, 'city') : null;
          const adapted = std.key === 'phone' ? phoneForField(value, el) : cityOnly || value;
          fills.push({ el, label, field: std.key, source: 'profile', value: adapted, confidence: std.score });
          continue;
        }
      }

      // An upload nothing above claimed. A file cannot be answered by typing,
      // and a typed "answer" would join the answer bank as text, replayed into
      // some later form's upload — so it is left for the user, visibly.
      // Workable's "Please upload any relevant certifications:" was offered
      // as a text box (verified live).
      if ((el.type || '').toLowerCase() === 'file') {
        blocked.push({ label, reason: 'out_of_scope', el });
        continue;
      }

      // 2. A custom question we've already answered before, anywhere.
      const known = normalized && answersByKey ? answersByKey[normalized] : null;
      if (known) {
        fills.push({
          el,
          label,
          field: null,
          source: 'answer_bank',
          value: known.answer_text,
          questionNormalized: normalized,
          selfIdentification,
          confidence: 1,
        });
        continue;
      }

      // 3. Anything else with a real question attached: surfaced for one-time
      //    user input (§28's deliverable), never guessed.
      if (normalized) {
        questions.push({
          el,
          label,
          questionNormalized: normalized,
          inputType: controlType(el, adapter),
          options: optionsFor(el, adapter),
          selfIdentification,
        });
      }
    }

    return { fills, questions, blocked };
  }

  // A date control that isn't <input type="date">. Ashby renders "What is your
  // earliest available start date?" as react-datepicker: a plain text input
  // inside .react-datepicker-wrapper. Asking for it as free text is how a
  // typed string reaches a widget that parses it — and writing an ISO date
  // into that one silently lands a day early (verified live: "2026-10-01"
  // became 09/30/2026). Treating it as a date makes the panel offer a real
  // date picker and routes the write through filler.setDateValue, which
  // verifies what the widget actually kept.
  const DATE_WRAPPER_SELECTOR = '.react-datepicker-wrapper, .react-datepicker__input-container';
  const DATE_CLASS_RE = /(^|[\s_-])date($|[\s_-])|input-date|datepicker/i;

  function isDateControl(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName.toLowerCase() !== 'input') return false;
    const type = String(el.type || el.getAttribute('type') || '').toLowerCase();
    if (type === 'date') return true;
    if (type && type !== 'text') return false;
    if (el.closest && el.closest(DATE_WRAPPER_SELECTOR)) return true;
    if (DATE_CLASS_RE.test(String(el.className || ''))) return true;
    // A placeholder that spells out a date format is the widget saying what it
    // is. Workable's "When would you be available to begin work?" is a plain
    // text input with placeholder "MM/DD/YYYY" and no date class anywhere
    // (verified live) — as free text it would take whatever the user typed.
    const placeholder = String((el.getAttribute && el.getAttribute('placeholder')) || '').trim();
    return DATE_PLACEHOLDER_RE.test(placeholder);
  }

  const DATE_PLACEHOLDER_RE = /^(mm|dd)\s*[/.-]\s*(dd|mm)\s*[/.-]\s*yyyy$|^yyyy\s*[/.-]\s*mm\s*[/.-]\s*dd$/i;

  function isListboxButton(el) {
    return Boolean(
      el && el.tagName && el.tagName.toLowerCase() === 'button' &&
      String((el.getAttribute && el.getAttribute('aria-haspopup')) || '').toLowerCase() === 'listbox'
    );
  }

  function controlType(el, adapter) {
    const tag = el.tagName.toLowerCase();
    if (el.getAttribute && el.getAttribute('role') === 'combobox') return 'combobox';
    // Workday's dropdowns (see scanForm's extraControls): answered from the
    // list's own options, exactly like a combobox, so offered as one.
    if (isListboxButton(el)) return 'combobox';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (isDateControl(el)) return 'date';
    const type = (el.type || 'text').toLowerCase();
    if (type === 'radio' || type === 'checkbox') {
      // A yes/no group is the common case and stays 'boolean' (the panel
      // renders its own Yes/No picker for it). A group with real options —
      // Lever renders multiple-choice questions as radio groups, verified
      // live — reports as a select so the panel offers those exact options
      // instead of a free-text box the user has to re-type an option into.
      const options = groupOptions(el, adapter);
      if (options && options.length && !isYesNoOptions(options)) return 'select';
      return 'boolean';
    }
    if (type === 'number') return 'number';
    if (type === 'file') return 'file';
    return 'text';
  }

  function isYesNoOptions(options) {
    const set = new Set(options.map((o) => o.trim().toLowerCase()));
    if (set.size > 2) return false;
    for (const value of set) if (value !== 'yes' && value !== 'no') return false;
    return true;
  }

  // The option texts of a radio/checkbox group, read from each input's own
  // label (or its value attribute when it has none). filler.setChoiceValue
  // matches on either of those same two sources, so whatever is shown in the
  // panel is exactly what can be clicked.
  //
  // An adapter gets first say, because a platform can put the options
  // somewhere no generic DOM walk would find them: Ashby's Yes/No answer is
  // two <button data-option> siblings of a hidden checkbox, whose own only
  // readable "option" is the default value attribute, "on". The adapter
  // returns [{text, node}]; filler.setChoiceValue clicks the very same nodes,
  // so what the panel shows is exactly what can be picked.
  function adapterChoiceOptions(el, adapter) {
    if (!adapter || typeof adapter.choiceOptions !== 'function') return null;
    let options = null;
    try {
      options = adapter.choiceOptions(el);
    } catch {
      return null;
    }
    if (!Array.isArray(options) || !options.length) return null;
    return options;
  }

  function groupOptions(el, adapter) {
    const fromAdapter = adapterChoiceOptions(el, adapter);
    if (fromAdapter) {
      const texts = fromAdapter.map((o) => String(o.text || '').trim()).filter(Boolean);
      if (texts.length) return texts;
    }
    const type = (el.type || '').toLowerCase();
    if (type !== 'radio' && type !== 'checkbox') return null;
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const name = el.getAttribute ? el.getAttribute('name') : null;
    let group = null;
    if (adapter && typeof adapter.groupMembers === 'function') {
      try {
        const members = adapter.groupMembers(el);
        if (Array.isArray(members) && members.length) group = members;
      } catch {
        group = null;
      }
    }
    if (!group) group = [el];
    if (group.length === 1 && doc && name && typeof doc.querySelectorAll === 'function') {
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(name) : name;
      const found = Array.from(doc.querySelectorAll(`input[name="${escaped}"]`));
      if (found.length) group = found;
    }
    const texts = group
      .map((option) => {
        const fromLabel =
          (option.labels && option.labels[0] && (option.labels[0].innerText || option.labels[0].textContent)) || '';
        return (fromLabel || option.value || '').trim();
      })
      .filter(Boolean);
    return texts.length ? texts : null;
  }

  function optionsFor(el, adapter) {
    if (el.tagName.toLowerCase() === 'select') {
      const all = Array.from(el.options);
      // A placeholder row ("Select ...") is an option with an empty value: it
      // submits nothing, so offering it as an answer is offering a no-op.
      // Kept only if dropping it would leave nothing at all.
      const real = all.filter((o) => String(o.value ?? '').trim() !== '');
      return (real.length ? real : all).map((o) => o.text.trim()).filter(Boolean);
    }
    return groupOptions(el, adapter);
  }

  // The profile shape is fixed by GET /api/autofill/profile; splitting
  // fullName here rather than server-side keeps the API honest about what it
  // actually stores (one contact_name field).
  function profileValue(profile, key) {
    if (!profile) return null;
    if (key === 'firstName') return splitName(profile.fullName).first;
    if (key === 'lastName') return splitName(profile.fullName).last;
    // The value for Greenhouse's phone-adjacent Country selector (its
    // fieldHint maps id="country" to this key — see the adapter). Derived,
    // never stored: a country NAME, computed from the same dial code
    // phoneForField already reads off profile.phone, corroborated by
    // profile.location for NANP's "+1". Returns null when it can't be
    // derived confidently, which falls through to today's safe behaviour —
    // the control is left as an ordinary question the user answers once.
    // A form that asks for the city on its own (Workday's City). Derived from
    // the one stored location — its first comma segment — never stored apart
    // from it, so the two cannot drift.
    if (key === 'city') {
      const city = String(profile.location || '').split(',')[0].trim();
      return city || null;
    }
    if (key === 'phoneCountryCode') {
      const m = String(profile.phone || '').trim().match(/^\+(\d{1,4})/);
      return m ? countryForDialCode(m[1], profile.location) : null;
    }
    return profile[key] ?? null;
  }

  function splitName(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: '', last: '' };
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  return {
    labelFor,
    matchStandardField,
    scanForm,
    controlType,
    isDateControl,
    phoneForField,
    findDialCodeControl,
    countryForDialCode,
    groupIdentity,
    optionsFor,
    splitName,
    profileValue,
    CONFIDENCE_THRESHOLD,
  };
});
