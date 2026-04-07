const STORAGE_KEY = 'resumeTailorApp';
// All credential keys (connection keys are dynamically added via connKey_*)
const CREDENTIAL_KEYS = ['geminiKey', 'anthropicKey', 'anthropicUrl'];

// Lightweight encryption for credentials using Web Crypto API (AES-GCM)
// Derives a key from a stable device fingerprint so credentials aren't stored in plain text
async function getDerivedKey() {
  const fingerprint = navigator.userAgent + screen.width + screen.height + navigator.language;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(fingerprint), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('resumeTailorSalt'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
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
    return value; // fallback to plain text if crypto fails
  }
}

async function decryptValue(encoded) {
  if (!encoded) return '';
  try {
    const key = await getDerivedKey();
    const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch {
    return encoded; // fallback: might be plain text from old version
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
  const encrypted = await encryptValue(value);
  const s = loadState();
  s[key] = encrypted;
  saveState(s);
}

export function isCredentialKey(key) {
  return CREDENTIAL_KEYS.includes(key) || key.startsWith('connKey_');
}
