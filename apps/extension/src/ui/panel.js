// panel.js — the fill-preview / review UI (spec §15 session 28).
//
// The panel is the whole safety story of this feature: NOTHING is written to
// the page until the user has seen every proposed value, alongside where it
// came from, and pressed the button. Unmatched questions are surfaced here as
// inline inputs so a one-time answer both fills the form and joins the answer
// bank for the next application (7.13's reuse discipline).
//
// Built with plain DOM calls (no innerHTML with interpolated values) — the
// labels and options rendered here come from a third-party page, and putting
// that text through innerHTML inside an extension context is exactly how a
// content script becomes an injection vector.
//
// Everything here mounts inside a SHADOW ROOT (getShadowRoot() below), not
// directly in the page's light DOM. Found live: a real user's floating
// launcher button silently vanished with a generic ad blocker (AdBlock Plus)
// enabled — cosmetic-filter lists commonly target exactly the pattern our
// launcher used (a fixed-position bottom-right pill button), the same way
// they hide floating chat widgets and CTA bubbles on ordinary sites.
// Cosmetic filters operate as CSS rules against the page's own light DOM;
// they cannot select into a shadow tree. Moving both the launcher and the
// panel behind one shadow root removes that whole failure class rather than
// playing whack-a-mole with id/class names.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillPanel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const HOST_ID = 'careeros-autofill-host';
  const PANEL_ID = 'careeros-autofill-panel';
  // Owned here rather than in contentScript.js because this module styles it,
  // positions it, and now has to find it again to move it.
  const LAUNCHER_ID = 'careeros-autofill-launcher';

  // A form a company serves from its own domain runs inside the ATS's iframe
  // (Greenhouse's #grnhse_iframe, and the equivalent for Lever and Ashby). The
  // embed script sizes that iframe to its FULL content height so there is no
  // inner scrollbar — which means the iframe's viewport is the whole form, and
  // `position: fixed` pins the panel to the top of the form rather than to the
  // part of it on screen. On a long application that is a panel parked
  // thousands of pixels above where the user is looking, i.e. invisible.
  const IN_FRAME = (() => {
    // No window at all means this module is being required by a Node test, not
    // running in a page — which is neither a frame nor a top document.
    if (typeof window === 'undefined') return false;
    try {
      return window.top !== window.self;
    } catch {
      return true; // reading window.top threw, so this is a cross-origin frame
    }
  })();

  // Mirrors src/ui/panel.css. Duplicated rather than loaded via the
  // manifest's content-script `css` injection because that injection targets
  // the page's light DOM `<head>`, which a shadow tree's styles don't
  // inherit from — a shadow root needs its own <style>. Keep the two files
  // in sync by hand; panel.css stays the readable source when editing rules.
  const PANEL_CSS = `
#${PANEL_ID}, #${PANEL_ID} * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.45; }
#${PANEL_ID} { position: fixed; top: 16px; right: 16px; width: 380px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: #ffffff; color: #16181d; border: 1px solid #d8dbe2; border-radius: 12px; box-shadow: 0 12px 32px rgba(16, 18, 24, 0.18); z-index: 2147483647; font-size: 13px; }
#${PANEL_ID} .cos-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #eceef2; }
#${PANEL_ID} .cos-title { font-weight: 650; font-size: 13px; letter-spacing: 0.01em; }
#${PANEL_ID} .cos-sub { font-size: 11.5px; color: #6b7280; margin-top: 2px; }
#${PANEL_ID} .cos-close { border: none; background: transparent; cursor: pointer; font-size: 18px; line-height: 1; color: #6b7280; padding: 2px 6px; border-radius: 6px; }
#${PANEL_ID} .cos-close:hover { background: #f2f4f7; color: #16181d; }
#${PANEL_ID} .cos-body { overflow-y: auto; padding: 6px 0; flex: 1 1 auto; }
#${PANEL_ID} .cos-section { padding: 8px 14px 4px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #8a90a0; }
#${PANEL_ID} .cos-row { display: flex; align-items: flex-start; gap: 9px; padding: 7px 14px; }
#${PANEL_ID} .cos-row:hover { background: #f8f9fb; }
#${PANEL_ID} .cos-row input[type='checkbox'] { margin: 3px 0 0 0; flex: 0 0 auto; width: 14px; height: 14px; accent-color: #2f6df6; }
#${PANEL_ID} .cos-label { font-size: 12px; color: #4a5060; word-break: break-word; }
#${PANEL_ID} .cos-value { font-size: 12.5px; font-weight: 550; color: #16181d; word-break: break-word; margin-top: 1px; }
#${PANEL_ID} .cos-src { display: inline-block; margin-top: 3px; font-size: 10px; font-weight: 650; letter-spacing: 0.03em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; background: #eef2ff; color: #3b5bdb; }
#${PANEL_ID} .cos-src.bank { background: #e9f7ef; color: #1c7a4a; }
#${PANEL_ID} .cos-src.file { background: #fff4e5; color: #a35b09; }
#${PANEL_ID} .cos-edit-link { display: inline-block; margin-top: 3px; margin-left: 6px; font-size: 10px; font-weight: 650; letter-spacing: 0.03em; text-transform: uppercase; color: #2f6df6; background: none; border: none; cursor: pointer; padding: 0; }
#${PANEL_ID} .cos-edit-link:hover { text-decoration: underline; }
#${PANEL_ID} .cos-edit-input { width: 100%; margin-top: 3px; padding: 5px 7px; font-size: 12.5px; color: #16181d; background: #ffffff; border: 1px solid #2f6df6; border-radius: 6px; }
#${PANEL_ID} .cos-q input, #${PANEL_ID} .cos-q textarea, #${PANEL_ID} .cos-q select { width: 100%; margin-top: 5px; padding: 6px 8px; font-size: 12.5px; color: #16181d; background: #ffffff; border: 1px solid #d8dbe2; border-radius: 7px; }
#${PANEL_ID} .cos-q textarea { min-height: 62px; resize: vertical; }
#${PANEL_ID} .cos-note { padding: 6px 14px 10px; font-size: 11.5px; color: #6b7280; }
#${PANEL_ID} .cos-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid #eceef2; }
#${PANEL_ID} .cos-btn { flex: 1 1 auto; padding: 8px 12px; font-size: 12.5px; font-weight: 620; color: #ffffff; background: #2f6df6; border: none; border-radius: 8px; cursor: pointer; }
#${PANEL_ID} .cos-btn:hover { background: #2559d6; }
#${PANEL_ID} .cos-btn[disabled] { background: #b9c3d6; cursor: default; }
#${PANEL_ID} .cos-btn.secondary { flex: 0 0 auto; color: #4a5060; background: #f2f4f7; }
#${PANEL_ID} .cos-btn.secondary:hover { background: #e6e9ef; }
#${PANEL_ID} .cos-status { padding: 0 14px 10px; font-size: 11.5px; color: #1c7a4a; }
#${PANEL_ID} .cos-status.err { color: #b3261e; }
#careeros-autofill-launcher { position: fixed; bottom: 20px; right: 20px; z-index: 2147483647; padding: 10px 15px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 620; color: #ffffff; background: #2f6df6; border: none; border-radius: 999px; box-shadow: 0 6px 18px rgba(47, 109, 246, 0.35); cursor: pointer; }
#careeros-autofill-launcher:hover { background: #2559d6; }
@media (prefers-color-scheme: dark) {
  #${PANEL_ID} { background: #16181d; color: #eceef2; border-color: #2c3038; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); }
  #${PANEL_ID} .cos-head, #${PANEL_ID} .cos-foot { border-color: #2c3038; }
  #${PANEL_ID} .cos-row:hover { background: #1d2027; }
  #${PANEL_ID} .cos-label { color: #a6adbb; }
  #${PANEL_ID} .cos-value { color: #eceef2; }
  #${PANEL_ID} .cos-q input, #${PANEL_ID} .cos-q textarea, #${PANEL_ID} .cos-q select { background: #1d2027; color: #eceef2; border-color: #2c3038; }
  #${PANEL_ID} .cos-btn.secondary { background: #262a33; color: #cbd1dc; }
  #${PANEL_ID} .cos-btn.secondary:hover { background: #2f343f; }
}
`;

  // Appended to PANEL_CSS only inside an embedded iframe (see IN_FRAME).
  // Absolute rather than fixed, so both the launcher and the panel sit at the
  // top of the form instead of at the top/bottom of a page-tall viewport, and
  // a fixed pixel cap replaces `calc(100vh - 32px)` — inside an iframe sized
  // to its content, 100vh is the whole form, so the "max" height would let the
  // panel grow taller than the screen it has to be read on.
  const FRAMED_CSS = `
#${PANEL_ID} { position: absolute; top: 12px; right: 12px; max-height: 560px; transition: top 180ms ease-out; }
#careeros-autofill-launcher { position: absolute; top: 12px; right: 12px; bottom: auto; transition: top 180ms ease-out; }
`;

  let shadowRootCache = null;

  // The one DOM anchor point this whole feature has in the light DOM: a
  // single empty host div. Everything else — launcher button, panel, all
  // styles — lives inside its shadow tree, unreachable by page CSS and by
  // cosmetic ad-block filters, which both operate on the light DOM only.
  //
  // NEVER trust a cached shadow root without checking the live DOM first.
  // Found live on a real Greenhouse posting (Vestmark — a Remix app,
  // identified by its `remix-css-*` class names): Remix hydrates the WHOLE
  // document, not just a `<div id="root">` inside body, so a hydration
  // mismatch (observed live as React errors #418/#423, which React recovers
  // from via a full client-side re-render) can wipe out ANY node under
  // `<html>` that Remix doesn't own — including this host div — well after
  // the page first loaded. The button visibly disappeared and never came
  // back. A stale `shadowRootCache` pointing at a now-detached node was the
  // second half of the bug: even after the host was gone, every future call
  // kept returning the same dead reference instead of re-creating one.
  function getShadowRoot() {
    const existing = document.getElementById(HOST_ID);
    if (shadowRootCache && existing && existing.shadowRoot === shadowRootCache) {
      return shadowRootCache;
    }
    const host = existing || document.createElement('div');
    if (!existing) {
      host.id = HOST_ID;
    }
    if (!host.isConnected) {
      document.documentElement.appendChild(host);
    }
    shadowRootCache = host.shadowRoot || host.attachShadow({ mode: 'open' });
    if (!shadowRootCache.querySelector('style')) {
      const style = document.createElement('style');
      style.textContent = PANEL_CSS + (IN_FRAME ? FRAMED_CSS : '');
      shadowRootCache.appendChild(style);
    }
    return shadowRootCache;
  }

  // ---------------------------------------------------------------------
  // Following the user inside an embedded iframe.
  //
  // The embed host sizes the ATS iframe to its full content height, so the
  // iframe never scrolls and `position: fixed` pins to the top of the whole
  // form rather than to the screen — on a real application that is the panel
  // parked thousands of pixels above the reader. A cross-origin iframe also
  // cannot read its parent's scroll offset, so there is no direct way to ask
  // where the viewport currently is.
  //
  // What IS available, with no new permission: the user's own pointer and
  // focus. A pointermove, wheel or focusin event can only happen at a point
  // the user can actually see, and because this document never scrolls,
  // `clientY` IS the document coordinate. `wheel` is the load-bearing one — it
  // fires over the iframe while the PARENT scrolls, which is precisely the
  // action that used to lose the panel.
  //
  // Known limit (§21.3): scrolling with the pointer entirely off the form and
  // never focusing a field leaves the panel where it was until the next
  // interaction.
  // ---------------------------------------------------------------------
  const FOLLOW_DEAD_ZONE = 180; // don't chase small movements; settle instead
  const FOLLOW_MARGIN = 8;
  const FOLLOW_THROTTLE_MS = 50;
  let lastViewportY = null;
  let followScheduled = false;

  function trackedY(event) {
    if (event.type === 'focusin') {
      const target = event.target;
      if (!target || typeof target.getBoundingClientRect !== 'function') return null;
      const rect = target.getBoundingClientRect();
      // A 0×0 rect is an element that isn't laid out — it says nothing about
      // where the user is looking.
      if (!rect.height && !rect.top) return null;
      return rect.top + rect.height / 2;
    }
    return typeof event.clientY === 'number' ? event.clientY : null;
  }

  /**
   * Where an element should sit, or null for "leave it alone". Pure, and its
   * own function so the arithmetic is testable without a browser — the DOM
   * half below is then trivial enough to read.
   *
   * @param viewportY  the last place the user was seen, in document coords
   * @param currentTop the element's current top, NaN if never positioned
   * @returns number to move to, or null to stay put
   */
  function nextFollowTop({ viewportY, currentTop, elementHeight, docHeight }) {
    if (viewportY === null || viewportY === undefined) return null;
    // Centre the element on the user rather than aligning to them: the
    // viewport's own height is unknowable from inside a cross-origin frame, and
    // centring keeps the panel on screen whether the pointer sits high or low
    // in it. Capped at 400 so a tall panel doesn't overshoot upward.
    const anchor = viewportY - Math.min(elementHeight, 400) / 2;
    const maxTop = Math.max(FOLLOW_MARGIN, docHeight - elementHeight - FOLLOW_MARGIN);
    const desired = Math.round(Math.min(Math.max(anchor, FOLLOW_MARGIN), maxTop));
    // A dead zone, so the panel settles instead of chasing every twitch of the
    // pointer. An unpositioned element (NaN) always places.
    if (Number.isFinite(currentTop) && Math.abs(currentTop - desired) < FOLLOW_DEAD_ZONE) return null;
    return desired;
  }

  function moveInto(node) {
    // `=== null`, not falsy: a pointer at the very top of the document is a
    // clientY of 0, which is a real sighting.
    if (!node || lastViewportY === null) return;
    const doc = node.ownerDocument || document;
    const top = nextFollowTop({
      viewportY: lastViewportY,
      currentTop: parseFloat(node.style.top),
      elementHeight: node.offsetHeight || 0,
      docHeight: doc.documentElement.scrollHeight,
    });
    if (top !== null) node.style.top = `${top}px`;
  }

  function followViewport() {
    const host = document.getElementById(HOST_ID);
    const shadow = host && host.shadowRoot;
    if (!shadow) return;
    moveInto(shadow.getElementById(PANEL_ID));
    moveInto(shadow.getElementById(LAUNCHER_ID));
  }

  function onUserPosition(event) {
    // An event from inside our own panel is still a real sighting of the user,
    // but acting on it lets the panel chase itself; the dead zone would damp
    // that, and ignoring it removes the loop entirely.
    const host = document.getElementById(HOST_ID);
    if (host && typeof event.composedPath === 'function' && event.composedPath().includes(host)) return;
    const y = trackedY(event);
    if (y === null) return;
    lastViewportY = y;
    if (followScheduled) return;
    followScheduled = true;
    // A timer rather than requestAnimationFrame: rAF is tied to the tab
    // actually painting, so in an occluded or background window it can stop
    // firing entirely and the panel silently stops following. ~20Hz is far more
    // than this needs, and it keeps the scheduling independent of rendering.
    setTimeout(() => {
      followScheduled = false;
      followViewport();
    }, FOLLOW_THROTTLE_MS);
  }

  if (IN_FRAME && typeof document !== 'undefined') {
    for (const type of ['pointermove', 'wheel', 'focusin']) {
      document.addEventListener(type, onUserPosition, { capture: true, passive: true });
    }
  }

  // Put a freshly-rendered panel where the user is. When we already know where
  // that is, position it directly — no need to move the host page at all. Only
  // when we have never seen the user (the toolbar button was clicked without
  // the pointer ever crossing the form) do we fall back to scrollIntoView,
  // which walks ancestor frames and brings the HOST page to the panel.
  function placeInView(panel) {
    if (!IN_FRAME) return;
    if (lastViewportY !== null) {
      panel.style.top = '';
      moveInto(panel);
      return;
    }
    try {
      panel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* no scrollIntoView options support — leaving it where it is is fine */
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function truncate(value, max) {
    const s = String(value);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  function sourceBadge(source) {
    if (source === 'answer_bank') return { text: 'saved answer', cls: 'cos-src bank' };
    if (source === 'resume') return { text: 'résumé file', cls: 'cos-src file' };
    if (source === 'coverLetter') return { text: 'cover letter file', cls: 'cos-src file' };
    return { text: 'your profile', cls: 'cos-src' };
  }

  /**
   * @param {Object} opts
   *   plan            {fills, questions, blocked} from matcher.scanForm
   *   jobLabel        string|null — context line under the title
   *   resumeInfo      {filename, source}|null
   *   coverLetterInfo {filename}|null
   *   onFill          (selectedFills, answeredQuestions) => Promise<{filled, failed, failedLabels}>
   *   onGenerateAnswer (question) => Promise<string>  — job-scoped AI draft (spec 8.6);
   *                     omit/leave undefined to hide the "Generate with AI" button entirely
   *                     (e.g. no job matched for this page).
   *   onClose         () => void
   */
  function render(opts) {
    remove();
    const shadow = getShadowRoot();

    const { plan, jobLabel, resumeInfo, coverLetterInfo, onFill, onGenerateAnswer, onClose } = opts;
    const panel = el('div');
    panel.id = PANEL_ID;

    // ---- header ----
    const head = el('div', 'cos-head');
    const titleWrap = el('div');
    titleWrap.appendChild(el('div', 'cos-title', 'CareerOS Autofill'));
    const subText = jobLabel || 'Review each value before it is filled in.';
    titleWrap.appendChild(el('div', 'cos-sub', subText));
    head.appendChild(titleWrap);
    const close = el('button', 'cos-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => {
      remove();
      if (onClose) onClose();
    });
    head.appendChild(close);
    panel.appendChild(head);

    const body = el('div', 'cos-body');
    const fillCheckboxes = [];
    const questionInputs = [];

    // ---- proposed fills ----
    if (plan.fills.length) {
      body.appendChild(el('div', 'cos-section', `Ready to fill (${plan.fills.length})`));
      for (const fill of plan.fills) {
        const row = el('div', 'cos-row');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        row.appendChild(box);

        const textWrap = el('div');
        textWrap.style.flex = '1 1 auto';
        textWrap.appendChild(el('div', 'cos-label', truncate(fill.label, 90)));

        const displayValue =
          fill.source === 'resume'
            ? (resumeInfo && resumeInfo.filename) || 'your résumé'
            : fill.source === 'coverLetter'
              ? (coverLetterInfo && coverLetterInfo.filename) || 'your cover letter'
              : truncate(fill.value, 140);
        const valueNode = el('div', 'cos-value', displayValue);
        textWrap.appendChild(valueNode);

        const badge = sourceBadge(fill.source);
        textWrap.appendChild(el('span', badge.cls, badge.text));

        // A saved answer can go stale: the same normalized question can
        // recur on a different form with a different set of valid options
        // (e.g. "Work Authorization" phrased identically but backed by a
        // different dropdown's choices), so a prior answer isn't guaranteed
        // to still apply. Editing here corrects the value for THIS fill and,
        // on a successful fill, re-saves the correction — the only path to
        // updating an answer bank entry, since there's no separate settings
        // UI for it (spec §17.3 doesn't currently define one).
        if (fill.source === 'answer_bank') {
          const editBtn = el('button', 'cos-edit-link', 'Edit');
          editBtn.type = 'button';
          editBtn.addEventListener('click', () => {
            if (textWrap.querySelector('.cos-edit-input')) return;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'cos-edit-input';
            input.value = String(fill.value);
            valueNode.replaceWith(input);
            editBtn.style.display = 'none';
            input.focus();
            input.select();
            const commit = () => {
              const next = input.value;
              if (next !== String(fill.value)) {
                fill.value = next;
                fill._edited = true;
              }
              const freshValueNode = el('div', 'cos-value', String(fill.value));
              input.replaceWith(freshValueNode);
              editBtn.style.display = '';
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
              }
            });
          });
          textWrap.appendChild(editBtn);
        }

        row.appendChild(textWrap);
        body.appendChild(row);
        fillCheckboxes.push({ box, fill });
      }
    }

    // ---- unmatched questions ----
    if (plan.questions.length) {
      body.appendChild(el('div', 'cos-section', `Needs your answer (${plan.questions.length})`));
      body.appendChild(
        el('div', 'cos-note', 'Answered once here, reused automatically on every future application.')
      );
      for (const question of plan.questions) {
        const row = el('div', 'cos-row cos-q');
        const textWrap = el('div');
        textWrap.style.flex = '1 1 auto';
        textWrap.appendChild(el('div', 'cos-label', truncate(question.label, 140)));
        if (question.selfIdentification) {
          // Answering is optional on every real form, and the answer is
          // stored and replayed afterwards — both worth saying plainly at
          // the point of asking, rather than in a settings page nobody opens.
          textWrap.appendChild(
            el('div', 'cos-note', 'Voluntary. Leave blank to skip — whatever you pick is saved and reused.')
          );
        }

        let input;
        // A combobox whose options were read off the widget during the scan is
        // a dropdown like any other. Without them it stays a text box, which
        // is what made Greenhouse's "What is your preferred pronoun?" ask for
        // free text against a react-select that only accepts one of its own
        // four options — so whatever was typed filled nothing and was never
        // saved (verified live).
        const hasOptions = Boolean(question.options && question.options.length);
        if ((question.inputType === 'select' || question.inputType === 'combobox') && hasOptions) {
          input = document.createElement('select');
          const blank = document.createElement('option');
          blank.value = '';
          blank.textContent = '— choose —';
          input.appendChild(blank);
          for (const optionText of question.options) {
            const option = document.createElement('option');
            option.value = optionText;
            option.textContent = optionText;
            input.appendChild(option);
          }
        } else if (question.inputType === 'textarea') {
          input = document.createElement('textarea');
        } else if (question.inputType === 'boolean') {
          input = document.createElement('select');
          for (const optionText of ['', 'Yes', 'No']) {
            const option = document.createElement('option');
            option.value = optionText;
            option.textContent = optionText || '— choose —';
            input.appendChild(option);
          }
        } else if (question.inputType === 'date') {
          // A real date picker, so what reaches filler.setDateValue is an
          // unambiguous ISO date it can verify the widget kept — rather than
          // a typed string whose day/month order nobody can pin down.
          input = document.createElement('input');
          input.type = 'date';
        } else {
          input = document.createElement('input');
          input.type = question.inputType === 'number' ? 'number' : 'text';
        }
        textWrap.appendChild(input);

        const entry = { input, question, aiGenerated: false };

        // Only offered for free-text/narrative questions ("why do you want
        // to join?", "explain a project"), never for enumerated select/
        // boolean fields, which have no prose for AI to draft. Also only
        // when a job was actually matched (onGenerateAnswer is null
        // otherwise) — the underlying route needs a real job id, since the
        // answer is grounded in that specific job's requirements.
        const canGenerate =
          (question.inputType === 'text' || question.inputType === 'textarea') &&
          // Never for a self-identification question: an AI-drafted answer
          // about the user's own race, gender or disability status would be
          // invented, which is the one thing this feature must never do.
          !question.selfIdentification &&
          typeof onGenerateAnswer === 'function';
        if (canGenerate) {
          const genRow = el('div');
          genRow.style.marginTop = '4px';
          const genBtn = el('button', 'cos-edit-link', 'Generate with AI');
          genBtn.type = 'button';
          const genNote = el('span', 'cos-note', '');
          genNote.style.padding = '0';
          genNote.style.display = 'none';
          genBtn.addEventListener('click', async () => {
            genBtn.disabled = true;
            genBtn.textContent = 'Generating…';
            genNote.style.display = 'none';
            try {
              const answer = await onGenerateAnswer(question);
              input.value = answer;
              entry.aiGenerated = true;
              genBtn.textContent = 'Regenerate with AI';
            } catch (e) {
              genNote.textContent = e.message || 'Could not generate an answer.';
              genNote.style.display = 'block';
              genBtn.textContent = 'Generate with AI';
            } finally {
              genBtn.disabled = false;
            }
          });
          genRow.appendChild(genBtn);
          genRow.appendChild(genNote);
          textWrap.appendChild(genRow);
          textWrap.appendChild(
            el('div', 'cos-note', 'AI-drafted answers are billed like other CareerOS drafts and are never added to your reusable answer bank — they’re specific to this job.')
          );
        }

        row.appendChild(textWrap);
        body.appendChild(row);
        questionInputs.push(entry);
      }
    }

    // ---- blocked, shown for transparency ----
    const sensitiveBlocked = plan.blocked.filter((b) => b.reason === 'sensitive');
    const consentBlocked = plan.blocked.filter((b) => b.reason === 'consent');
    if (sensitiveBlocked.length || consentBlocked.length) {
      const total = sensitiveBlocked.length + consentBlocked.length;
      body.appendChild(el('div', 'cos-section', `Left for you (${total})`));
      const parts = [];
      if (sensitiveBlocked.length) {
        parts.push('Date of birth and Social Security number are never filled or stored.');
      }
      if (consentBlocked.length) {
        parts.push('Legal affirmations and consent checkboxes are never checked on your behalf.');
      }
      body.appendChild(el('div', 'cos-note', `${parts.join(' ')} Fill them in yourself if you want to answer.`));
    }

    if (!plan.fills.length && !plan.questions.length) {
      body.appendChild(el('div', 'cos-note', 'No fillable fields found on this page.'));
    }

    panel.appendChild(body);

    // ---- footer ----
    const status = el('div', 'cos-status');
    status.style.display = 'none';
    panel.appendChild(status);

    const foot = el('div', 'cos-foot');
    const fillBtn = el('button', 'cos-btn', 'Fill selected');
    const noneBtn = el('button', 'cos-btn secondary', 'Deselect all');
    noneBtn.addEventListener('click', () => {
      const anyChecked = fillCheckboxes.some((c) => c.box.checked);
      for (const c of fillCheckboxes) c.box.checked = !anyChecked;
      noneBtn.textContent = anyChecked ? 'Select all' : 'Deselect all';
    });

    fillBtn.addEventListener('click', async () => {
      fillBtn.disabled = true;
      fillBtn.textContent = 'Filling…';
      status.style.display = 'none';
      status.className = 'cos-status';

      const selected = fillCheckboxes.filter((c) => c.box.checked).map((c) => c.fill);
      const answered = questionInputs
        .filter((q) => String(q.input.value || '').trim() !== '')
        .map((q) => ({ question: q.question, value: q.input.value, aiGenerated: q.aiGenerated }));

      try {
        const result = await onFill(selected, answered);
        const failedNote =
          result.failed && result.failedLabels && result.failedLabels.length
            ? ` Could not fill: ${result.failedLabels.map((l) => truncate(l, 40)).join('; ')} — set ${
                result.failedLabels.length === 1 ? 'it' : 'these'
              } manually.`
            : result.failed
              ? `, ${result.failed} could not be filled`
              : '';
        status.textContent =
          `Filled ${result.filled} field${result.filled === 1 ? '' : 's'}.${failedNote} Review the form, then submit it yourself.`;
        status.style.display = 'block';
      } catch (e) {
        status.className = 'cos-status err';
        status.textContent = e.message || 'Something went wrong while filling.';
        status.style.display = 'block';
      } finally {
        fillBtn.disabled = false;
        fillBtn.textContent = 'Fill selected';
      }
    });

    foot.appendChild(noneBtn);
    foot.appendChild(fillBtn);
    panel.appendChild(foot);

    shadow.appendChild(panel);
    placeInView(panel);
    return panel;
  }

  // Looks the host up rather than going through getShadowRoot(), which CREATES
  // one: removing a panel from a page that has none must leave that page with
  // no host at all. Otherwise a caller that only wanted "no stale panel" (the
  // step watcher) plants an empty host, and the launcher's "host missing →
  // mount" check never fires again — the launcher never appeared on Workday.
  function remove() {
    const host = document.getElementById(HOST_ID);
    const shadow = host && host.shadowRoot;
    const existing = shadow && shadow.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  function renderMessage(title, message) {
    remove();
    const shadow = getShadowRoot();
    const panel = el('div');
    panel.id = PANEL_ID;
    const head = el('div', 'cos-head');
    const titleWrap = el('div');
    titleWrap.appendChild(el('div', 'cos-title', title));
    head.appendChild(titleWrap);
    const close = el('button', 'cos-close', '×');
    close.addEventListener('click', remove);
    head.appendChild(close);
    panel.appendChild(head);
    const body = el('div', 'cos-body');
    body.appendChild(el('div', 'cos-note', message));
    panel.appendChild(body);
    shadow.appendChild(panel);
    placeInView(panel);
    return panel;
  }

  return { render, renderMessage, remove, getShadowRoot, nextFollowTop, PANEL_ID, HOST_ID, LAUNCHER_ID };
});
