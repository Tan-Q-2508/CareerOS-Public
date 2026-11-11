// greenhouse.js — the Greenhouse-specific field adapter (spec §15 session 28).
//
// An adapter supplies DOM SHAPE and nothing else: where the application form
// is, which containers hold custom questions, and how to read the posting id
// out of the URL. All field semantics live in core/fieldMap.js and all
// matching in core/matcher.js, so sessions 29-32 add ~80 lines each rather
// than re-implementing the engine.
//
// Greenhouse renders application forms in four shapes that all appear in
// currently-sourced postings:
//   - job-boards.greenhouse.io/<board>/jobs/<id>       (current, React)
//   - boards.greenhouse.io/<board>/jobs/<id>?gh_jid=   (legacy)
//   - an embedding host (e.g. app.careerpuck.com) that iframes or inlines the
//     same form and carries the id as ?gh_jid=
//   - the JS EMBED, which is how a company serves the application from its own
//     domain (fastly.com/about/jobs/apply?gh_jid=8188597). That outer page has
//     no <form> at all: Greenhouse's embed script drops an
//     <iframe id="grnhse_iframe"> whose src is
//     job-boards.greenhouse.io/embed/job_app?for=<board>&token=<posting id>,
//     and the real form lives inside it. The manifest matches that iframe by
//     URL (it is a greenhouse.io URL) with `all_frames: true`; the only thing
//     that differs from the shapes above is where the posting id sits.
// The form root selectors below cover all four — the embedded document uses
// the same `#application-form` / `#first_name` / `#question_<n>` ids as the
// hosted one. Posting-id extraction is shared with the server's own matcher
// (routes/autofill.js) and must stay in agreement with it.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillGreenhouse = factory();
    // Also registered under the generic name the content script reads, so
    // contentScript.js stays platform-neutral (one adapter is injected per
    // page by the manifest's content_scripts matches).
    root.CareerOSAutofillAdapter = root.CareerOSAutofillGreenhouse;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FORM_SELECTORS = [
    '#application-form',
    'form#application_form',
    'form[action*="application"]',
    'main form',
    'form',
  ];

  function findForm(doc) {
    const d = doc || document;
    for (const selector of FORM_SELECTORS) {
      const el = d.querySelector(selector);
      // A form with no fillable controls is a search box, a newsletter
      // signup, or the site's own filter UI — not the application.
      if (el && el.querySelectorAll('input, textarea, select').length >= 3) return el;
    }
    return null;
  }

  function extractPostingId(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const ghJid = parsed.searchParams.get('gh_jid');
    if (ghJid) return ghJid;
    // The JS embed's iframe carries the posting id as `token`. Scoped to that
    // one path on purpose: `token` means "auth token" almost everywhere else,
    // so reading it from any URL that happens to have one would match the
    // wrong job (or a secret) rather than fail.
    if (/\/embed\/job_app\b/.test(parsed.pathname)) {
      const token = parsed.searchParams.get('token');
      if (token && /^\d{4,}$/.test(token)) return token;
    }
    const m = parsed.pathname.match(/\/jobs?\/(\d{4,})/);
    return m ? m[1] : null;
  }

  function isApplicationPage(url, doc) {
    if (!extractPostingId(url)) return false;
    return Boolean(findForm(doc));
  }

  // Greenhouse gives its core fields stable element ids, which are far more
  // reliable than the visible label — verified live: BOTH file inputs are
  // labelled just "Attach", and only `id` distinguishes the résumé from the
  // cover letter. Getting that backwards would send a recruiter the wrong
  // document, so the adapter overrides the label matcher for these ids.
  //
  // 'coverLetterFile' is conditional in a way the other hints aren't: unlike
  // the résumé (which always has a master fallback), a cover letter is
  // generated per-job with nothing to fall back to (spec §8), so
  // matcher.scanForm always plans the fill, and contentScript.js drops it
  // again after checking whether one actually exists for this job.
  const ID_HINTS = {
    first_name: 'firstName',
    last_name: 'lastName',
    email: 'email',
    phone: 'phone',
    'candidate-location': 'location',
    resume: 'resumeFile',
    cover_letter: 'coverLetterFile',
    // The third field in Greenhouse's own standard contact row (Country /
    // Phone / Location), confirmed across two independent postings — it
    // exists to pick the phone number's expected region, not to ask a
    // separate nationality/eligibility question (those are custom
    // screening questions rendered elsewhere, with their own distinct
    // phrasing). Reported live: with no hint here its accessible name
    // resolved to the widget's own internal search-box text ("Search")
    // rather than its real <label>, "Country*" — so it surfaced as an
    // unanswered question offering all ~240 countries, when it should
    // simply be set from the phone number already being filled.
    // matcher.profileValue('phoneCountryCode') derives the value; it
    // returns null (leaving this as an ordinary question, same as before)
    // when the phone's dial code isn't one this can resolve confidently.
    country: 'phoneCountryCode',
  };

  function fieldHint(el) {
    if (!el || !el.id) return null;
    return ID_HINTS[el.id] || null;
  }

  return {
    platform: 'greenhouse',
    findForm,
    extractPostingId,
    isApplicationPage,
    fieldHint,
    ID_HINTS,
  };
});
