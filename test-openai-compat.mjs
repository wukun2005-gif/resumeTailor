/**
 * Unit Tests for OpenAI-Compatible API Caching Behavior & State.js Encryption
 * ==========================================================================
 *
 * Part 1 — OpenAI-Compatible Caching Behavior
 * Tests verify that:
 * 1. Anthropic models via OpenRouter receive the correct caching headers
 * 2. Non-Anthropic models do NOT receive caching headers
 * 3. The cache_control structure is correctly applied to messages
 * 4. The extra_body stream_options is correctly set for Anthropic
 *
 * Part 2 — State.js Encryption / Decryption / Migration
 * Tests verify that:
 * 1. AES-GCM encrypt/decrypt roundtrip works correctly
 * 2. Decryption failure returns empty string (not raw ciphertext)
 * 3. looksLikeCiphertext heuristic prevents double-encryption
 * 4. Legacy fingerprint migration works and is idempotent
 * 5. Stable fingerprint resists browser userAgent changes
 *
 * These tests mock fetch() and browser globals to verify behavior
 * without calling real APIs or requiring a browser environment.
 */

import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Polyfills for state.js tests (Web Crypto, TextEncoder/Decoder, localStorage, browser globals) ──
import { webcrypto } from 'node:crypto';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'node:util';

if (!globalThis.crypto?.subtle) {
  globalThis.crypto = webcrypto;
}
if (!globalThis.TextEncoder) globalThis.TextEncoder = NodeTextEncoder;
if (!globalThis.TextDecoder) globalThis.TextDecoder = NodeTextDecoder;

const stateStore = new Map();
globalThis.localStorage = {
  getItem: (k) => stateStore.has(k) ? stateStore.get(k) : null,
  setItem: (k, v) => stateStore.set(k, v),
  removeItem: (k) => stateStore.delete(k),
  clear: () => stateStore.clear(),
};

Object.defineProperty(globalThis, 'screen', { value: { width: 1440, height: 900 }, writable: true, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TestBrowser/123.0' }, writable: true, configurable: true });

// ── Shared test harness ──────────────────────────────────────────────────────

const RESULTS = [];

function log(test, pass, detail = '') {
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${test}${detail ? ' - ' + detail : ''}`);
  RESULTS.push({ test, pass, detail });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api';

// ═══════════════════════════════════════════════════════════════════════════════
// Part 1: OpenAI-Compatible Caching Behavior Tests
// ═══════════════════════════════════════════════════════════════════════════════

let originalFetch = globalThis.fetch;
let interceptedRequests = [];

function createMockFetch(responses) {
  let responseIndex = 0;
  return function mockFetch(url, options) {
    const response = responses[responseIndex++] || responses[responses.length - 1];
    interceptedRequests.push({ url, options });
    return Promise.resolve(response);
  };
}

function createMockSSEStream(text) {
  const chunks = text.split('');
  let index = 0;
  return {
    getReader() {
      return {
        read() {
          if (index >= chunks.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const value = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'chunk', text: chunks[index++] })}\n\n`);
          return Promise.resolve({ done: false, value });
        }
      };
    }
  };
}

function createMockResponse(text, options = {}) {
  return {
    ok: options.status !== undefined ? options.status >= 400 : true,
    status: options.status || 200,
    body: createMockSSEStream(text),
    async text() {
      let result = '';
      for (const chunk of text.split('')) {
        result += `data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`;
      }
      result += `data: ${JSON.stringify({ type: 'done', usage: { input: 100, output: 50 } })}\n\n`;
      return result;
    },
    headers: {
      get: () => 'text/event-stream'
    }
  };
}

async function testAnthropicCachingHeaders() {
  console.log('\n[Test Group] Anthropic Caching Headers');

  interceptedRequests = [];
  const mockResponse = createMockResponse('Hello world');
  globalThis.fetch = createMockFetch([mockResponse]);

  const { initOpenAICompat, callOpenAICompat } = await import('./server/services/openai-compat.js');

  initOpenAICompat('openrouter-anthropic', 'https://openrouter.ai/api/v1', 'test-key', 'claude-3-5-sonnet');

  await callOpenAICompat('openrouter-anthropic', 'Hello', () => {}, {
    system: 'You are a helpful assistant',
    userBlocks: [
      { text: 'Context that should be cached', cache: true },
      { text: 'Dynamic user input', cache: false }
    ]
  });

  globalThis.fetch = originalFetch;

  if (interceptedRequests.length === 0) {
    log('Anthropic fetch was called', false, 'No request intercepted');
    return false;
  }

  const request = interceptedRequests[0];
  const headers = request.options.headers;
  const body = JSON.parse(request.options.body);

  log('Anthropic fetch was called', true);

  const hasAnthropicBeta = headers['anthropic-beta'] === 'prompt-caching-2024-07-31';
  log('anthropic-beta header is set', hasAnthropicBeta, `value: ${headers['anthropic-beta'] || 'MISSING'}`);

  const hasExtraBody = body.extra_body && body.extra_body.stream_options && body.extra_body.stream_options.include_usage === true;
  log('extra_body.stream_options is set', hasExtraBody, JSON.stringify(body.extra_body || 'MISSING'));

  const systemMessage = body.messages.find(m => m.role === 'system');
  const hasSystemCacheControl = systemMessage && systemMessage.content && systemMessage.content[0] && systemMessage.content[0].cache_control && systemMessage.content[0].cache_control.type === 'ephemeral';
  log('System message has cache_control', hasSystemCacheControl, JSON.stringify(systemMessage?.content?.[0]?.cache_control || 'MISSING'));

  const userMessages = body.messages.filter(m => m.role === 'user');
  if (userMessages.length > 0) {
    const userContent = userMessages[userMessages.length - 1].content;
    if (Array.isArray(userContent)) {
      const cachedBlock = userContent.find(b => b.cache_control && b.cache_control.type === 'ephemeral');
      const nonCachedBlock = userContent.find(b => !b.cache_control || b.cache_control.type !== 'ephemeral');
      log('User block with cache:true has cache_control', !!cachedBlock, cachedBlock ? 'YES' : 'NO');
      log('User block with cache:false has no cache_control', !nonCachedBlock || nonCachedBlock.cache_control === undefined, nonCachedBlock ? JSON.stringify(nonCachedBlock.cache_control) : 'N/A');
    }
  }

  return hasAnthropicBeta && hasExtraBody && hasSystemCacheControl;
}

async function testNonAnthropicNoCachingHeaders() {
  console.log('\n[Test Group] Non-Anthropic Models Should NOT Receive Caching Headers');

  interceptedRequests = [];
  const mockResponse = createMockResponse('Hello world');
  globalThis.fetch = createMockFetch([mockResponse]);

  const { initOpenAICompat, callOpenAICompat } = await import('./server/services/openai-compat.js');

  initOpenAICompat('openrouter-openai', 'https://openrouter.ai/api/v1', 'test-key', 'gpt-4o');

  await callOpenAICompat('openrouter-openai', 'Hello', () => {}, {
    system: 'You are a helpful assistant'
  });

  globalThis.fetch = originalFetch;

  if (interceptedRequests.length === 0) {
    log('Non-Anthropic fetch was called', false, 'No request intercepted');
    return false;
  }

  const request = interceptedRequests[0];
  const headers = request.options.headers;
  const body = JSON.parse(request.options.body);

  log('Non-Anthropic fetch was called', true);

  const hasNoAnthropicBeta = !headers['anthropic-beta'] || headers['anthropic-beta'] !== 'prompt-caching-2024-07-31';
  log('No anthropic-beta header for non-Anthropic', hasNoAnthropicBeta, `value: ${headers['anthropic-beta'] || 'NOT SET'}`);

  const hasNoExtraBody = !body.extra_body;
  log('No extra_body for non-Anthropic', hasNoExtraBody, JSON.stringify(body.extra_body || 'NOT SET'));

  const systemMessage = body.messages.find(m => m.role === 'system');
  const hasNoSystemCacheControl = !systemMessage || !systemMessage.content || typeof systemMessage.content === 'string' || !systemMessage.content[0] || !systemMessage.content[0].cache_control;
  log('System message has no cache_control for non-Anthropic', hasNoSystemCacheControl);

  return hasNoAnthropicBeta && hasNoExtraBody && hasNoSystemCacheControl;
}

async function testJiekouAnthropicModelDetection() {
  console.log('\n[Test Group] Jiekou Anthropic Model Detection');

  interceptedRequests = [];
  const mockResponse = createMockResponse('Hello world');
  globalThis.fetch = createMockFetch([mockResponse]);

  const { initOpenAICompat, callOpenAICompat } = await import('./server/services/openai-compat.js');

  initOpenAICompat('jiekou-anthropic', 'https://api.jiekou.ai/v1', 'test-key', 'claude-opus-4-6');

  await callOpenAICompat('jiekou-anthropic', 'Hello', () => {}, {
    system: 'You are a helpful assistant'
  });

  globalThis.fetch = originalFetch;

  if (interceptedRequests.length === 0) {
    log('Jiekou Anthropic fetch was called', false, 'No request intercepted');
    return false;
  }

  const request = interceptedRequests[0];
  const headers = request.options.headers;
  const body = JSON.parse(request.options.body);

  log('Jiekou Anthropic fetch was called', true);

  const hasAnthropicBeta = headers['anthropic-beta'] === 'prompt-caching-2024-07-31';
  log('anthropic-beta header for jiekou-anthropic', hasAnthropicBeta, `value: ${headers['anthropic-beta'] || 'MISSING'}`);

  const hasSystemCacheControl = body.messages[0] && body.messages[0].content && body.messages[0].content[0] && body.messages[0].content[0].cache_control;
  log('System message has cache_control for jiekou-anthropic', !!hasSystemCacheControl);

  return hasAnthropicBeta;
}

async function testClaudeInModelNameDetection() {
  console.log('\n[Test Group] Claude Keyword in Model Name Detection');

  interceptedRequests = [];
  const mockResponse = createMockResponse('Hello world');
  globalThis.fetch = createMockFetch([mockResponse]);

  const { initOpenAICompat, callOpenAICompat } = await import('./server/services/openai-compat.js');

  initOpenAICompat('custom-connection', 'https://openrouter.ai/api/v1', 'test-key', 'anthropic/claude-3-opus');

  await callOpenAICompat('custom-connection', 'Hello', () => {}, {
    system: 'You are a helpful assistant'
  });

  globalThis.fetch = originalFetch;

  if (interceptedRequests.length === 0) {
    log('Custom connection with claude in model was called', false, 'No request intercepted');
    return false;
  }

  const request = interceptedRequests[0];
  const headers = request.options.headers;

  log('Custom connection fetch was called', true);

  const hasAnthropicBeta = headers['anthropic-beta'] === 'prompt-caching-2024-07-31';
  log('anthropic-beta for model containing "claude"', hasAnthropicBeta, `value: ${headers['anthropic-beta'] || 'MISSING'}`);

  return hasAnthropicBeta;
}

async function testUserBlocksWithoutCache() {
  console.log('\n[Test Group] User Blocks Without Cache Flag');

  interceptedRequests = [];
  const mockResponse = createMockResponse('Hello world');
  globalThis.fetch = createMockFetch([mockResponse]);

  const { initOpenAICompat, callOpenAICompat } = await import('./server/services/openai-compat.js');

  initOpenAICompat('openrouter-anthropic', 'https://openrouter.ai/api/v1', 'test-key', 'claude-3-5-sonnet');

  await callOpenAICompat('openrouter-anthropic', 'Hello', () => {}, {
    system: 'You are a helpful assistant',
    userBlocks: [
      { text: 'Block 1' },
      { text: 'Block 2' }
    ]
  });

  globalThis.fetch = originalFetch;

  if (interceptedRequests.length === 0) {
    log('Fetch was called', false, 'No request intercepted');
    return false;
  }

  const body = JSON.parse(interceptedRequests[0].options.body);
  const userMessages = body.messages.filter(m => m.role === 'user');

  log('User blocks without cache flag', true);

  if (userMessages.length > 0) {
    const userContent = userMessages[userMessages.length - 1].content;
    if (Array.isArray(userContent)) {
      const noCacheControl = userContent.every(b => !b.cache_control);
      log('No cache_control when cache flag not set', noCacheControl);
      return noCacheControl;
    }
  }

  log('No cache_control when cache flag not set', false, 'Could not verify');
  return false;
}

async function testConnectionIdAnthropicDetection() {
  console.log('\n[Test Group] Connection ID Contains "anthropic" Detection');

  interceptedRequests = [];
  const mockResponse = createMockResponse('Hello world');
  globalThis.fetch = createMockFetch([mockResponse]);

  const { initOpenAICompat, callOpenAICompat } = await import('./server/services/openai-compat.js');

  initOpenAICompat('openrouter-anthropic', 'https://openrouter.ai/api/v1', 'test-key', 'some-non-claude-model');

  await callOpenAICompat('openrouter-anthropic', 'Hello', () => {}, {});

  globalThis.fetch = originalFetch;

  if (interceptedRequests.length === 0) {
    log('Fetch was called', false, 'No request intercepted');
    return false;
  }

  const headers = interceptedRequests[0].options.headers;
  const hasAnthropicBeta = headers['anthropic-beta'] === 'prompt-caching-2024-07-31';

  log('anthropic-beta by connectionId (not model)', hasAnthropicBeta, `value: ${headers['anthropic-beta'] || 'MISSING'}`);

  return hasAnthropicBeta;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2: State.js Encryption / Decryption / Migration Tests
// ═══════════════════════════════════════════════════════════════════════════════

const state = await import('./src/state.js');

function clearStateStore() {
  stateStore.clear();
}

/**
 * Simulate data encrypted with the legacy fingerprint (including userAgent).
 * We temporarily change navigator.userAgent, encrypt, then restore.
 */
async function encryptWithLegacyFingerprint(key, value) {
  const originalUA = globalThis.navigator.userAgent;
  globalThis.navigator = { language: 'zh-CN', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) OldBrowser/100.0' };
  await state.setCredential(key, value);
  const raw = stateStore.get('resumeTailorApp');
  const parsed = JSON.parse(raw);
  const encrypted = parsed[key];
  globalThis.navigator = { language: 'zh-CN', userAgent: originalUA };
  return encrypted;
}

async function testStateEncryptDecryptRoundtrip() {
  console.log('\n[Test Group] State: Basic encrypt/decrypt roundtrip');
  clearStateStore();

  await state.setCredential('test_key', 'hello world');
  const result = await state.getCredential('test_key');
  log('roundtrip: set then get returns original value', result === 'hello world', `got: "${result}"`);

  await state.setCredential('test_empty', '');
  const empty = await state.getCredential('test_empty');
  log('roundtrip: empty string stays empty', empty === '', `got: "${empty}"`);
}

async function testStateDecryptEmptyOrMissing() {
  console.log('\n[Test Group] State: Decrypt empty / missing keys');
  clearStateStore();

  const missing = await state.getCredential('nonexistent_key');
  log('missing key returns empty string', missing === '', `got: "${missing}"`);

  const s = state.loadState();
  s['test_blank'] = '';
  state.saveState(s);
  const blank = await state.getCredential('test_blank');
  log('empty string value returns empty string', blank === '', `got: "${blank}"`);
}

async function testStateDecryptFailureReturnsEmpty() {
  console.log('\n[Test Group] State: Decryption failure protection');
  clearStateStore();

  const s = state.loadState();
  s['test_garbage'] = 'PfDUWIqHhWubnmZBhFxDQ68ckoxRHyBt6YNAANIN6I5Fgg==';
  state.saveState(s);

  const result = await state.getCredential('test_garbage');
  log('garbage ciphertext (>=24 chars, valid base64) returns empty string', result === '', `got: "${result}"`);

  s['test_short_garbage'] = 'AAAAAA==';
  state.saveState(s);
  const shortResult = await state.getCredential('test_short_garbage');
  log('short garbage (< 24 chars) returned as-is (treated as old plain text)', shortResult === 'AAAAAA==', `got: "${shortResult}"`);
}

async function testStateLooksLikeCiphertext() {
  console.log('\n[Test Group] State: looksLikeCiphertext heuristic (via setCredential guard)');

  clearStateStore();
  await state.setCredential('test_ciphertext_input', 'PfDUWIqHhWubnmZBhFxDQ68ckoxRHyBt6YNAANIN6I5Fgg==');
  const result = await state.getCredential('test_ciphertext_input');
  log('setCredential rejects base64 ciphertext → stores empty', result === '', `got: "${result}"`);

  clearStateStore();
  await state.setCredential('test_normal', 'hello world');
  const normal = await state.getCredential('test_normal');
  log('setCredential accepts normal string', normal === 'hello world', `got: "${normal}"`);

  clearStateStore();
  await state.setCredential('test_short_b64', 'YWJj');
  const shortB64 = await state.getCredential('test_short_b64');
  log('setCredential accepts short base64 (< 24 chars)', shortB64 === 'YWJj', `got: "${shortB64}"`);

  clearStateStore();
  await state.setCredential('test_email', 'user@example.com');
  const email = await state.getCredential('test_email');
  log('setCredential accepts email address', email === 'user@example.com', `got: "${email}"`);

  clearStateStore();
  await state.setCredential('test_phone', '13501168055');
  const phone = await state.getCredential('test_phone');
  log('setCredential accepts phone number', phone === '13501168055', `got: "${phone}"`);

  clearStateStore();
  await state.setCredential('test_name_zh', '吴坤');
  const nameZh = await state.getCredential('test_name_zh');
  log('setCredential accepts Chinese name', nameZh === '吴坤', `got: "${nameZh}"`);
}

async function testStateLegacyFingerprintMigration() {
  console.log('\n[Test Group] State: Legacy fingerprint migration (migrateCredential)');
  clearStateStore();

  const encrypted = await encryptWithLegacyFingerprint('test_migrate', 'my-secret-value');
  log('legacy encryption produced ciphertext', encrypted.length > 0, `len=${encrypted.length}`);

  await state.migrateCredential('test_migrate');

  const afterMigration = await state.getCredential('test_migrate');
  log('migrated credential is readable with stable fingerprint', afterMigration === 'my-secret-value', `got: "${afterMigration}"`);

  await state.migrateCredential('test_migrate');
  const afterDoubleMigration = await state.getCredential('test_migrate');
  log('re-migration is no-op (value unchanged)', afterDoubleMigration === 'my-secret-value', `got: "${afterDoubleMigration}"`);
}

async function testStateMigrationClearsDoubleEncrypted() {
  console.log('\n[Test Group] State: Migration clears double-encrypted (corrupted) data');
  clearStateStore();

  await state.setCredential('test_double', 'original-value');
  const raw1 = state.loadState()['test_double'];

  await state.setCredential('test_double', raw1);
  const result = await state.getCredential('test_double');
  log('setCredential with ciphertext value stores empty', result === '', `got: "${result}"`);

  clearStateStore();
  const fakeCiphertext = 'PfDUWIqHhWubnmZBhFxDQ68ckoxRHyBt6YNAANIN6I5Fgg==';
  await encryptWithLegacyFingerprint('test_corrupt', fakeCiphertext);
  await state.migrateCredential('test_corrupt');
  const corrupted = await state.getCredential('test_corrupt');
  log('migrateCredential clears data whose plaintext looks like ciphertext', corrupted === '', `got: "${corrupted}"`);
}

async function testStateStableFingerprintResistsBrowserUpdate() {
  console.log('\n[Test Group] State: Stable fingerprint resists browser update');
  clearStateStore();

  await state.setCredential('test_stable', 'persistent-value');
  const before = await state.getCredential('test_stable');
  log('value readable before UA change', before === 'persistent-value', `got: "${before}"`);

  const originalUA = globalThis.navigator.userAgent;
  globalThis.navigator = { language: 'zh-CN', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) NewBrowser/200.0' };

  const after = await state.getCredential('test_stable');
  log('value still readable after UA change (stable fingerprint)', after === 'persistent-value', `got: "${after}"`);

  globalThis.navigator = { language: 'zh-CN', userAgent: originalUA };
}

async function testStateNonCredentialDataUnaffected() {
  console.log('\n[Test Group] State: Non-credential state operations unaffected');
  clearStateStore();

  state.set('libraryPath', '/Users/test');
  const lib = state.get('libraryPath');
  log('state.get/set works for non-credential data', lib === '/Users/test', `got: "${lib}"`);

  const defaultVal = state.get('nonexistent', 'default');
  log('state.get returns default for missing key', defaultVal === 'default', `got: "${defaultVal}"`);
}

async function testStateIsCredentialKey() {
  console.log('\n[Test Group] State: isCredentialKey classification');
  log('connKey_ prefix is credential', state.isCredentialKey('connKey_jiekou-openai'));
  log('pii_ prefix is credential', state.isCredentialKey('pii_nameEn'));
  log('old-style geminiKey is credential', state.isCredentialKey('geminiKey'));
  log('connUrl_ prefix is NOT credential', !state.isCredentialKey('connUrl_jiekou-openai'));
  log('random key is NOT credential', !state.isCredentialKey('libraryPath'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('=== Unit Tests: OpenAI-Compatible Caching & State.js Encryption ===\n');

  try {
    // ── Part 1: OpenAI-Compatible Caching ──
    console.log('--- Part 1: OpenAI-Compatible Caching Behavior ---');
    await testAnthropicCachingHeaders();
    await delay(100);

    await testNonAnthropicNoCachingHeaders();
    await delay(100);

    await testJiekouAnthropicModelDetection();
    await delay(100);

    await testClaudeInModelNameDetection();
    await delay(100);

    await testUserBlocksWithoutCache();
    await delay(100);

    await testConnectionIdAnthropicDetection();

    // ── Part 2: State.js Encryption ──
    console.log('\n--- Part 2: State.js Encryption / Decryption / Migration ---');
    await testStateEncryptDecryptRoundtrip();
    await testStateDecryptEmptyOrMissing();
    await testStateDecryptFailureReturnsEmpty();
    await testStateLooksLikeCiphertext();
    await testStateLegacyFingerprintMigration();
    await testStateMigrationClearsDoubleEncrypted();
    await testStateStableFingerprintResistsBrowserUpdate();
    await testStateNonCredentialDataUnaffected();
    await testStateIsCredentialKey();

  } catch (err) {
    console.error('\nTest Error:', err.message);
    RESULTS.push({ test: 'Test Error', pass: false, detail: err.message });
  }

  console.log('\n=== Summary ===');
  const passed = RESULTS.filter(item => item.pass).length;
  const failed = RESULTS.filter(item => !item.pass).length;
  console.log(`Total: ${RESULTS.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const item of RESULTS.filter(entry => !entry.pass)) {
      console.log(`  - ${item.test}: ${item.detail}`);
    }
  }

  return failed === 0;
}

runTests().then(success => {
  process.exit(success ? 0 : 1);
});
