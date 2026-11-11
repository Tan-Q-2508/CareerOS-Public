// background.js — the extension's service worker (MV3).
//
// Everything that touches the network or the user's session lives here, and
// nothing else does. The content script running inside a job board's page can
// ask for a profile or an answer lookup, but never sees the JWT and never
// makes an API call itself — a page-context fetch would both leak the token
// into a third party's origin and drag CORS/CSP into the picture for no gain.
//
// Auth: the token bridge (src/auth/tokenBridge.js) reads the session the web
// app ALREADY holds and hands the access token here. That's the whole login
// story — no second sign-in, no long-lived key, nothing new to revoke. When
// the token expires the user just needs to have the CareerOS tab open once
// more; the bridge refreshes it on every visit.

const API_BASE = 'https://careeros-server.onrender.com';
const TOKEN_KEY = 'careeros_access_token';
const TOKEN_EXP_KEY = 'careeros_access_token_exp';

async function getToken() {
  const stored = await chrome.storage.local.get([TOKEN_KEY, TOKEN_EXP_KEY]);
  const token = stored[TOKEN_KEY];
  const exp = stored[TOKEN_EXP_KEY];
  if (!token) return null;
  // Treat a token within 60s of expiry as already gone, so a call can't fail
  // halfway through a fill.
  if (exp && Date.now() > exp * 1000 - 60000) return null;
  return token;
}

async function api(path, { method = 'GET', body } = {}) {
  const token = await getToken();
  if (!token) {
    return { ok: false, status: 401, error: 'not_connected' };
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data && data.error) || `http_${res.status}` };
}

// Fetches the résumé through the signed URL and returns it as a data URL —
// content scripts can't be handed a File across the message boundary, so the
// page side rebuilds it (see contentScript.js). Signed URLs are short-lived
// (5 min) and single-purpose, so this never becomes a durable link.
async function fetchResumeAsDataUrl(documentId) {
  const qs = documentId ? `?document_id=${encodeURIComponent(documentId)}` : '';
  const meta = await api(`/api/autofill/resume-file${qs}`);
  if (!meta.ok) return meta;

  const fileRes = await fetch(meta.data.url);
  if (!fileRes.ok) return { ok: false, error: `resume_download_${fileRes.status}` };
  const blob = await fileRes.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  return {
    ok: true,
    data: {
      dataUrl,
      filename: meta.data.filename,
      source: meta.data.source,
      mimeType: blob.type || 'application/octet-stream',
    },
  };
}

const handlers = {
  // Called by the token bridge on the CareerOS web origin.
  async setToken({ accessToken, expiresAt }) {
    await chrome.storage.local.set({ [TOKEN_KEY]: accessToken, [TOKEN_EXP_KEY]: expiresAt || null });
    return { ok: true };
  },

  async connectionStatus() {
    const token = await getToken();
    return { ok: true, data: { connected: Boolean(token) } };
  },

  async getProfile() {
    return api('/api/autofill/profile');
  },

  async lookupAnswers({ questions }) {
    return api('/api/autofill/answers/lookup', { method: 'POST', body: { questions } });
  },

  async saveAnswer({ question, answer, answerType, platform }) {
    return api('/api/autofill/answers', {
      method: 'POST',
      body: { question, answer, answer_type: answerType, platform },
    });
  },

  async matchJob({ url }) {
    return api(`/api/autofill/job-match?url=${encodeURIComponent(url)}`);
  },

  async getResume({ documentId }) {
    return fetchResumeAsDataUrl(documentId);
  },

  // Reuses CareerOS's existing job Q&A feature (spec 8.6) — the same
  // grounded, no-fabrication strong-tier call the web app's job detail page
  // already uses for "explain your experience with X" style questions. Real
  // AI cost, billed the same way (tunables.flatFees.application_qa + real AI
  // cost), by explicit user click only — never triggered automatically. The
  // route persists the pair to job_question_answers (job-scoped) on its own;
  // separately, contentScript.js deliberately does NOT forward an
  // AI-generated answer into POST /api/autofill/answers (the CROSS-JOB
  // reusable bank) — a narrative answer written for one company ("why do you
  // want to join Acme?") would be actively wrong if silently reused verbatim
  // on a different company's form.
  async generateAnswer({ jobId, question }) {
    if (!jobId) return { ok: false, error: 'no_matched_job' };
    return api(`/api/jobs/${encodeURIComponent(jobId)}/answer-question`, {
      method: 'POST',
      body: { question },
    });
  },
};

// ---------------------------------------------------------------------------
// On-demand injection (toolbar button).
//
// The content_scripts entries in manifest.json cover the platforms' OWN hosts,
// which is where the great majority of application forms live — including,
// since `all_frames: true`, an ATS iframe embedded in a company's own page
// (fastly.com/about/jobs/apply?gh_jid=… renders its form from
// job-boards.greenhouse.io/embed/job_app, which is still a greenhouse.io URL
// and so still a declared match). That covers the embedded case without asking
// for a single new host.
//
// What it does not cover is a company page that reaches a platform some other
// way, or a shape not yet known. Matching `https://*/*` would fix that by
// running this extension on every page on the web, which is a real privacy
// cost and an install-time warning to match, for a feature the user invokes a
// handful of times a week. `activeTab` is the narrow form of the same thing:
// clicking the toolbar button grants access to THAT tab, at that moment,
// because the user asked for it — no standing permission on any site.
const CORE_FILES = [
  'src/core/normalizeQuestion.js',
  'src/core/fieldMap.js',
  'src/core/guards.js',
  'src/core/matcher.js',
  'src/core/filler.js',
  'src/ui/panel.js',
];
const ADAPTER_FILE = {
  greenhouse: 'src/adapters/greenhouse.js',
  lever: 'src/adapters/lever.js',
  ashby: 'src/adapters/ashby.js',
  workable: 'src/adapters/workable.js',
  workday: 'src/adapters/workday.js',
  // Never chosen by a manifest match — only as the fallback below, on a page
  // the user has pointed the button at. See src/adapters/generic.js.
  generic: 'src/adapters/generic.js',
};

function platformFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (/(^|\.)ashbyhq\.com$/.test(host)) return 'ashby';
  if (/(^|\.)lever\.co$/.test(host)) return 'lever';
  if (/(^|\.)greenhouse\.io$/.test(host)) return 'greenhouse';
  if (/(^|\.)workable\.com$/.test(host)) return 'workable';
  if (/(^|\.)myworkday(jobs|site)\.com$/.test(host)) return 'workday';
  // The embedded case, and the reason this whole path exists: the company's
  // own domain carries Greenhouse's posting id as a query parameter.
  if (url.searchParams.get('gh_jid')) return 'greenhouse';
  return null;
}

// Runs IN the page. Identifies the platform from markup when the URL says
// nothing, and reports whether the modules are already loaded so a second
// click doesn't stack a second copy of everything.
//
// When no platform is recognised it reports how many fillable controls the
// frame has, which is what lets the caller decide between the generic adapter
// and an honest "nothing here to fill". Counted here rather than in the
// service worker because only the page can see its own DOM, and counted the
// same way generic.js counts (see its SKIP_TYPES) so the two agree on what a
// control is.
function probePage() {
  if (window.__careerosAutofill) return { already: true };
  const has = (sel) => Boolean(document.querySelector(sel));
  if (has('.ashby-application-form-container, [data-field-path]')) return { platform: 'ashby' };
  if (has('form[action*="lever.co"], [name^="cards["], .application-form .application-question')) {
    return { platform: 'lever' };
  }
  if (has('#application-form, [id^="question_"], #s3_upload_for_resume')) return { platform: 'greenhouse' };
  if (has('form[data-ui="application-form"]')) return { platform: 'workable' };
  if (has('[data-automation-id="applyFlowPage"]')) return { platform: 'workday' };

  const skip = ['hidden', 'submit', 'button', 'image', 'reset', 'search'];
  const controls = Array.from(document.querySelectorAll('input, textarea, select')).filter((el) => {
    const type = (el.type || '').toLowerCase();
    if (el.tagName.toLowerCase() === 'input' && skip.indexOf(type || 'text') !== -1) return false;
    if (type === 'file') return true; // routinely hidden behind a styled label
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
  return { platform: null, controls: controls.length };
}

// Re-opens the panel on a page that already has the modules, so the button
// works the same way on a matched host as on an embedded one.
function relaunch() {
  if (window.__careerosAutofill) window.__careerosAutofill.buildAndShowPlan();
}

function notify(tabId, title, message) {
  return chrome.scripting.executeScript({
    target: { tabId },
    args: [title, message],
    func: (t, m) => {
      // eslint-disable-next-line no-alert
      window.alert(`${t}\n\n${m}`);
    },
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) return;
  try {
    // Probe EVERY frame, not just the top one. Greenhouse's JS embed puts the
    // real form inside an <iframe> on the company's own domain, so the top
    // frame of fastly.com/about/jobs/apply?gh_jid=… contains no <form> at all
    // — probing only there reported "no application form found" on a page that
    // plainly had one. `allFrames` needs the tab-wide grant, so a browser that
    // refuses it falls back to the top frame rather than failing the click.
    let probes;
    try {
      probes = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: probePage,
      });
    } catch {
      probes = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage });
    }
    const results = (probes || []).filter(Boolean);

    // A frame that already has the modules wins outright — that's the one the
    // declarative content script matched, and re-injecting would stack a
    // second copy of everything.
    const loaded = results.find((p) => p.result && p.result.already);
    if (loaded) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [loaded.frameId || 0] },
        func: relaunch,
      });
      return;
    }

    // Otherwise prefer whichever frame's own markup identifies a platform; the
    // URL is only consulted for the top frame, since that's the one it names.
    const detected = results.find((p) => p.result && p.result.platform);
    let platform = (detected && detected.result.platform) || platformFromUrl(tab.url);
    let frameId = detected ? detected.frameId || 0 : 0;

    // No platform anywhere in the tab — a company running its own application
    // system. Fall back to the generic adapter, in whichever frame actually
    // holds the fields, provided there are enough of them to be a form rather
    // than a login box or a search bar. This threshold mirrors generic.js's
    // MIN_CONTROLS; the adapter re-checks properly on the page side, so this
    // one only has to be cheap enough to run in every frame.
    if (!platform) {
      const richest = results.reduce((best, p) => {
        const count = (p.result && p.result.controls) || 0;
        const bestCount = (best && best.result && best.result.controls) || 0;
        return count > bestCount ? p : best;
      }, null);
      if (richest && richest.result.controls >= 4) {
        platform = 'generic';
        frameId = richest.frameId || 0;
      }
    }

    if (!platform) {
      await notify(
        tab.id,
        'CareerOS Autofill',
        'CareerOS could not find an application form on this page.'
      );
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      files: [...CORE_FILES, ADAPTER_FILE[platform], 'src/contentScript.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      func: relaunch,
    });
  } catch (e) {
    // Most often a page the browser refuses to script at all (the Chrome Web
    // Store, a PDF viewer). Nothing to recover; say so rather than failing mute.
    console.warn('[careeros] on-demand injection failed', e);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message && message.type];
  if (!handler) {
    sendResponse({ ok: false, error: `unknown_message_type:${message && message.type}` });
    return false;
  }
  handler(message.payload || {})
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true; // keep the channel open for the async response
});
