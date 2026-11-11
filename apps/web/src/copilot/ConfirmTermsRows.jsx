import { api } from '../lib/api';

// Shared "Have you actually used X?" confirm-once rows (Phase 3 bug fix,
// 2026-08-02) — extracted from AddBulletRow's original inline implementation
// so the custom-bullet, manual-edit, AI rewrite/inject-keyword, and Skills
// editor all drive the exact same confirm-retry UX rather than four
// hand-copied loops that could quietly drift apart.
//
// `pendingTerms` / `setPendingTerms` / `error` / `setError` are owned by the
// caller (plain useState) so each caller's own submit/retry function stays in
// its own component; this only renders the rows and does the two network-y
// steps common to all of them: confirm the term, then re-run the caller's
// submit.
export function ConfirmTermsRows({ pendingTerms, busy, setBusy, setPendingTerms, setError, retry }) {
  if (!pendingTerms || !pendingTerms.length) return null;

  async function confirmTerm(term) {
    setBusy(true);
    try {
      await api.confirmSkill(term, '');
      setPendingTerms((cur) => (cur || []).filter((t) => t !== term));
      // Re-attempt the same submission — the server re-derives the
      // confirm-once gate fresh, so this resolves the next unconfirmed term
      // (if any) or succeeds outright.
      await retry();
    } catch (e) {
      setError({ message: e.message });
      setBusy(false);
    }
  }

  return (
    <div className="wb-confirm-rows">
      {pendingTerms.map((term) => (
        <div key={term} className="wb-confirm-row">
          <span>Have you actually used &quot;{term}&quot;?</span>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => confirmTerm(term)}>
            Yes, confirm
          </button>
        </div>
      ))}
    </div>
  );
}

// Shared error-shape handling: given a caught request error, either stage its
// needs_confirmation terms or surface it as a plain message. Used identically
// by every caller above.
export function handleSubmitError(e, setPendingTerms, setError) {
  const code = e.body && e.body.code;
  if (code === 'needs_confirmation') {
    const terms = (e.body.keywords && e.body.keywords.length ? e.body.keywords : [e.body.keyword]).filter(Boolean);
    setPendingTerms(terms);
    setError({ message: e.message, code });
  } else {
    setPendingTerms(null);
    setError({ message: e.message, code });
  }
}
