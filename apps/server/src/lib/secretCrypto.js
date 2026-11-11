const crypto = require('crypto');

// Symmetric encryption for user-supplied provider keys (spec 13.7). Phase 1 uses
// AES-256-GCM with a server-held master key in the env var CREDENTIALS_MASTER_KEY
// (32 bytes, base64). Phase 2 replaces this with real KMS envelope encryption —
// this module is the single seam that swap happens behind. The master key never
// leaves the server; decryption happens server-side and plaintext keys live only
// for the duration of a sourcing call.
//
// Stored blob format: `${iv_b64}:${authTag_b64}:${ciphertext_b64}` (GCM, so the
// auth tag detects any tampering with the stored value).

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit nonce, GCM standard

function getKey() {
  const raw = process.env.CREDENTIALS_MASTER_KEY;
  if (!raw) throw new Error('CREDENTIALS_MASTER_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`CREDENTIALS_MASTER_KEY must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

// True when the master key is present and valid — routes gate BYOK actor
// features on this so they fail with a clear 503 rather than a crash.
function isConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('encryptSecret: plaintext must be a non-empty string');
  }
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptSecret(blob) {
  if (typeof blob !== 'string') throw new Error('decryptSecret: blob must be a string');
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('decryptSecret: malformed blob');
  const [ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret, isConfigured };
