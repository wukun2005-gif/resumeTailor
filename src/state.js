const STORAGE_KEY = 'resumeTailorApp';
// All credential keys (connection keys are dynamically added via connKey_*)
const CREDENTIAL_KEYS = ['geminiKey', 'anthropicKey', 'anthropicUrl'];

// Lightweight encryption for credentials using Web Crypto API (AES-GCM)
// Derives a key from a stable device fingerprint so credentials aren't stored in plain text

// Stable fingerprint: excludes navigator.userAgent because browser auto-updates change it,
// causing decryption failures and data corruption (double-encryption bug).
const STABLE_SALT = 'resumeTailorSalt';

function getStableFingerprint() {
  // screen dimensions and language do NOT change with browser updates
  return screen.width + '|' + screen.height + '|' + navigator.language;
}

function getLegacyFingerprint() {
  // Old fingerprint included userAgent — kept for migration of existing encrypted data
  return navigator.userAgent + screen.width + screen.height + navigator.language;
}

async function deriveKeyFromFingerprint(fingerprint) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(fingerprint), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(STABLE_SALT), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function getDerivedKey() {
  return deriveKeyFromFingerprint(getStableFingerprint());
}

async function encryptValue(value) {
  if (!value) return '';
  try {
    const key = await getDerivedKey();
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(value));
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  } catch {
    return ''; // encryption failed — do NOT return plaintext
  }
}

/**
 * Heuristic: detect if a string looks like AES-GCM ciphertext (base64 encoded).
 * Used to prevent double-encryption: if a previously failed decryption left base64
 * ciphertext in an input field and the user clicks save, we must not re-encrypt it.
 */
function looksLikeCiphertext(value) {
  if (!value || value.length < 24) return false;
  // Base64 alphabet: A-Z, a-z, 0-9, +, /, optionally = padding at end
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

async function tryDecrypt(encoded, fingerprint) {
  const key = await deriveKeyFromFingerprint(fingerprint);
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

async function decryptValue(encoded) {
  if (!encoded) return '';
  // Quick check: if it doesn't look like base64, it might be plain text from a very old version
  if (!looksLikeCiphertext(encoded)) return encoded;

  try {
    // Try stable fingerprint first (current/default)
    return await tryDecrypt(encoded, getStableFingerprint());
  } catch {
    // Stable fingerprint failed — try legacy fingerprint (with userAgent) for migration
    try {
      const plaintext = await tryDecrypt(encoded, getLegacyFingerprint());
      // Legacy decryption succeeded: this is old data that needs migration.
      // Check if the plaintext itself looks like ciphertext (double-encryption corruption).
      // If so, the data is unrecoverable — return empty string.
      if (looksLikeCiphertext(plaintext)) return '';
      return plaintext;
    } catch {
      // Both fingerprints failed — data is unrecoverable
      return '';
    }
  }
}

export function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { return {}; }
}

export function saveState(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function get(key, defaultValue = '') {
  return loadState()[key] ?? defaultValue;
}

export function set(key, value) {
  const s = loadState();
  s[key] = value;
  saveState(s);
}

// Credential-specific async getters/setters with encryption
export async function getCredential(key, defaultValue = '') {
  const raw = loadState()[key];
  if (!raw) return defaultValue;
  return await decryptValue(raw);
}

export async function setCredential(key, value) {
  // Guard against double-encryption: if the value looks like ciphertext
  // (e.g., from a failed decryption that was displayed in an input field),
  // do not encrypt it again — store empty string instead.
  const safeValue = looksLikeCiphertext(value) ? '' : value;
  const encrypted = await encryptValue(safeValue);
  const s = loadState();
  s[key] = encrypted;
  saveState(s);
}

// Mark a credential as migrated to the new stable fingerprint.
// Called after successful decryption with the legacy fingerprint.
export async function migrateCredential(key) {
  const raw = loadState()[key];
  if (!raw) return;
  // Already decryptable with stable key? No migration needed.
  try {
    await tryDecrypt(raw, getStableFingerprint());
    return;
  } catch { /* needs migration */ }
  // Decrypt with legacy key, re-encrypt with stable key
  try {
    const plaintext = await tryDecrypt(raw, getLegacyFingerprint());
    if (looksLikeCiphertext(plaintext)) {
      // Double-encrypted garbage — clear it
      const s = loadState();
      s[key] = '';
      saveState(s);
      return;
    }
    const encrypted = await encryptValue(plaintext);
    const s = loadState();
    s[key] = encrypted;
    saveState(s);
  } catch {
    // Can't decrypt with either key — clear it
    const s = loadState();
    s[key] = '';
    saveState(s);
  }
}

export function isCredentialKey(key) {
  return CREDENTIAL_KEYS.includes(key) || key.startsWith('connKey_') || key.startsWith('pii_');
}
