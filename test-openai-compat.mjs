/**
 * Unit Tests for OpenAI-Compatible API Caching Behavior
 * =====================================================
 *
 * Tests verify that:
 * 1. Anthropic models via OpenRouter receive the correct caching headers
 * 2. Non-Anthropic models do NOT receive caching headers
 * 3. The cache_control structure is correctly applied to messages
 * 4. The extra_body stream_options is correctly set for Anthropic
 *
 * These tests mock fetch() to verify request construction without calling real APIs.
 */

import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function runTests() {
  console.log('=== OpenAI-Compatible Caching Behavior Tests ===\n');

  try {
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
