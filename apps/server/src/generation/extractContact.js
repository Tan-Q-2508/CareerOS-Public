const mammoth = require('mammoth');
const { classifyLink, orderLinks, labelForLink, normalizeLinkUrl } = require('@careeros/shared');

// The LOCKED header (7.2) needs Name and a contact line
// `City, State | Phone | Email | <recognised links, in registry order>`. The
// 16.2 parsed profile does not capture contact details, so we pull them from
// the stored master .docx at generation time (deterministic — accuracy matters
// for phone/email, so no AI). Missing fields are simply omitted from the header.
//
// Links: every <a> in the header region is classified by
// packages/shared/src/contact/linkTypes.js (host first, anchor text second),
// then the header's plain text is swept for bare URLs typed without a
// hyperlink; the two are de-duped by canonical URL. An unrecognised link is
// kept as { type: 'other' } under a host-derived label rather than dropped.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// The leading \(? is load-bearing. Without it the match starts at the first
// DIGIT, so a resume reading "(415) 555-0100" is stored as "415) 555-0100" — a
// real value found on a live account, with an unbalanced paren that Greenhouse
// happens to strip but a stricter form would submit as-is. Every resume using
// the conventional parenthesised area code hit this, not just one row.
const PHONE_RE = /(\+?\(?\d[\d\s().-]{7,}\d)/;
// "City, ST" — up to 3 capital-initial city words, comma, 2-letter state. Read
// from the CONTACT line only (never the whole header) so the name — which sits
// on its own line right above — is never swept into the city.
const CITY_STATE_RE = /\b([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,2}),\s*([A-Z]{2})\b/;

// Repair a phone whose parentheses do not balance. Two callers need it: fresh
// extraction (against a resume that itself carries a stray paren) and the
// stored column, so a row written before PHONE_RE was corrected heals on the
// next read instead of needing a data migration. Drops the orphan rather than
// guessing where its partner belonged — inventing a character in a phone
// number is worse than a missing one.
function normalizePhone(phone) {
  if (!phone) return phone;
  let out = String(phone).trim();
  const opens = (out.match(/\(/g) || []).length;
  const closes = (out.match(/\)/g) || []).length;
  if (opens !== closes) out = out.replace(/[()]/g, '');
  return out.replace(/\s{2,}/g, ' ').trim() || null;
}

function firstMatch(re, text) {
  const m = (text || '').match(re);
  return m ? m[1] || m[0] : null;
}

// Display form of a URL: no protocol, no www, no trailing slash.
function cleanUrl(u) {
  return String(u || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

// C2: a name parsed/stored ALL-CAPS ("JOHN MCDONALD") renders wrong in the
// résumé header and cover-letter signature — convert to Title Case per word.
// Left untouched otherwise, so a name that already parses correctly (e.g. with
// its own internal capital, "McDonald") is never touched.
function normalizeName(name) {
  if (!name) return name;
  const isAllCaps = name === name.toUpperCase() && name !== name.toLowerCase();
  if (!isAllCaps) return name;
  return name
    .toLowerCase()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Classify every link in a résumé header's HTML into ordered
// { type, url, label } entries (7.2). Anchors first (host, then visible text),
// then a bare-URL sweep of the same region's plain text for links typed
// without a hyperlink; the two are de-duped by canonical URL, and the result
// is sorted into registry order. Pure — unit-testable without a .docx.
function extractLinksFromHeaderHtml(headerHtml) {
  const html = headerHtml || '';
  const links = [];
  const seen = new Set();
  const add = (href, text) => {
    const c = classifyLink(href, text);
    if (!c) return;
    const key = normalizeLinkUrl(c.url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    links.push({ type: c.type, url: c.url, label: c.label });
  };

  for (const m of html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi)) {
    add(m[1], m[2].replace(/<[^>]+>/g, '').trim());
  }
  // Bare URLs typed without a hyperlink (e.g. "github.com/name"). Header text
  // only, with email addresses stripped first so a domain like "example.com"
  // from "jane@example.com" isn't mistaken for a personal link. Anything
  // already seen as an anchor is de-duped away above.
  const headerText = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ');
  for (const m of headerText.matchAll(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"')]*)?)/gi)) {
    const cand = m[1];
    if (/@/.test(cand.split('/')[0])) continue; // an "@" in the authority part — an email, not a link
    // A scheme-less, path-less token ending in a code-ish "TLD" (node.js,
    // next.js) is a library name in the header, not a URL.
    if (!/^https?:\/\//i.test(cand) && !cand.includes('/') && /\.(js|ts|md|py|sh|json)$/i.test(cand)) continue;
    add(cand, '');
  }
  return orderLinks(links);
}

/**
 * @param supabaseAdmin  storage client
 * @param storagePath    'resumes/{user_id}/v{n}.docx' object key
 * @param fullName       users.full_name fallback for the name line
 * @returns { name, cityState, phone, email, links } — links is an ordered
 *           array of { type, url, label }; name/cityState/phone/email may be null.
 */
async function extractContact(supabaseAdmin, storagePath, fullName) {
  let text = '';
  let html = '';
  try {
    const { data, error } = await supabaseAdmin.storage.from('resumes').download(storagePath);
    if (error) throw error;
    const buffer = Buffer.from(await data.arrayBuffer());
    ({ value: text } = await mammoth.extractRawText({ buffer }));
    // HTML preserves hyperlinks — LinkedIn/Portfolio are usually hyperlinks whose
    // visible text is just "LinkedIn"/"Portfolio", so raw text loses their URLs.
    ({ value: html } = await mammoth.convertToHtml({ buffer }));
  } catch (err) {
    // Non-fatal: fall back to whatever we have; header renders what's available.
    console.error('extractContact: could not read master resume:', err.message || err);
  }
  text = text || '';
  html = html || '';

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const email = firstMatch(EMAIL_RE, text);

  // The contact line = the line carrying the email (else the phone). City/state
  // and phone are read from THIS line only, so the name line above is excluded.
  const contactLine =
    lines.find((l) => EMAIL_RE.test(l)) || lines.find((l) => PHONE_RE.test(l)) || lines.slice(0, 3).join('  ');
  const phone = normalizePhone(firstMatch(PHONE_RE, contactLine) || firstMatch(PHONE_RE, text));
  const cs = contactLine.match(CITY_STATE_RE);
  const cityState = cs ? `${cs[1]}, ${cs[2]}` : null;

  // Links from the HEADER region only (before the first section heading), so
  // body citation links (papers, project URLs) aren't mistaken for a personal
  // link.
  const secIdx = html.search(/PROFESSIONAL\s+SUMMARY|\bSUMMARY\b|EXPERIENCE|EDUCATION|SKILLS|PROJECTS/i);
  const headerHtml = secIdx > 0 ? html.slice(0, secIdx) : html.slice(0, 1500);
  const orderedLinks = extractLinksFromHeaderHtml(headerHtml);

  // Name: prefer users.full_name; else the first line that isn't contact-like.
  let name = fullName || null;
  if (!name) {
    name = lines.find((l) => !EMAIL_RE.test(l) && !PHONE_RE.test(l) && !/https?:\/\/|www\./i.test(l) && l.length < 60) || null;
  }
  name = normalizeName(name);

  return { name, cityState, phone, email, links: orderedLinks };
}

// Build the LOCKED contact line (7.2):
// `City, State | Phone | Email | <link labels, registry order>`, single space
// each side of every |, omitting parts that are absent. `contact.links` is
// expected to already be trimmed to what fits the page (metrics.fitContactLinks);
// this just formats whatever it is handed.
function buildContactLine(contact) {
  const parts = [contact.cityState, contact.phone, contact.email];
  for (const l of orderLinks((contact && contact.links) || [])) parts.push(labelForLink(l));
  return parts.filter(Boolean).join(' | ');
}

// Field-name map: contact_manual_fields entries (snake_case, matching the
// header PATCH route's HEADER_FIELDS) -> the camelCase key(s) this function
// resolves. One source of truth for which stored field a manual lock covers.
const MANUAL_FIELD_MAP = {
  name: 'name',
  city_state: 'cityState',
  phone: 'phone',
  email: 'email',
  links: 'links',
};

// CHANGED 2026-08-13 (root-cause pass, migration 20260813000000): resolves
// the contact record a generation/Copilot-seed should actually use, with
// PER-FIELD provenance (contact_manual_fields) replacing the old single
// contact_manual boolean and its "stored column always wins, backfill only
// a NULL once" rule. That old rule was the actual bug: extractContact() DID
// re-read a re-uploaded .docx and DID produce the new URL on every call,
// but a non-null stored column always beat it — so the very FIRST
// generation ever backfilled a URL, and every generation after that,
// including ones following a fresh re-upload, silently discarded whatever
// extractContact() found in favor of the old value. Now: a field the user
// has hand-edited (present in contact_manual_fields) is never touched here;
// every OTHER field is refreshed from a fresh extraction whenever the
// extraction found something, on every call — so a re-upload's new
// portfolio/LinkedIn/etc. link reaches the header on the very next
// generation, not never.
async function resolveContact(db, userId, supabaseAdmin, storagePath, fullName) {
  const { data: u } = await db
    .from('users')
    .select('contact_name, contact_city_state, contact_phone, contact_email, contact_links, contact_manual_fields')
    .eq('id', userId)
    .maybeSingle();
  const stored = u || {};
  const manualFields = new Set(stored.contact_manual_fields || []);

  const fromColumns = () => ({
    name: stored.contact_name,
    cityState: stored.contact_city_state,
    phone: stored.contact_phone,
    email: stored.contact_email,
    links: Array.isArray(stored.contact_links) ? stored.contact_links : [],
  });

  // Nothing left that a fresh extraction could ever change — skip the
  // storage download + docx parse entirely.
  if (Object.keys(MANUAL_FIELD_MAP).every((f) => manualFields.has(f))) return fromColumns();

  const extracted = await extractContact(supabaseAdmin, storagePath, fullName);
  const cols = fromColumns();

  // Per-field: a MANUAL field is never touched here (it's owned by the header
  // PATCH route). A non-manual scalar is refreshed from THIS extraction
  // whenever the extraction found something for it — a fresh read wins over
  // whatever was merely stored before, the direct fix for the stale-link bug.
  // The link SET is merged as a unit (that is how a user edits it): a fresh
  // extraction that found any link replaces the stored array; one that found
  // none keeps the last known array rather than clearing it.
  const freshLinks = extracted.links && extracted.links.length ? extracted.links : cols.links;
  const resolved = {
    name: manualFields.has('name') ? cols.name : extracted.name || cols.name,
    cityState: manualFields.has('city_state') ? cols.cityState : extracted.cityState || cols.cityState,
    phone: normalizePhone(manualFields.has('phone') ? cols.phone : extracted.phone || cols.phone),
    email: manualFields.has('email') ? cols.email : extracted.email || cols.email,
    links: manualFields.has('links') ? cols.links : freshLinks,
  };

  // Persist the refresh so the stored columns stay in sync for OTHER
  // readers too (e.g. the Copilot header editor's initial values) without
  // waiting for another generation — mirrors the old backfill's
  // fire-and-forget write, just per-field and not gated on "only if null".
  const patch = {};
  if (!manualFields.has('name') && resolved.name !== cols.name) patch.contact_name = resolved.name;
  if (!manualFields.has('city_state') && resolved.cityState !== cols.cityState) patch.contact_city_state = resolved.cityState;
  if (!manualFields.has('phone') && resolved.phone !== cols.phone) patch.contact_phone = resolved.phone;
  if (!manualFields.has('email') && resolved.email !== cols.email) patch.contact_email = resolved.email;
  if (!manualFields.has('links') && JSON.stringify(resolved.links) !== JSON.stringify(cols.links)) patch.contact_links = resolved.links;
  if (Object.keys(patch).length) {
    db.from('users').update(patch).eq('id', userId).then(({ error }) => {
      if (error) console.error('resolveContact refresh failed:', error.message);
    });
  }

  return resolved;
}

module.exports = { extractContact, extractLinksFromHeaderHtml, resolveContact, buildContactLine, cleanUrl, normalizePhone, EMAIL_RE, PHONE_RE };
