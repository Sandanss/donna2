/**
 * Field-level encryption for PHI data at rest.
 *
 * Uses AES-256-GCM for symmetric encryption. Key is loaded from
 * FIELD_ENCRYPTION_KEY env var (32 bytes, base64url-encoded).
 *
 * Both Node.js and Python backends use the same format:
 *     enc:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * Local/test can skip encryption when FIELD_ENCRYPTION_KEY is absent. Public
 * production-style environments fail closed. Legacy unencrypted data (no
 * 'enc:' prefix) is returned as-is on decrypt.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { createLogger } from './logger.js';
import { isProductionEnv } from './security-config.js';

const log = createLogger('Encryption');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:';

let _key = null;
let _keyLoaded = false;

function getKey() {
  if (_keyLoaded) return _key;
  _keyLoaded = true;
  const raw = process.env.FIELD_ENCRYPTION_KEY || '';
  if (!raw) return null;
  try {
    _key = Buffer.from(raw, 'base64url');
    if (_key.length !== 32) {
      log.error(`FIELD_ENCRYPTION_KEY must decode to 32 bytes, got ${_key.length}`);
      _key = null;
    }
  } catch (e) {
    log.error(`Invalid FIELD_ENCRYPTION_KEY: ${e.message}`);
    _key = null;
  }
  return _key;
}

function requireKeyIfProduction() {
  if (isProductionEnv()) {
    throw new Error('FIELD_ENCRYPTION_KEY is required for PHI encryption in production');
  }
}

/**
 * Encrypt a plaintext string.
 * Returns "enc:<iv_b64>:<tag_b64>:<ciphertext_b64>" or the original
 * plaintext if no key is configured.
 */
export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  if (!key) {
    requireKeyIfProduction();
    return plaintext; // local/test graceful degradation only
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return PREFIX + [iv, tag, encrypted].map(b => b.toString('base64')).join(':');
}

/**
 * Decrypt a ciphertext string.
 * Handles both encrypted ('enc:' prefix) and legacy unencrypted data.
 */
export function decrypt(ciphertext) {
  if (ciphertext == null) return null;
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith(PREFIX)) {
    return ciphertext; // legacy unencrypted
  }
  const key = getKey();
  if (!key) {
    requireKeyIfProduction();
    log.warn('Cannot decrypt: FIELD_ENCRYPTION_KEY not set');
    return '[encrypted]';
  }

  const parts = ciphertext.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return ciphertext; // not our format

  try {
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
  } catch (e) {
    log.error(`Decryption failed: ${e.message}`);
    return '[encrypted]';
  }
}

/**
 * Encrypt a JSON-serializable object. Returns encrypted string.
 */
export function encryptJson(data) {
  if (data == null) return null;
  return encrypt(JSON.stringify(data));
}

/**
 * Decrypt to a JSON object.
 * Handles encrypted strings, already-parsed objects, and plain JSON strings.
 */
export function decryptJson(ciphertext) {
  if (ciphertext == null) return null;
  if (typeof ciphertext === 'object') return ciphertext; // already parsed
  const plaintext = decrypt(ciphertext);
  if (plaintext === '[encrypted]') return null;
  if (typeof plaintext === 'object') return plaintext;
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}

/**
 * Generate a new 32-byte base64url-encoded key.
 * Run once: node -e "import('./lib/encryption.js').then(m => console.log(m.generateKey()))"
 */
export function generateKey() {
  return randomBytes(32).toString('base64url');
}
