// linkTypes.js — the one registry of contact / social links a résumé header can
// carry (spec 7.2). Extraction (apps/server/src/generation/extractContact.js),
// the .docx renderer (renderResume.js), the layout measurer (metrics.js), the
// Copilot header editor (routes/copilot.js + apps/web) and the autofill profile
// endpoint all read this list — it is the single source of truth for which
// platforms are recognised, what label each renders as, and the left-to-right
// order they appear in the contact line.
//
// Plain CommonJS, zero dependencies, so the browser bundle (apps/web, via the
// vite workspace alias) and the Node server load the exact same file.
//
// ORDER MATTERS: the array order below is the render order in the contact line,
// after `City, State | Phone | Email`. `other` (an unrecognised link, kept so
// every link in the master résumé still carries through) always sorts last.

// A recognised platform.
//   type       stable key stored in users.contact_links[].type
//   label      the visible, clickable word in the résumé header
//   hosts      hostname patterns (matched on the www-stripped, lowercased host)
//   labelHints anchor visible-text patterns, consulted only when no host matched
const LINK_TYPES = [
  { type: 'linkedin', label: 'LinkedIn', hosts: [/(^|\.)linkedin\.com$/], labelHints: [/linkedin/] },
  { type: 'github', label: 'GitHub', hosts: [/(^|\.)github\.com$/, /(^|\.)github\.io$/], labelHints: [/git\s*hub/] },
  { type: 'gitlab', label: 'GitLab', hosts: [/(^|\.)gitlab\.com$/], labelHints: [/git\s*lab/] },
  { type: 'portfolio', label: 'Portfolio', hosts: [], labelHints: [/portfolio/] },
  { type: 'website', label: 'Website', hosts: [], labelHints: [/\b(website|homepage|personal site)\b/] },
  { type: 'scholar', label: 'Scholar', hosts: [/(^|\.)scholar\.google\.[a-z.]+$/], labelHints: [/\bscholar\b/] },
  { type: 'orcid', label: 'ORCID', hosts: [/(^|\.)orcid\.org$/], labelHints: [/\borcid\b/] },
  { type: 'twitter', label: 'Twitter/X', hosts: [/(^|\.)twitter\.com$/, /(^|\.)x\.com$/], labelHints: [/\btwitter\b/] },
  { type: 'medium', label: 'Medium', hosts: [/(^|\.)medium\.com$/, /(^|\.)substack\.com$/], labelHints: [/\b(medium|substack|blog)\b/] },
  { type: 'behance', label: 'Behance', hosts: [/(^|\.)behance\.net$/], labelHints: [/\bbehance\b/] },
  { type: 'dribbble', label: 'Dribbble', hosts: [/(^|\.)dribbble\.com$/], labelHints: [/\bdribbble\b/] },
  { type: 'stackoverflow', label: 'Stack Overflow', hosts: [/(^|\.)stackoverflow\.com$/], labelHints: [/\bstack\s*overflow\b/] },
  { type: 'kaggle', label: 'Kaggle', hosts: [/(^|\.)kaggle\.com$/], labelHints: [/\bkaggle\b/] },
  { type: 'youtube', label: 'YouTube', hosts: [/(^|\.)youtube\.com$/, /(^|\.)youtu\.be$/], labelHints: [/\byoutube\b/] },
  { type: 'instagram', label: 'Instagram', hosts: [/(^|\.)instagram\.com$/], labelHints: [/\binstagram\b/] },
];

// Hard ceiling on stored links, so a pasted-in header or a malicious PATCH
// can't grow the JSONB blob without bound. The render pass trims well below
// this to hold the one-page rule (7.1); this is just the storage guard.
const MAX_LINKS = (() => {
  try {
    // eslint-disable-next-line global-require
    return require('../tunables.json').generation.contactLinks.maxStored || 16;
  } catch {
    return 16;
  }
})();

const TYPE_ORDER = new Map(LINK_TYPES.map((t, i) => [t.type, i]));
const TYPE_LABEL = new Map(LINK_TYPES.map((t) => [t.type, t.label]));

// Second-level-domain-only TLDs, so hostLabel('me.example.co.uk') -> "Example".
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za',
  'co.in', 'co.jp', 'com.br', 'com.sg', 'com.hk',
]);

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// A display label for an unrecognised host: its registrable name, Title-cased
// (notion.site -> "Notion", danielsblog.dev -> "Danielsblog").
function hostLabel(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length < 2) return parts.length ? cap(parts[0]) : 'Link';
  const lastTwo = parts.slice(-2).join('.');
  const idx = TWO_PART_TLDS.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  return cap(parts[idx >= 0 ? idx : 0]);
}

// www-stripped, lowercased hostname of an href that may lack a scheme. '' if it
// doesn't parse as a web URL at all.
function hostOf(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProto).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

// Canonical form for de-duping: no scheme, no www, no trailing slash, lowercased.
// Mirrors extractContact.js's cleanUrl so an anchor and a bare-text mention of
// the same link collapse to one.
function normalizeLinkUrl(u) {
  return String(u || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// href + anchor text -> { type, label, url } for a recognised platform, an
// { type: 'other', label: <host-derived> } for anything else that is still a
// real web link, or null for mailto:/tel:/non-URL noise.
function classifyLink(href, text) {
  const raw = String(href || '').trim();
  if (!raw || /^(mailto:|tel:)/i.test(raw)) return null;
  const host = hostOf(raw);
  if (!host || !host.includes('.')) return null;
  const label = String(text || '').trim().toLowerCase();

  for (const t of LINK_TYPES) {
    if (t.hosts.some((re) => re.test(host))) return { type: t.type, label: t.label, url: raw };
  }
  for (const t of LINK_TYPES) {
    if (t.labelHints.some((re) => re.test(label))) return { type: t.type, label: t.label, url: raw };
  }
  return { type: 'other', label: hostLabel(host), url: raw };
}

function isKnownLinkType(type) {
  return TYPE_ORDER.has(type) || type === 'other';
}

// The label a stored link renders as: its own `label` (the only meaningful
// carrier for `other`), else the registry label for its type.
function labelForLink(link) {
  if (link && link.label) return link.label;
  return (link && TYPE_LABEL.get(link.type)) || 'Link';
}

function labelForType(type) {
  return TYPE_LABEL.get(type) || 'Link';
}

// Registry order; `other` and unknown types keep document order, after all
// recognised ones. Stable.
function orderLinks(links) {
  return (Array.isArray(links) ? links.slice() : [])
    .map((l, i) => [l, i])
    .sort((a, b) => {
      const oa = TYPE_ORDER.has(a[0].type) ? TYPE_ORDER.get(a[0].type) : 999;
      const ob = TYPE_ORDER.has(b[0].type) ? TYPE_ORDER.get(b[0].type) : 999;
      return oa - ob || a[1] - b[1];
    })
    .map((x) => x[0]);
}

// The dropdown options the Copilot header editor offers (no `other` — that
// only ever arises from extraction).
function selectableLinkTypes() {
  return LINK_TYPES.map((t) => ({ type: t.type, label: t.label }));
}

module.exports = {
  LINK_TYPES,
  MAX_LINKS,
  classifyLink,
  isKnownLinkType,
  labelForLink,
  labelForType,
  orderLinks,
  normalizeLinkUrl,
  hostLabel,
  selectableLinkTypes,
};
