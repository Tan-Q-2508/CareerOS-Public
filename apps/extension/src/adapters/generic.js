// generic.js — the adapter of last resort, for a company that runs its own
// application system (spec §15 session 57, §17.2).
//
// Greenhouse, Lever and Ashby each get a real adapter because we know their
// markup. Meta, Google, Amazon and every company with a hand-built careers
// page do not, and there is no version of this feature that enumerates them:
// there are thousands, and each one redesigns on its own schedule.
//
// What makes a generic adapter possible at all is that the ENGINE was never
// platform-specific. core/matcher.js matches on the visible label next to a
// control, and core/guards.js blocks on what a control IS (a submit, a
// consent, a password, a sensitive field), neither of which needs to know the
// vendor. A platform adapter supplies exactly two things the engine can't
// infer: where the form is, and how to read a label when the page's markup
// doesn't say. This file supplies generic answers to both, and nothing else.
//
// It is NEVER injected by a manifest match — only by the toolbar button, on a
// page the user is already looking at and has chosen to act on. That is the
// whole reason it is allowed to be this speculative: a wrong guess here
// surfaces as a row in the review panel that the user unticks, not as a value
// written into a page they never asked us to touch.
//
// Deliberately weaker than a real adapter, and the differences are the point:
//   - no `fieldHint`, so a file input is matched by its label like anything
//     else rather than by a known id. A page with two unlabelled uploads gets
//     neither, instead of getting them backwards (which is how a recruiter
//     receives a cover letter as a résumé).
//   - no `choiceOptions`/`isRealControl`. A custom widget that hides its real
//     control behind a `tabindex="-1"` shim stays blocked as presentational.
//     Vouching for a control is a claim about markup we have not seen.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillGeneric = factory();
    root.CareerOSAutofillAdapter = root.CareerOSAutofillGeneric;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const CONTROL_SELECTOR = 'input, textarea, select';

  // Types that are never a question: the page's own chrome, or a control the
  // engine would refuse anyway. Excluded HERE as well as in guards.js because
  // these also must not influence WHERE the form is judged to be — one search
  // box in a site header is enough to drag the container up to <body>.
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'search']);

  // A form worth offering to fill. Four is low enough for a short "apply with
  // your details" page and high enough to rule out a login (2), a newsletter
  // signup (1-2) and a site search (1).
  const MIN_CONTROLS = 4;

  // Above this, the text found near a control is a paragraph — a consent
  // notice, a job description, an EEO preamble — not a field label. Returning
  // it would key an answer-bank entry on an essay.
  const MAX_LABEL_CHARS = 180;

  // How far up from a control to look for its label before giving up. Eight
  // is not a round number — it is what Meta's real form needs: a location
  // checkbox sits seven wrappers below the text that names the question
  // (input → div → label → div → listitem → list → div → div). Six looked
  // generous in the abstract and silently returned nothing there.
  const MAX_CLIMB = 8;

  // A group label the page technically provides but which cannot identify a
  // question on its own. These matter more than they look: a label becomes the
  // ANSWER BANK's key (§17.3), so storing an answer under "please select an
  // option" would hand that answer to an unrelated question on the next
  // company's form. Where one of these is found, it gets qualified by the
  // nearest heading above it ("Disability — Please select an option:").
  const VAGUE_LABEL_RE = /^(please\s+)?(select|choose|pick|indicate)(\s+(an?|one))?(\s+(option|answer|value|below))?[\s:.*]*$/i;
  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';
  const SHORT_HEADING_CHARS = 60;

  function isVisible(el) {
    if (!el) return false;
    // offsetParent is null for display:none and for position:fixed elements,
    // hence the rect fallback — a fixed-position field is unusual but real.
    if (el.offsetParent !== null) return true;
    return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
  }

  function isCandidate(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (SKIP_TYPES.has(type)) return false;
    }
    // A file input is routinely hidden behind a styled label and out of the
    // tab order — that IS the ordinary way to render an upload (§17.5), so it
    // counts even when it fails the visibility test.
    if (tag === 'input' && (el.type || '').toLowerCase() === 'file') return true;
    if (el.closest('[role="search"], form[role="search"]')) return false;
    return isVisible(el);
  }

  function candidateControls(doc) {
    return Array.from(doc.querySelectorAll(CONTROL_SELECTOR)).filter(isCandidate);
  }

  // ---------------------------------------------------------------------
  // Where the form is.
  //
  // An arbitrary page has no `#application-form` to look for, so the form is
  // located by where the fields CLUSTER: count how many candidate controls
  // each ancestor contains, then take the DEEPEST ancestor that still holds
  // essentially all of them.
  //
  // "Deepest that holds essentially all" rather than simply "holds the most",
  // because <body> always holds the most — it contains every field plus the
  // site's header search box and footer newsletter signup. Picking the maximum
  // therefore always returns the whole page, which is how the first version of
  // this failed against a real fixture. Requiring RETAIN of the maximum lets a
  // tighter container win while a handful of chrome controls sit outside it,
  // and lets <body> win legitimately when an application is genuinely split
  // across sibling containers (Ashby does exactly that with its EEO section,
  // §17.2) rather than silently scanning only half of it.
  const RETAIN = 0.75;

  function domDepth(node) {
    let depth = 0;
    let current = node;
    while (current.parentElement) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function findForm(doc) {
    const d = doc || document;
    const controls = candidateControls(d);
    if (controls.length < MIN_CONTROLS) return null;

    const counts = new Map();
    for (const control of controls) {
      let node = control.parentElement;
      while (node) {
        counts.set(node, (counts.get(node) || 0) + 1);
        node = node.parentElement;
      }
    }

    let maxCount = 0;
    for (const count of counts.values()) if (count > maxCount) maxCount = count;
    const floor = Math.max(MIN_CONTROLS, Math.ceil(maxCount * RETAIN));

    let best = null;
    let bestDepth = -1;
    for (const [node, count] of counts) {
      if (count < floor) continue;
      const depth = domDepth(node);
      if (depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
    }

    if (!best) return null;

    // A cluster of four text boxes is also what a login-plus-newsletter page
    // looks like. Requiring one control that only an application asks for
    // keeps the button honest about pages it cannot actually help with.
    const looksLikeApplication = Array.from(best.querySelectorAll(CONTROL_SELECTOR)).some((el) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      return tag === 'textarea' || type === 'file' || type === 'email' || type === 'tel';
    });
    return looksLikeApplication ? best : null;
  }

  function collapse(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function controlsIn(node) {
    return node.querySelectorAll(CONTROL_SELECTOR).length;
  }

  // The visible text of `node` that comes BEFORE its first control, in
  // document order. This is what reads correctly for a choice group: the
  // question sits above its options, and taking the whole container's text
  // would return the question with all of its own answers appended to it.
  function textBeforeFirstControl(node) {
    const parts = [];
    let stopped = false;
    (function visit(current) {
      if (stopped) return;
      for (const child of current.childNodes || []) {
        if (stopped) return;
        if (child.nodeType === 3) {
          parts.push(child.nodeValue);
        } else if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            stopped = true;
            return;
          }
          visit(child);
        }
      }
    })(node);
    return collapse(parts.join(' '));
  }

  // ---------------------------------------------------------------------
  // How to read a label when the markup doesn't say.
  //
  // Meta's application form is the case this exists for: 38 controls, and not
  // one of them carries an id, a name, or an aria-label, so matcher.js's whole
  // cascade — aria-labelledby, aria-label, label[for], wrapping <label>,
  // fieldset/legend, placeholder, name — returns nothing at all. The text is
  // on the page; it is just in a sibling div, which is a shape no attribute
  // names.
  //
  // Returning null falls through to that cascade unchanged, so this only ever
  // adds labels where the page gave none.
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Which controls form one question.
  //
  // The engine's own fallback groups radios and checkboxes by `name`, which is
  // how HTML has always expressed it — and which Meta's form does not use at
  // all: not one of its 38 controls carries a name. Every option therefore
  // became its own single-option question. ARIA is what those pages use
  // instead, so that is what this reads. `role="list"` is included because a
  // multi-select genuinely renders that way (Meta's twelve office locations).
  // ---------------------------------------------------------------------
  const GROUP_SELECTOR = '[role="radiogroup"], [role="group"], [role="list"], fieldset';
  const groupIds = new WeakMap();
  let groupSeq = 0;

  function groupContainer(el) {
    return el && typeof el.closest === 'function' ? el.closest(GROUP_SELECTOR) : null;
  }

  // A synthetic id, held in a WeakMap rather than written onto the page: the
  // container may have no id of its own, and an application form is not ours
  // to add attributes to.
  function groupIdentity(el) {
    const container = groupContainer(el);
    if (!container) return null;
    if (!groupIds.has(container)) {
      groupSeq += 1;
      groupIds.set(container, `cos-group-${groupSeq}`);
    }
    // Radios and checkboxes inside one container are still different
    // questions, so the control type is part of the identity.
    return `${groupIds.get(container)}|${(el.type || '').toLowerCase()}`;
  }

  function groupMembers(el) {
    const container = groupContainer(el);
    if (!container) return null;
    const type = (el.type || '').toLowerCase();
    if (type !== 'radio' && type !== 'checkbox') return null;
    const members = Array.from(container.querySelectorAll('input')).filter(
      (option) => (option.type || '').toLowerCase() === type
    );
    return members.length ? members : null;
  }

  // The text of whatever names an ARIA group, when the page bothers to say.
  // Standard markup and far more reliable than any climb: Meta labels its
  // gender, race, veteran and disability questions exactly this way. Returns
  // '' when the group exists but names nothing — its `aria-labelledby` points
  // at an empty span, which the location list really does.
  function ariaGroupLabel(el) {
    const group = el.closest('[role="radiogroup"], [role="group"], fieldset');
    if (!group) return '';
    const direct = group.getAttribute('aria-label');
    if (direct && direct.trim()) return collapse(direct);
    const ids = group.getAttribute('aria-labelledby');
    if (!ids) return '';
    const doc = el.ownerDocument || document;
    return collapse(
      ids
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map((n) => n.innerText || n.textContent || '')
        .join(' ')
    );
  }

  // The nearest heading above `node`, searched by walking previous siblings
  // and then upwards — the reading order a person uses to work out which
  // section a vague question belongs to.
  function nearestHeadingAbove(node) {
    let current = node;
    for (let climbed = 0; current && climbed < MAX_CLIMB; climbed += 1) {
      let sibling = current.previousElementSibling;
      while (sibling) {
        const heading = sibling.matches(HEADING_SELECTOR)
          ? sibling
          : sibling.querySelector(HEADING_SELECTOR);
        if (heading) {
          const text = collapse(heading.innerText || heading.textContent);
          if (text && text.length <= MAX_LABEL_CHARS) return text;
        }
        // A real heading ELEMENT is preferred, but plenty of pages write one
        // as a styled span — Meta's "Disability" is exactly that, and taking
        // the <h2> above it instead would label a disability question "Self
        // ID". A short, control-free sibling is the fallback: short, because
        // a paragraph is prose rather than a heading.
        if (!controlsIn(sibling)) {
          const text = collapse(sibling.innerText || sibling.textContent);
          if (text && text.length <= SHORT_HEADING_CHARS) return text;
        }
        sibling = sibling.previousElementSibling;
      }
      current = current.parentElement;
    }
    return '';
  }

  function qualify(label, el) {
    if (!label || !VAGUE_LABEL_RE.test(label)) return label;
    // Search from the GROUP outward, not from the control: the element that
    // holds a vague label is usually the group's own caption, sitting as a
    // sibling of the options. Starting at the control finds that caption again
    // and produces "Please select an option: — Please select an option:".
    const heading = nearestHeadingAbove(groupContainer(el) || el);
    if (!heading || VAGUE_LABEL_RE.test(heading) || heading === label) return label;
    const combined = `${heading} — ${label}`;
    return combined.length <= MAX_LABEL_CHARS ? combined : heading;
  }

  function labelFor(el) {
    if (!el || !el.parentElement) return null;
    const type = (el.type || '').toLowerCase();
    const grouped = type === 'radio' || type === 'checkbox';

    if (grouped) {
      const aria = ariaGroupLabel(el);
      if (aria) return qualify(aria, el);
    }

    let node = el.parentElement;
    for (let climbed = 0; node && climbed < MAX_CLIMB; climbed += 1) {
      const count = controlsIn(node);

      // A single-value field: the moment an ancestor holds a SECOND control we
      // have climbed out of this field's own row, and any text up here belongs
      // to the section, not to this box. Stop rather than mislabel.
      if (!grouped && count > 1) return null;

      const text = grouped ? textBeforeFirstControl(node) : collapse(node.innerText || node.textContent);
      if (text && text.length <= MAX_LABEL_CHARS) return qualify(text, el);

      node = node.parentElement;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Which CareerOS job this page is, if any.
  //
  // There is no vendor rule to apply, so this falls back to the one thing
  // custom career sites reliably share: a long numeric posting id somewhere in
  // the path. Meta carries the same 16-digit id on the job page
  // (/jobs/<id>/) and on the application (/profile/create_application/<id>/),
  // which is exactly what makes the match work.
  //
  // Seven digits is the floor deliberately. The server matches with
  // `link LIKE %<id>%` against the user's own jobs, so a short number would
  // eventually collide and attach the résumé written for a DIFFERENT job —
  // silently, since a résumé is a file the user does not re-read. A wrong
  // match is worse than no match, and no match is already a supported state
  // (it uses the master résumé, §28's rule). Kept in agreement with
  // apps/server/src/routes/autofill.js by test.
  // ---------------------------------------------------------------------
  function extractPostingId(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    const uuid = segments.find((part) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)
    );
    if (uuid) return uuid.toLowerCase();
    const numeric = segments.filter((part) => /^\d{7,}$/.test(part));
    // Several long numbers in one path is ambiguous, not a match.
    return numeric.length === 1 ? numeric[0] : null;
  }

  // No posting id required, unlike Greenhouse: on a custom site there is
  // nothing to require. Having a form IS the whole signal available.
  function isApplicationPage(url, doc) {
    return Boolean(findForm(doc));
  }

  return {
    platform: 'generic',
    findForm,
    extractPostingId,
    isApplicationPage,
    labelFor,
    groupIdentity,
    groupMembers,
    // Exported for the test suite, which asserts the clustering rule directly
    // rather than through a whole-page fixture.
    candidateControls,
    MIN_CONTROLS,
  };
});
