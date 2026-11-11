#!/usr/bin/env node
// genericAdapter.test.js — regression suite for the generic adapter
// (spec §15 session 57, §17.2):
//   node apps/extension/src/adapters/__tests__/genericAdapter.test.js
//
// The other adapters are thin enough to test with ad-hoc fake objects, which
// is what autofill.test.js does. This one is not: every decision it makes is a
// DOM-STRUCTURE decision — how deep a container is, what sits in a previous
// sibling, how many controls an ancestor holds — and a fake with no real tree
// cannot express any of that. So this file builds a small real-ish tree
// instead (`tree()` below), which is also what lets the Meta shapes be written
// down as the markup they actually are rather than as assertions about
// markup.
//
// Every fixture here was copied from a live page, not invented. The Meta ones
// come from the application form at
// metacareers.com/profile/create_application/<id>/ as it rendered on
// 2026-09-12 — the same capture the browser-driven verification used. That
// matters: the first version of findForm returned <body> on this exact shape
// and looked perfectly reasonable in the abstract.

const assert = require('assert');
const generic = require('../generic');
const { extractPostingId: serverExtractPostingId } = require('../../../../server/src/routes/autofill');

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

// ---------------------------------------------------------------------------
// A minimal DOM. Implements only what generic.js touches, and only as far as
// the selectors it actually passes — a tag name, an attribute, a class or an
// id, optionally comma-separated. Deliberately not a DOM implementation: if a
// future change needs more of one, that is the signal to reach for a real
// headless browser rather than to grow this.
// ---------------------------------------------------------------------------
function matchesOne(el, selector) {
  const parsed = selector.trim().match(/^([a-zA-Z0-9]*)((?:\[[^\]]+\]|\.[-\w]+|#[-\w]+)*)$/);
  if (!parsed) return false;
  const [, tag, rest] = parsed;
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  for (const part of rest.match(/\[[^\]]+\]|\.[-\w]+|#[-\w]+/g) || []) {
    if (part[0] === '[') {
      const attr = part.slice(1, -1).match(/^([-\w]+)(?:=["']?([^"']*)["']?)?$/);
      if (!attr) return false;
      const actual = el.getAttribute(attr[1]);
      if (actual === null) return false;
      if (attr[2] !== undefined && actual !== attr[2]) return false;
    } else if (part[0] === '.') {
      if (!(el.getAttribute('class') || '').split(/\s+/).includes(part.slice(1))) return false;
    } else if (part[0] === '#') {
      if (el.getAttribute('id') !== part.slice(1)) return false;
    }
  }
  return true;
}

function text(value) {
  return { nodeType: 3, nodeValue: value };
}

// tree('div', {role: 'list'}, [child, 'some text', ...])
function tree(tag, attrs, children) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    _attrs: attrs || {},
    childNodes: [],
    parentElement: null,
    // Everything generic.js reads to decide a control is real and visible.
    // A real page would compute these; here they are simply "on screen"
    // unless a fixture says otherwise.
    offsetParent: {},
    getClientRects: () => [{}],
    disabled: false,
    readOnly: false,
  };
  el.getAttribute = (name) => (name in el._attrs ? String(el._attrs[name]) : null);
  el.setAttribute = (name, value) => {
    el._attrs[name] = value;
  };
  Object.defineProperty(el, 'type', {
    get: () => (el.tagName === 'INPUT' ? el._attrs.type || 'text' : undefined),
  });
  Object.defineProperty(el, 'children', {
    get: () => el.childNodes.filter((n) => n.nodeType === 1),
  });
  Object.defineProperty(el, 'textContent', {
    get: () =>
      el.childNodes
        .map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
  });
  Object.defineProperty(el, 'innerText', { get: () => el.textContent });
  Object.defineProperty(el, 'previousElementSibling', {
    get: () => {
      if (!el.parentElement) return null;
      const siblings = el.parentElement.children;
      const index = siblings.indexOf(el);
      return index > 0 ? siblings[index - 1] : null;
    },
  });
  el.matches = (selector) => selector.split(',').some((one) => matchesOne(el, one));
  el.querySelectorAll = (selector) => {
    const found = [];
    (function walk(node) {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    })(el);
    return found;
  };
  el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
  el.closest = (selector) => {
    let node = el;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  };
  el.contains = (other) => {
    let node = other;
    while (node) {
      if (node === el) return true;
      node = node.parentElement;
    }
    return false;
  };

  for (const child of children || []) {
    const node = typeof child === 'string' ? text(child) : child;
    el.childNodes.push(node);
    if (node.nodeType === 1) node.parentElement = el;
  }
  return el;
}

// A document whose getElementById searches the tree, for aria-labelledby.
function documentFor(root) {
  const doc = tree('html', {}, [root]);
  doc.getElementById = (id) => doc.querySelectorAll(`[id=${id}]`)[0] || null;
  // ownerDocument is read by ariaGroupLabel; wire it through the whole tree.
  (function wire(node) {
    node.ownerDocument = doc;
    for (const child of node.children) wire(child);
  })(doc);
  return doc;
}

const input = (attrs) => tree('input', attrs, []);

// ---------------------------------------------------------------------------

console.log('findForm — where the fields cluster, not where the page ends:');

// Meta's shape: one application container, plus the site's own header search
// and footer newsletter signup outside it. <body> holds strictly more controls
// than the application does, which is exactly why "most controls wins" fails.
function pageWithChrome(applicationControls) {
  const application = tree(
    'div',
    { id: 'app' },
    applicationControls.concat([tree('div', {}, [input({ type: 'file' })])])
  );
  return documentFor(
    tree('body', {}, [
      tree('header', {}, [tree('form', { role: 'search' }, [input({ type: 'search' })])]),
      tree('main', {}, [application]),
      tree('footer', {}, [tree('form', {}, [input({ type: 'email' })])]),
    ])
  );
}

check('the application container wins over <body>, which holds strictly more', () => {
  const doc = pageWithChrome([
    input({ type: 'text' }),
    input({ type: 'text' }),
    input({ type: 'text' }),
    input({ type: 'text' }),
  ]);
  const form = generic.findForm(doc);
  assert.ok(form, 'expected a form');
  assert.strictEqual(form.getAttribute('id'), 'app');
});

check('a header search box and a footer newsletter stay out of scope', () => {
  const doc = pageWithChrome([input({ type: 'text' }), input({ type: 'text' }), input({ type: 'text' })]);
  const form = generic.findForm(doc);
  assert.strictEqual(form.querySelectorAll('input[type=search]').length, 0);
  assert.strictEqual(form.querySelectorAll('input[type=email]').length, 0);
});

check('a login page is not an application form', () => {
  const doc = documentFor(
    tree('body', {}, [tree('form', {}, [input({ type: 'text' }), input({ type: 'password' })])])
  );
  assert.strictEqual(generic.findForm(doc), null);
});

check('four plain text boxes are not enough — something must look like an application', () => {
  const doc = documentFor(
    tree('body', {}, [
      tree('form', {}, [
        input({ type: 'text' }),
        input({ type: 'text' }),
        input({ type: 'text' }),
        input({ type: 'text' }),
      ]),
    ])
  );
  assert.strictEqual(generic.findForm(doc), null, 'no file/textarea/email/tel control');
});

check('an application split across sibling containers scans BOTH, via their ancestor', () => {
  // Ashby's real shape (§17.2): questions in one container, the EEO section in
  // a second sibling. Neither alone holds enough of the controls to win, so
  // the common ancestor does — which is the correct answer, not a failure.
  const left = tree('div', { id: 'questions' }, [
    input({ type: 'text' }),
    input({ type: 'text' }),
    input({ type: 'file' }),
  ]);
  const right = tree('div', { id: 'eeo' }, [
    input({ type: 'radio' }),
    input({ type: 'radio' }),
    input({ type: 'radio' }),
  ]);
  const both = tree('div', { id: 'both' }, [left, right]);
  const form = generic.findForm(documentFor(tree('body', {}, [both])));
  assert.strictEqual(form.getAttribute('id'), 'both');
  assert.strictEqual(form.querySelectorAll('input').length, 6);
});

console.log('\nlabelFor — reading a label the markup never declares:');

check("a text input wrapped in a <label> takes that label's text", () => {
  // Meta: <label><div><div>First name</div></div><div><input></div></label>
  const box = input({ type: 'text' });
  const label = tree('label', {}, [
    tree('div', {}, [tree('div', {}, ['First name'])]),
    tree('div', {}, [box]),
  ]);
  documentFor(tree('body', {}, [label]));
  assert.strictEqual(generic.labelFor(box), 'First name');
});

check('a single-value field is left unlabelled rather than given its neighbour’s', () => {
  // Two boxes in one row with the row's text above them: whatever that text
  // says, it does not name either box on its own.
  const first = input({ type: 'text' });
  const row = tree('div', {}, ['Full name', first, input({ type: 'text' })]);
  documentFor(tree('body', {}, [row]));
  assert.strictEqual(generic.labelFor(first), null);
});

check('a radio group is named by its aria-labelledby, not by one of its own answers', () => {
  // The failure this prevents is the one Lever produced: every option is
  // wrapped in its own <label>, so the fallback names the question "Male".
  const male = input({ type: 'radio' });
  const group = tree('div', { role: 'radiogroup', 'aria-labelledby': 'q1' }, [
    tree('div', {}, [tree('span', { id: 'q1' }, ['Indicate your gender:'])]),
    tree('label', {}, [male, tree('div', {}, ['Male'])]),
    tree('label', {}, [input({ type: 'radio' }), tree('div', {}, ['Female'])]),
  ]);
  documentFor(tree('body', {}, [group]));
  assert.strictEqual(generic.labelFor(male), 'Indicate your gender:');
});

check('a group whose aria-labelledby points at an empty node falls back to the text above it', () => {
  // Meta's location multi-select really does this: aria-labelledby names a
  // span that renders nothing, and the instruction sits seven levels up.
  const first = input({ type: 'checkbox' });
  const list = tree('div', { role: 'list', 'aria-labelledby': 'empty' }, [
    tree('div', { role: 'listitem' }, [
      tree('div', {}, [tree('label', {}, [first, tree('div', {}, ['Bellevue, WA'])])]),
    ]),
    tree('div', { role: 'listitem' }, [
      tree('div', {}, [tree('label', {}, [input({ type: 'checkbox' }), tree('div', {}, ['Boston, MA'])])]),
    ]),
  ]);
  const section = tree('div', {}, [
    "Please select one or more locations where you'd like to apply.",
    tree('div', {}, [tree('div', {}, [tree('span', { id: 'empty' }, [])]), list]),
  ]);
  documentFor(tree('body', {}, [section]));
  assert.strictEqual(
    generic.labelFor(first),
    "Please select one or more locations where you'd like to apply."
  );
});

console.log('\nA vague label is an answer-bank hazard, so it gets qualified:');

check('"Please select an option:" is qualified by the heading above its group', () => {
  // Meta's disability question, verbatim. Unqualified, this label would key an
  // answer-bank entry that any other form's "please select an option" would
  // then match (§17.3).
  const yes = input({ type: 'radio' });
  const group = tree('div', { role: 'radiogroup', 'aria-labelledby': 'd1' }, [
    tree('div', {}, [tree('span', { id: 'd1' }, ['Please select an option:'])]),
    tree('label', {}, [yes, tree('div', {}, ['Yes, I have a disability'])]),
  ]);
  const section = tree('div', {}, [tree('span', {}, ['Disability']), tree('div', {}, [group])]);
  documentFor(tree('body', {}, [section]));
  assert.strictEqual(generic.labelFor(yes), 'Disability — Please select an option:');
});

check('the qualifier never repeats the label back to itself', () => {
  // The first version searched upward from the CONTROL and found the group's
  // own caption again, producing
  // "Please select an option: — Please select an option:".
  const yes = input({ type: 'radio' });
  const group = tree('div', { role: 'radiogroup', 'aria-labelledby': 'd2' }, [
    tree('div', {}, [tree('span', { id: 'd2' }, ['Please select an option:'])]),
    tree('label', {}, [yes, tree('div', {}, ['Yes'])]),
  ]);
  documentFor(tree('body', {}, [tree('div', {}, [group])]));
  assert.strictEqual(generic.labelFor(yes), 'Please select an option:');
});

check('a paragraph above a group is prose, not a heading', () => {
  const yes = input({ type: 'radio' });
  const essay =
    'Meta is committed to hiring people with a wide range of backgrounds and experiences, ' +
    'which helps us build better products and better serve our users, and this sentence is ' +
    'deliberately far too long to be anybody’s idea of a field label.';
  const group = tree('div', { role: 'radiogroup', 'aria-labelledby': 'd3' }, [
    tree('div', {}, [tree('span', { id: 'd3' }, ['Please select an option:'])]),
    tree('label', {}, [yes, tree('div', {}, ['Yes'])]),
  ]);
  documentFor(tree('body', {}, [tree('div', {}, [tree('p', {}, [essay]), group])]));
  assert.strictEqual(generic.labelFor(yes), 'Please select an option:');
});

console.log('\ngroupMembers — ARIA grouping, because these pages carry no `name`:');

check('every radio in a name-less group is one question’s options', () => {
  const options = [input({ type: 'radio' }), input({ type: 'radio' }), input({ type: 'radio' })];
  const group = tree('div', { role: 'radiogroup' }, options.map((o) => tree('label', {}, [o])));
  documentFor(tree('body', {}, [group]));
  assert.strictEqual(generic.groupMembers(options[0]).length, 3);
  assert.strictEqual(generic.groupMembers(options[2]).length, 3);
});

check('two separate groups are two questions, and one group is stable across its options', () => {
  const a1 = input({ type: 'radio' });
  const a2 = input({ type: 'radio' });
  const b1 = input({ type: 'radio' });
  const groupA = tree('div', { role: 'radiogroup' }, [a1, a2]);
  const groupB = tree('div', { role: 'radiogroup' }, [b1, input({ type: 'radio' })]);
  documentFor(tree('body', {}, [groupA, groupB]));
  assert.strictEqual(generic.groupIdentity(a1), generic.groupIdentity(a2));
  assert.notStrictEqual(generic.groupIdentity(a1), generic.groupIdentity(b1));
});

check('radios and checkboxes sharing a container are still different questions', () => {
  const radio = input({ type: 'radio' });
  const box = input({ type: 'checkbox' });
  documentFor(tree('body', {}, [tree('fieldset', {}, [radio, box])]));
  assert.notStrictEqual(generic.groupIdentity(radio), generic.groupIdentity(box));
  assert.strictEqual(generic.groupMembers(radio).length, 1);
  assert.strictEqual(generic.groupMembers(box).length, 1);
});

check('a control in no group at all reports none, rather than inventing one', () => {
  const loose = input({ type: 'radio' });
  documentFor(tree('body', {}, [tree('div', {}, [loose])]));
  assert.strictEqual(generic.groupIdentity(loose), null);
  assert.strictEqual(generic.groupMembers(loose), null);
});

console.log('\nPosting id — a wrong match attaches another job’s résumé, so it declines instead:');

const ID_CASES = [
  // Meta carries the same id on the job page and on the application.
  ['https://www.metacareers.com/jobs/9657291271065759/', '9657291271065759'],
  ['https://www.metacareers.com/profile/create_application/9657291271065759/', '9657291271065759'],
  ['https://jobs.example.com/careers/a3f2c1d4-1111-2222-3333-444455556666/apply', 'a3f2c1d4-1111-2222-3333-444455556666'],
  // Too short to be safe against a LIKE %id% match over the user's own jobs.
  ['https://jobs.example.com/careers/123456/apply', null],
  // Ambiguous: two long numbers, no way to know which is the posting.
  ['https://jobs.example.com/12345678/apply/87654321', null],
  ['https://jobs.example.com/careers/senior-engineer', null],
  ['not a url', null],
];

for (const [url, expected] of ID_CASES) {
  check(`${url.slice(0, 62)} -> ${expected}`, () => {
    assert.strictEqual(generic.extractPostingId(url), expected);
  });
  check(`server agrees on ${url.slice(0, 52)}`, () => {
    assert.strictEqual(serverExtractPostingId(url), generic.extractPostingId(url));
  });
}

console.log(`\n${passed} checks passed`);
