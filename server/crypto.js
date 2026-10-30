// Security primitives. Only Node's built-in crypto module; no third-party code.
import crypto from 'node:crypto';

// ---------- Field encryption at rest: AES-256-GCM ----------
// Ciphertext format: "v1:" + base64(iv[12] | tag[16] | ciphertext). A fresh random IV per value.
// The key comes from WAZIN_DATA_KEY (32 bytes, base64). Associated data binds a value to its
// organisation and field, so a ciphertext copied into another row or org fails to decrypt.

/** Read the 32-byte data key from base64 (WAZIN_DATA_KEY); refuses anything else. */
export function loadKey(b64) {
  if (!b64) throw new Error('WAZIN_DATA_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('WAZIN_DATA_KEY must be 32 bytes, base64-encoded (run: npm run keygen)');
  return key;
}

export const newKey = () => crypto.randomBytes(32).toString('base64');

/** AES-256-GCM. The AAD binds the ciphertext to its company and field, so it cannot be moved elsewhere. */
export function encrypt(key, plaintext, aad = '') {
  if (plaintext === undefined || plaintext === null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

/** Reverse of encrypt(); throws if the data or its AAD were changed. */
export function decrypt(key, value, aad = '') {
  if (value === undefined || value === null) return null;
  if (!String(value).startsWith('v1:')) throw new Error('Unknown ciphertext format');
  const raw = Buffer.from(String(value).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ---------- Passwords: scrypt with per-user salt ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** scrypt with a random salt; only the hash is stored. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time check of a password against a stored scrypt hash. */
export function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

// A real hash to compare against when the email is unknown, so response time does not reveal
// which emails have accounts.
export const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/** Return an error code if a new password is too weak, or null if it is acceptable. */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'password_too_short';
  if (pw.length > 200) return 'password_too_long';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'password_needs_letter_and_digit';
  return null;
}

// ---------- Tokens ----------
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
