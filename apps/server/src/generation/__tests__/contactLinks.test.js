#!/usr/bin/env node
// contactLinks.test.js — the expanded résumé-header link set (spec 7.2,
// 2026-08-26). Covers the shared registry (classify/order), the header-HTML
// link extractor, the LOCKED contact-line builder, and the 2-line page-fit
// trim in metrics.fitContactLinks.
//
// No test framework in this repo — plain Node + assert:
//   node apps/server/src/generation/__tests__/contactLinks.test.js
// Exits non-zero on any failure.

const assert = require('assert');
const { classifyLink, orderLinks, labelForLink, isKnownLinkType } = require('@careeros/shared');
const { extractLinksFromHeaderHtml, buildContactLine } = require('../extractContact');
const { fitContactLinks } = require('../metrics');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('classifyLink — host recognition:');
check('linkedin.com -> linkedin', () => {
  assert.strictEqual(classifyLink('https://www.linkedin.com/in/jane', '').type, 'linkedin');
});
check('github.com -> github', () => {
  assert.strictEqual(classifyLink('https://github.com/jane', '').type, 'github');
});
check('scheme-less github.com -> github', () => {
  assert.strictEqual(classifyLink('github.com/jane', '').type, 'github');
});
check('scholar.google.com -> scholar', () => {
  assert.strictEqual(classifyLink('https://scholar.google.com/citations?user=x', '').type, 'scholar');
});
check('x.com -> twitter', () => {
  assert.strictEqual(classifyLink('https://x.com/jane', '').type, 'twitter');
});
check('substack.com -> medium', () => {
  assert.strictEqual(classifyLink('https://jane.substack.com', '').type, 'medium');
});

console.log('classifyLink — label fallback + other:');
check('unknown host, "Portfolio" text -> portfolio', () => {
  assert.strictEqual(classifyLink('https://janedoe.dev', 'Portfolio').type, 'portfolio');
});
check('unknown host, no hint -> other with host-derived label', () => {
  const c = classifyLink('https://notion.site/jane', '');
  assert.strictEqual(c.type, 'other');
  assert.strictEqual(c.label, 'Notion');
});
check('mailto: -> null', () => {
  assert.strictEqual(classifyLink('mailto:jane@x.com', ''), null);
});
check('tel: -> null', () => {
  assert.strictEqual(classifyLink('tel:+15551234567', ''), null);
});

console.log('isKnownLinkType:');
check('github is known', () => assert.ok(isKnownLinkType('github')));
check('other is accepted', () => assert.ok(isKnownLinkType('other')));
check('garbage is rejected', () => assert.ok(!isKnownLinkType('myspace')));

console.log('orderLinks — registry order, other last:');
check('reorders to registry order, other last', () => {
  const out = orderLinks([
    { type: 'other', url: 'a', label: 'A' },
    { type: 'medium', url: 'm', label: 'Medium' },
    { type: 'github', url: 'g', label: 'GitHub' },
    { type: 'linkedin', url: 'l', label: 'LinkedIn' },
  ]).map(labelForLink);
  assert.deepStrictEqual(out, ['LinkedIn', 'GitHub', 'Medium', 'A']);
});

console.log('extractLinksFromHeaderHtml:');
check('anchors + bare text, deduped, ordered', () => {
  const html = [
    '<p>Jane Doe</p>',
    '<p>Boston, MA | jane@example.com | ',
    '<a href="https://www.linkedin.com/in/janedoe">LinkedIn</a> | ',
    '<a href="https://github.com/janedoe">GitHub</a> | ',
    'twitter.com/janedoe | ',
    '<a href="https://github.com/janedoe">code</a></p>', // dup of the GitHub anchor
  ].join('');
  const links = extractLinksFromHeaderHtml(html);
  assert.deepStrictEqual(links.map((l) => l.type), ['linkedin', 'github', 'twitter']);
  assert.strictEqual(links.filter((l) => l.type === 'github').length, 1);
});
check('a bare medium.com/@handle is caught', () => {
  const links = extractLinksFromHeaderHtml('<p>jane@x.com medium.com/@janedoe</p>');
  assert.deepStrictEqual(links.map((l) => l.type), ['medium']);
});
check('no links -> empty array', () => {
  assert.deepStrictEqual(extractLinksFromHeaderHtml('<p>Jane Doe — Boston, MA</p>'), []);
});
check('an email domain is not scraped as a bare link', () => {
  assert.deepStrictEqual(extractLinksFromHeaderHtml('<p>jane.doe@acme.com | (415) 555-0100</p>'), []);
});
check('"Node.js" in the header is not a link', () => {
  assert.deepStrictEqual(extractLinksFromHeaderHtml('<p>Jane Doe — Node.js, React</p>'), []);
});

console.log('buildContactLine — LOCKED format, registry order:');
check('city | phone | email | <labels>', () => {
  const line = buildContactLine({
    cityState: 'Boston, MA',
    phone: '(415) 555-0100',
    email: 'jane@example.com',
    links: [
      { type: 'github', url: 'https://github.com/j', label: 'GitHub' },
      { type: 'linkedin', url: 'https://linkedin.com/in/j', label: 'LinkedIn' },
    ],
  });
  assert.strictEqual(line, 'Boston, MA | (415) 555-0100 | jane@example.com | LinkedIn | GitHub');
});
check('absent parts are skipped', () => {
  assert.strictEqual(buildContactLine({ email: 'j@x.com', links: [] }), 'j@x.com');
});

console.log('fitContactLinks — 2-line page-fit trim (7.1):');
check('a short set is kept whole, nothing dropped', () => {
  const { links, dropped, contactLine } = fitContactLinks({
    cityState: 'Boston, MA',
    phone: '(415) 555-0100',
    email: 'jane@example.com',
    links: [
      { type: 'linkedin', url: 'x', label: 'LinkedIn' },
      { type: 'github', url: 'x', label: 'GitHub' },
      { type: 'portfolio', url: 'x', label: 'Portfolio' },
    ],
  });
  assert.strictEqual(links.length, 3);
  assert.deepStrictEqual(dropped, []);
  assert.ok(contactLine.endsWith('LinkedIn | GitHub | Portfolio'));
});
const FULL_SET = ['linkedin', 'github', 'gitlab', 'portfolio', 'website', 'scholar', 'orcid', 'twitter', 'medium', 'behance', 'dribbble', 'stackoverflow', 'kaggle', 'youtube', 'instagram']
  .map((type) => ({ type, url: `https://example.com/${type}`, label: null }));

check('the full 15-platform set still fits the generous 2-line budget', () => {
  const { links, dropped } = fitContactLinks({
    cityState: 'San Francisco, CA', phone: '(415) 555-0100', email: 'jane.doe@example.com', links: FULL_SET,
  });
  assert.strictEqual(links.length, FULL_SET.length);
  assert.deepStrictEqual(dropped, []);
});

check('when the line must fit ONE line, the overflow is dropped lowest-priority-first', () => {
  const { links, dropped } = fitContactLinks(
    { cityState: 'San Francisco, CA', phone: '(415) 555-0100', email: 'jane.doe@example.com', links: FULL_SET },
    { maxLines: 1 }
  );
  assert.ok(links.length > 0 && links.length < FULL_SET.length, 'expected a proper prefix kept');
  // kept links are the highest-priority prefix; dropped are the rest, in order
  assert.deepStrictEqual(
    [...links.map((l) => l.type), ...dropped],
    FULL_SET.map((l) => l.type)
  );
  assert.strictEqual(dropped[dropped.length - 1], 'instagram');
});

console.log(`\n${passed} checks passed.`);
