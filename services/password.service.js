/**
 * Password hashing, on Node's own scrypt.
 *
 * No bcrypt or argon2: both are native modules, and this Docker image has been
 * broken by a dependency drift once already. scrypt is memory-hard, is in the
 * standard library, and is the algorithm Node's own docs point at for exactly
 * this.
 *
 * The stored value is `scrypt$N$salt$hash`, all in one field. Keeping the salt
 * beside the hash means there is no second column to forget to read, and the
 * cost is recorded with the hash so it can be raised later without invalidating
 * everything already stored.
 */
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const COST = 16384;   // 2^14 — Node's default, ~100ms here
const KEY_LEN = 64;
const SALT_LEN = 16;

const MIN_LENGTH = 8;

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

/** @returns {Promise<string>} the encoded hash to store. */
async function hash(password) {
  const value = String(password ?? '');
  if (value.length < MIN_LENGTH) {
    throw new ValidationError(`Password must be at least ${MIN_LENGTH} characters`);
  }

  const salt = crypto.randomBytes(SALT_LEN).toString('hex');
  const derived = await scrypt(value, salt, KEY_LEN, { N: COST });
  return `scrypt$${COST}$${salt}$${derived.toString('hex')}`;
}

/**
 * @returns {Promise<boolean>} whether the password matches the stored hash.
 *
 * Compared with timingSafeEqual rather than `===`: string comparison returns as
 * soon as it finds a difference, and the time it takes leaks how much of the
 * hash was right.
 */
async function verify(password, stored) {
  if (!password || !stored) return false;

  const [scheme, cost, salt, expected] = String(stored).split('$');
  if (scheme !== 'scrypt' || !cost || !salt || !expected) return false;

  let derived;
  try {
    derived = await scrypt(String(password), salt, KEY_LEN, { N: Number(cost) });
  } catch {
    // A stored hash with a cost this machine cannot allocate: treated as a
    // mismatch rather than a crash, so one bad row cannot break sign-in.
    return false;
  }

  const expectedBuf = Buffer.from(expected, 'hex');
  if (expectedBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expectedBuf);
}

/** A password an admin can read out once and hand over. */
function generate() {
  // Ambiguous characters left out: these get typed from a screen or read aloud,
  // and 0/O and 1/l/I are where that goes wrong.
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

module.exports = { hash, verify, generate, ValidationError, MIN_LENGTH };
