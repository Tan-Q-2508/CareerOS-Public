// tokenBridge.js — content script, runs ONLY on the CareerOS web origin.
//
// The whole login story for the extension: the web app already holds a valid
// Supabase session in localStorage under the standard `sb-<project-ref>-auth-
// token` key. This reads that session's access token and hands it to the
// background worker. No second sign-in, no password, no long-lived API key,
// nothing new for the user to revoke — if they sign out of the web app, the
// token expires and the extension stops working on its own.
//
// It deliberately reads nothing else out of the page, and it never sends the
// token anywhere except chrome.storage.local via the background worker.

(function () {
  function readSupabaseSession() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key));
        // supabase-js v2 stores either the session directly or wrapped in
        // { currentSession } depending on version — handle both.
        const session = parsed && (parsed.access_token ? parsed : parsed.currentSession);
        if (session && session.access_token) return session;
      } catch {
        // Not our key, or not JSON — skip it.
      }
    }
    return null;
  }

  function sync() {
    // Reloading the extension (chrome://extensions -> reload icon, or an
    // auto-update) invalidates every content script it had already injected
    // into open tabs — chrome.runtime.id becomes undefined on this now-dead
    // copy, and any further chrome.runtime.sendMessage call throws
    // "Extension context invalidated" as an UNCAUGHT error (confirmed live:
    // it surfaced on the CareerOS web app's own tab after a reload during
    // testing). The tab has to be reloaded to get a fresh, live content
    // script; until then, this stale copy should just go quiet rather than
    // throw into the console of the user's own app.
    if (!chrome.runtime || !chrome.runtime.id) return;

    const session = readSupabaseSession();
    if (!session) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'setToken',
          payload: { accessToken: session.access_token, expiresAt: session.expires_at || null },
        },
        () => {
          // Reading lastError (even to ignore it) prevents Chrome's own
          // "Unchecked runtime.lastError" console warning when the
          // extension side has already gone away between the guard above
          // and this call landing.
          void chrome.runtime.lastError;
        }
      );
    } catch {
      // Context invalidated between the guard above and the call itself —
      // same stale-copy case, already handled by going quiet.
    }
  }

  sync();
  // The app refreshes its session in the background; re-sync on focus so a
  // long-lived tab keeps the extension's copy current.
  window.addEventListener('focus', sync);
  window.addEventListener('storage', sync);
})();
