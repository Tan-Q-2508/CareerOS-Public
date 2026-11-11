// contentScript.js — the entry point on an application page.
//
// Runs on an ATS-hosted application form (Greenhouse, Lever — one adapter per
// host, injected by manifest.json), decides whether this really
// is one, and (only on the user's click) builds a fill plan, shows it for
// review, and applies whatever the user approved. It never fills anything on
// its own and never touches the platform's submit control.
//
// Load order is set by manifest.json: normalizeQuestion -> fieldMap -> guards
// -> matcher -> filler -> panel -> adapter -> this file. Each of those
// modules attaches itself to `window` under a CareerOSAutofill* name (the
// UMD-ish wrapper at the bottom of each), which is how they see each other
// without a bundler.

(function () {
  // Whichever adapter the manifest injected for this page's host registers
  // itself under this generic name (see src/adapters/*.js), so nothing here
  // is platform-specific — adding a platform is an adapter plus a manifest
  // match entry, never a change to this file.
  const adapter = window.CareerOSAutofillAdapter;
  const matcher = window.CareerOSAutofillMatcher;
  const filler = window.CareerOSAutofillFiller;
  const panel = window.CareerOSAutofillPanel;
  const { normalizeQuestion } = window.CareerOSAutofillNormalize;

  // panel.js owns this id — it styles and (inside an embedded iframe)
  // repositions the launcher, so a second copy of the literal here is a drift
  // risk for no gain.
  const LAUNCHER_ID = panel.LAUNCHER_ID;

  // matcher.controlType() -> application_answers.answer_type (see the table's
  // CHECK constraint). Anything unmapped stores as plain text.
  const ANSWER_TYPE_BY_CONTROL = {
    text: 'text',
    textarea: 'textarea',
    select: 'select',
    combobox: 'select',
    boolean: 'boolean',
    number: 'number',
  };

  function send(type, payload) {
    return new Promise((resolve) => {
      // A reloaded/updated extension invalidates every content script it had
      // already injected — chrome.runtime.id goes undefined on this now-dead
      // copy, and sendMessage throws synchronously rather than rejecting.
      // Reported live as an uncaught error on the CareerOS web app's own tab
      // after a routine extension reload; guarded here too for the same
      // reason, even though this file runs on the ATS page, not the app.
      if (!chrome.runtime || !chrome.runtime.id) {
        resolve({ ok: false, error: 'extension_reloaded' });
        return;
      }
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          void chrome.runtime.lastError;
          resolve(response || { ok: false, error: 'no_response' });
        });
      } catch {
        resolve({ ok: false, error: 'extension_reloaded' });
      }
    });
  }

  function dataUrlToFile(dataUrl, filename, mimeType) {
    const [meta, base64] = dataUrl.split(',');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const type = mimeType || (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    return new File([bytes], filename, { type });
  }

  async function buildAndShowPlan() {
    // An adapter may return several containers for one application — Ashby
    // keeps the EEO section in a second one. matcher.scanForm takes either.
    const form = adapter.findForm(document);
    if (!form || (Array.isArray(form) && !form.length)) {
      panel.renderMessage('CareerOS Autofill', 'No application form found on this page.');
      return;
    }

    const status = await send('connectionStatus');
    if (!status.ok || !status.data.connected) {
      panel.renderMessage(
        'Not connected',
        'Open CareerOS in another tab and sign in — the extension picks up that session automatically, then reload this page.'
      );
      return;
    }

    const profileRes = await send('getProfile');
    if (!profileRes.ok) {
      panel.renderMessage('Could not load your profile', `CareerOS said: ${profileRes.error}`);
      return;
    }
    const profile = profileRes.data.profile;

    // First pass: find every question on the form so they can be looked up in
    // one request rather than one per field.
    const firstPass = matcher.scanForm(form, profile, {}, adapter);
    const questionTexts = firstPass.questions.map((q) => q.label);
    const lookup = questionTexts.length
      ? await send('lookupAnswers', { questions: questionTexts.map((text) => ({ text })) })
      : { ok: true, data: { answers: {} } };
    const answersByKey = (lookup.ok && lookup.data.answers) || {};

    // Second pass, now with the answer bank in hand: anything previously
    // answered moves out of "needs your answer" and into "ready to fill".
    const plan = matcher.scanForm(form, profile, answersByKey, adapter);

    // A react-select/autocomplete dropdown holds no options in the DOM until
    // it is opened, so the scan above sees a question with no choices and the
    // panel would offer a free-text box against a control that accepts only
    // its own options. Opening each one to read them is the only way to know
    // what it offers — it takes a moment, hence the notice.
    if (plan.questions.some((q) => q.inputType === 'combobox' && !(q.options || []).length)) {
      panel.renderMessage('CareerOS Autofill', 'Reading this form’s dropdown options…');
      await filler.harvestComboboxOptions(plan.questions);
    }

    // Which job, which résumé, which cover letter: the résumé generated for
    // THIS job if it exists (else the master résumé, §28's rule); the cover
    // letter generated for this job ONLY — cover letters have no master
    // fallback (spec §8, generated per-job), so a job with none simply
    // leaves that upload for the user.
    const match = await send('matchJob', { url: window.location.href });
    const matchedJob = match.ok ? match.data.job : null;
    const jobDocId = match.ok && match.data.resume_document ? match.data.resume_document.id : null;
    const coverLetterDocId = match.ok && match.data.cover_letter_document ? match.data.cover_letter_document.id : null;

    let resumeInfo = null;
    let resumeFile = null;
    if (plan.fills.some((f) => f.source === 'resume')) {
      const resumeRes = await send('getResume', { documentId: jobDocId });
      if (resumeRes.ok) {
        resumeInfo = { filename: resumeRes.data.filename, source: resumeRes.data.source };
        resumeFile = dataUrlToFile(resumeRes.data.dataUrl, resumeRes.data.filename, resumeRes.data.mimeType);
      } else {
        // Drop the résumé row rather than showing a fill that can't happen.
        plan.fills = plan.fills.filter((f) => f.source !== 'resume');
      }
    }

    let coverLetterInfo = null;
    let coverLetterFile = null;
    if (plan.fills.some((f) => f.source === 'coverLetter')) {
      if (coverLetterDocId) {
        const clRes = await send('getResume', { documentId: coverLetterDocId });
        if (clRes.ok) {
          coverLetterInfo = { filename: clRes.data.filename };
          coverLetterFile = dataUrlToFile(clRes.data.dataUrl, clRes.data.filename, clRes.data.mimeType);
        } else {
          plan.fills = plan.fills.filter((f) => f.source !== 'coverLetter');
        }
      } else {
        // No cover letter has been generated for this job — nothing to
        // attach, and unlike the résumé there's no master fallback to use
        // instead, so the upload is dropped and left for the user.
        plan.fills = plan.fills.filter((f) => f.source !== 'coverLetter');
      }
    }

    const jobLabel = matchedJob
      ? (resumeInfo && resumeInfo.source === 'job_specific'
          ? `Using the résumé you generated for ${matchedJob.title}.`
          : `Matched ${matchedJob.title} — using your master résumé.`) +
        (coverLetterInfo ? ' Cover letter attached too.' : '')
      : 'Using your master résumé.';

    panel.render({
      plan,
      jobLabel,
      resumeInfo,
      coverLetterInfo,
      // Only offered when this page resolved to a real CareerOS job — the
      // route grounds its draft in that specific job's requirements, so
      // there's nothing to generate against without one.
      onGenerateAnswer: matchedJob
        ? async (question) => {
            const res = await send('generateAnswer', { jobId: matchedJob.id, question: question.label });
            if (!res.ok) {
              throw new Error(
                res.error === 'no_matched_job'
                  ? 'No matching CareerOS job found for this page.'
                  : res.error || 'Could not generate an answer.'
              );
            }
            return res.data.qa.answer;
          }
        : undefined,
      onFill: async (selectedFills, answeredQuestions) => {
        let filled = 0;
        let failed = 0;
        const failedLabels = [];

        for (const fill of selectedFills) {
          const withFile =
            fill.source === 'resume'
              ? { ...fill, file: resumeFile }
              : fill.source === 'coverLetter'
                ? { ...fill, file: coverLetterFile }
                : fill;
          const result = await filler.applyFill(withFile, adapter);
          if (result.ok) {
            filled += 1;
            // A stale answer-bank value the user corrected in the panel
            // (fill._edited) is re-saved here, after it's proven to actually
            // apply — the only path to updating an answer bank entry, since
            // no separate edit UI exists for it.
            if (fill._edited && fill.source === 'answer_bank' && adapter.platform !== 'generic') {
              await send('saveAnswer', {
                question: fill.label,
                answer: fill.value,
                answerType: 'text',
                platform: adapter.platform,
              });
            }
          } else {
            failed += 1;
            failedLabels.push(fill.label);
          }
        }

        for (const answered of answeredQuestions) {
          const result = await filler.applyFill(
            {
              el: answered.question.el,
              label: answered.question.label,
              value: answered.value,
            },
            adapter
          );
          if (result.ok) {
            filled += 1;
            // AI-drafted answers (via the "Generate with AI" button, spec
            // 8.6) are written for THIS job specifically — "why do you want
            // to join Acme?" is actively wrong if silently replayed on a
            // different company's form. They're excluded from the reusable
            // answer bank; the job-scoped record already exists server-side
            // (job_question_answers, written by the answer-question route
            // itself when it generated the draft). Only text the user
            // actually typed themselves gets saved for cross-job reuse.
            // The generic adapter (§17.2) is excluded for a different reason
            // than AI drafts, and it is a safety property rather than a
            // preference. On a page whose markup we have never seen, a
            // question's label is INFERRED from nearby text — reliable enough
            // to show the user in the panel, not reliable enough to become a
            // permanent key that silently hands this answer to some other
            // company's question later. Reads from the bank still happen: a
            // wrong read is a visible row the user unticks, a wrong write is
            // invisible and permanent.
            if (!answered.aiGenerated && adapter.platform !== 'generic') {
              await send('saveAnswer', {
                question: answered.question.label,
                answer: answered.value,
                // The control types the matcher reports are DOM shapes; the
                // answer bank's answer_type is a small closed set (its CHECK
                // constraint). 'combobox' and 'file' have no place there, so
                // they're mapped rather than sent through and rejected.
                answerType: ANSWER_TYPE_BY_CONTROL[answered.question.inputType] || 'text',
                platform: adapter.platform,
              });
            }
          } else {
            failed += 1;
            failedLabels.push(answered.question.label);
          }
        }

        return { filled, failed, failedLabels };
      },
    });
  }

  function mountLauncher() {
    const shadow = panel.getShadowRoot();
    if (shadow.getElementById(LAUNCHER_ID)) return;
    const button = document.createElement('button');
    button.id = LAUNCHER_ID;
    button.type = 'button'; // never a submit button, even if it lands inside a form
    button.textContent = 'Autofill with CareerOS';
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      buildAndShowPlan().catch((err) => panel.renderMessage('Autofill failed', err.message || String(err)));
    });
    shadow.appendChild(button);
  }

  function init() {
    if (!adapter.isApplicationPage(window.location.href, document)) return;
    mountLauncher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Keeps re-asserting the launcher exists for the WHOLE lifetime of the
  // page, not just the first few seconds after load. Two distinct failure
  // modes were found live, on real Greenhouse postings, and both needed
  // fixing before this actually held up:
  //
  //   1. A hydration-mismatch recovery (React errors #418/#423, seen in the
  //      console on Vestmark's board — a Remix app, which hydrates the whole
  //      document) can trigger a full client-side re-render that removes
  //      this extension's host div well after the page first settled.
  //   2. SPA CLIENT-SIDE NAVIGATION between job postings — reported live:
  //      the launcher disappeared "on most job openings," reappearing only
  //      after a hard refresh, within 1-2 seconds of navigating. Chrome only
  //      re-injects content scripts on a REAL page load; Greenhouse's router
  //      moves between job pages via `history.pushState()` without one, so
  //      nothing here ever re-ran on its own. A hard refresh "fixed" it only
  //      because that's a genuine page load.
  //
  // Fix for #2: wrap `pushState`/`replaceState` and listen for `popstate` so
  // any URL change re-evaluates whether this is still an application page —
  // this is the standard way to detect SPA soft-navigation, since nothing
  // else fires reliably for it. Fix for #1 (and a backstop for #2, since the
  // new page's form may not exist yet the instant the URL changes): the
  // MutationObserver below now watches the WHOLE document (`subtree: true`,
  // not just `<html>`'s direct children as before — that scope only ever
  // catches a `<body>`-level swap, not the ordinary re-renders happening
  // inside it), debounced so a burst of React re-render mutations triggers
  // one check, not hundreds. panel.js's getShadowRoot() is the other
  // necessary half — it must not return a stale reference to a shadow root
  // whose host has already been detached.
  let lastHref = window.location.href;
  function handleLocationChange() {
    if (window.location.href === lastHref) return;
    lastHref = window.location.href;
    if (!adapter.isApplicationPage(window.location.href, document)) {
      // Navigated away from an application page via client-side routing —
      // drop the stale launcher/panel rather than leaving them mounted for
      // a page they no longer apply to.
      const host = document.getElementById(panel.HOST_ID);
      if (host) host.remove();
      return;
    }
    init();
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      handleLocationChange();
      return result;
    };
  }
  window.addEventListener('popstate', handleLocationChange);

  // A multi-step application that swaps its form out without changing the URL
  // (Workday: five steps under one /applyManually address). A plan built on
  // step 1 holds element references step 2 has already destroyed, so filling
  // from it would report every row as failed against controls that no longer
  // exist. When the adapter can name the step, a change closes the open panel
  // and leaves the launcher, and the user autofills the new step with a click.
  let lastStepKey = adapter.stepKey ? adapter.stepKey(document) : null;
  function handleStepChange() {
    if (!adapter.stepKey) return;
    const key = adapter.stepKey(document);
    if (key === lastStepKey) return;
    lastStepKey = key;
    panel.remove();
    init();
  }

  let hostCheckScheduled = false;
  const observer = new MutationObserver(() => {
    if (hostCheckScheduled) return;
    hostCheckScheduled = true;
    setTimeout(() => {
      hostCheckScheduled = false;
      handleStepChange();
      // The launcher, not the host, is what must exist: a host can survive
      // without its launcher (a re-render that kept the div, or anything that
      // created the host before the form had rendered).
      const host = document.getElementById(panel.HOST_ID);
      if (!host || !host.shadowRoot || !host.shadowRoot.getElementById(LAUNCHER_ID)) init();
    }, 150);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Exposed for verification without installing the extension (see the
  // session's handoff): lets a test harness build a plan against the live DOM.
  window.__careerosAutofill = { adapter, matcher, filler, panel, normalizeQuestion, buildAndShowPlan };
})();
