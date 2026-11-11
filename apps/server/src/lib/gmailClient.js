// Minimal Gmail REST client (spec §9.1). Two operations only — a batched search
// and a per-message fetch — hand-rolled with fetch to avoid pulling in the heavy
// googleapis SDK. Runs under a per-user access token (see googleOAuth.js) with
// the gmail.readonly scope, so it can read subject/snippet/from/date.

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailGet(accessToken, path) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (json.error && json.error.message) || `Gmail API HTTP ${resp.status}`;
    throw Object.assign(new Error(msg), { status: resp.status });
  }
  return json;
}

// One batched search across all in-scope terms (spec §9.1.2 — a single search,
// not one call per application). Returns up to `max` message ids.
async function searchMessages(accessToken, q, max = 25) {
  const params = new URLSearchParams({ q, maxResults: String(max) });
  const json = await gmailGet(accessToken, `/messages?${params.toString()}`);
  return (json.messages || []).map((m) => m.id);
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function base64UrlDecode(data) {
  if (!data) return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Walk the MIME part tree for the best body text — prefer text/plain, else
// text/html (tags stripped). Multipart emails nest parts arbitrarily deep.
function extractBodyText(payload) {
  const plain = [];
  const html = [];
  (function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      plain.push(base64UrlDecode(part.body.data));
    } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
      html.push(base64UrlDecode(part.body.data));
    }
    (part.parts || []).forEach(walk);
  })(payload);
  if (plain.length) return plain.join('\n');
  if (html.length) return stripHtml(html.join('\n'));
  return '';
}

// Cap how much body text reaches the classifier — enough to capture a
// templated ATS email's actual decision (which routinely sits a sentence or
// two past Gmail's own auto-snippet), without blowing up per-email tokens
// across a 50-candidate batch.
const BODY_MAX_CHARS = 1200;

// Fetch one message: headers + Gmail's own snippet + the actual body text
// (bounded). `format=full` is needed for the body — `metadata` alone (the
// prior approach) only ever returns Gmail's auto-generated snippet, which
// can cut off before an email's actual content: confirmed live on a real
// rejection template whose snippet stopped at "thanks for applying" and
// never reached "we won't be able to invite you to the next round" a few
// sentences later — the classifier had no way to see the real decision.
async function getMessage(accessToken, id) {
  const params = new URLSearchParams({ format: 'full' });
  const json = await gmailGet(accessToken, `/messages/${id}?${params.toString()}`);
  const headers = json.payload && json.payload.headers;
  const body = extractBodyText(json.payload).slice(0, BODY_MAX_CHARS);
  return {
    id: json.id,
    from: headerValue(headers, 'From'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    // Gmail's own receipt time (epoch ms as a string) — reliable for recency
    // ordering when one application has several matching emails.
    internalDate: Number(json.internalDate) || 0,
    snippet: json.snippet || '',
    body,
  };
}

module.exports = { searchMessages, getMessage };
