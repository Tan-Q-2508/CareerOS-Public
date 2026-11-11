#!/usr/bin/env node
// sync-extension-shared.js — copies the shared modules the browser extension
// needs into apps/extension/, because Chrome can only load content-script
// files from inside the extension directory (no ../../packages, no symlink
// that survives packing).
//
// The canonical copy always lives in packages/shared; this script only ever
// writes into apps/extension. `npm run test:autofill` asserts the two are
// byte-identical, so a drift is a failing test rather than a silent
// divergence between the answer-bank key the server writes and the one the
// extension looks up.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FILES = [
  {
    from: path.join(ROOT, 'packages', 'shared', 'src', 'autofill', 'normalizeQuestion.js'),
    to: path.join(ROOT, 'apps', 'extension', 'src', 'core', 'normalizeQuestion.js'),
  },
];

let changed = 0;
for (const file of FILES) {
  const source = fs.readFileSync(file.from, 'utf8');
  const current = fs.existsSync(file.to) ? fs.readFileSync(file.to, 'utf8') : null;
  if (current === source) {
    console.log(`unchanged: ${path.relative(ROOT, file.to)}`);
    continue;
  }
  fs.mkdirSync(path.dirname(file.to), { recursive: true });
  fs.writeFileSync(file.to, source);
  changed += 1;
  console.log(`synced:    ${path.relative(ROOT, file.from)} -> ${path.relative(ROOT, file.to)}`);
}

console.log(changed ? `\n${changed} file(s) synced.` : '\nEverything already in sync.');
