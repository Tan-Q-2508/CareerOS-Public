// HTML -> plain text for ATS Direct job descriptions (spec 4.6.1).
//
// Why this exists rather than reusing apps/server/src/lib/gmailClient.js's
// stripHtml: that one strips tags BEFORE decoding entities, and Greenhouse's
// `content` field is DOUBLE-escaped ("&lt;h2&gt;Who we are&lt;/h2&gt;"). Against
// that input the tag-strip pass finds no literal "<" at all, then the entity
// decode turns the escaped markup into real tags — so raw "<h2>" survives into
// what's supposed to be plain text. Confirmed against a real Stripe board.
// The fix is ordering: decode -> strip -> decode again (the second pass catches
// entities that were themselves escaped inside the markup, e.g. "&amp;#39;").
// It also belongs in packages/shared, since the adapters live here, not in the
// server app.

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  trade: '™',
  reg: '®',
  copy: '©',
  deg: '°',
  eacute: 'é',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    const named = NAMED[body.toLowerCase()];
    return named !== undefined ? named : m;
  });
}

// Block-level tags become newlines so bullet lists and paragraphs don't run
// together into one wall of text — the pre-filter and the scoring prompt both
// read this, and requirement bullets losing their boundaries hurts both.
function stripTags(s) {
  return s
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // Not </li> — the opening <li> below already starts its own line, and
    // adding one at both ends double-spaces every bullet in a requirements list.
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|section)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
}

function collapse(s) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert an HTML (or entity-escaped HTML) job description into plain text.
 * Safe on input that is already plain text — it just collapses whitespace.
 */
function htmlToText(input) {
  if (input == null) return '';
  const s = String(input);
  if (!s.trim()) return '';
  return collapse(decodeEntities(stripTags(decodeEntities(s))));
}

module.exports = { htmlToText, decodeEntities };
