/**
 * Lean regression suite.
 *
 * Strategy:
 * - Keep all real Gemini-backed API routes covered once
 * - Keep a small set of high-value local/non-AI regressions
 * - Avoid heavy frontend/jsdom and redundant mock-path coverage here
 *
 * Usage:
 *   GEMINI_KEY=xxx TEST_BASE=http://localhost:3003/api node test-e2e.mjs
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api';
const GEMINI_KEY = process.env.GEMINI_KEY;
const MODEL = 'google-studio-google';
const GEMINI_MODEL_ID = process.env.GEMINI_MODEL_ID || 'gemini-3.1-flash-lite-preview';
const RATE_LIMIT_DELAY = 8000;
const RESULTS = [];

if (!GEMINI_KEY) {
  console.error('请设置环境变量 GEMINI_KEY');
  process.exit(1);
}

const BANNED_MODEL_PATTERNS = [
  /\bimage\b/i,
  /\bimagen\b/i,
  /\bnano\s*banana\b/i,
  /\baudio\b/i,
  /\bspeech\b/i,
  /\btts\b/i,
  /\bembedding\b/i,
  /\bembed\b/i,
  /\bveo\b/i,
  /\bvideo\b/i,
  /\blyria\b/i,
  /\bmusic\b/i,
  /\bdeep[- ]?research\b/i,
  /\brobotics\b/i,
  /\bcomputer[- ]?use\b/i,
];

const SAMPLE_JD = `职位名称：AI标注平台产品经理
公司：美团
部门：AI平台部
工作职责：
1. 负责AI数据标注平台的产品规划和设计
2. 与算法团队协作，优化标注流程和质量管理
3. 推动Human-in-the-Loop标注系统建设
任职要求：
1. 5年以上产品经理经验
2. 熟悉AI/ML工作流
3. 有数据标注或AI平台经验优先`;

const LOCAL_PARSE_JD = `Company: Example Labs
Department: Platform
Job Title: Senior Product Manager

Responsibilities:
- Build AI platform workflows
- Work with engineering teams`;

const SAMPLE_RESUME = `张三
abc@mailbox.com | +86-1234567890

Summary
资深AI产品经理，5年企业级AI平台产品管理经验。

工作经历
ABC公司 | 产品经理 | 2025.03 - 2026.04
- 主导AI Agent平台从0到1建设，DAU增长200%
- 管理5人技术团队，完成10+个AI项目交付
- 推动Agent生态建设，合作伙伴增长35%

教育背景
大学 | 计算机科学 | 硕士`;

const PII = {
  nameEn: 'John Smith',
  nameZh: '张三',
  email: 'john@example.com',
  phone: '+86-1380001234',
  linkedin: 'https://linkedin.com/in/johnsmith',
  github: 'https://github.com/johnsmith',
};

const PLACEHOLDERS = ['<<NAME>>', '<<NAME_ZH>>', '<<EMAIL>>', '<<PHONE>>', '<<LINKEDIN>>', '<<GITHUB>>'];
const REAL_VALUES = [PII.nameEn, PII.nameZh, PII.email, PII.phone, PII.linkedin, PII.github];

const PII_SAMPLE_RESUME = `${PII.nameZh}（${PII.nameEn}）
${PII.email} | ${PII.phone}
LinkedIn: ${PII.linkedin}
GitHub: ${PII.github}

Summary
资深AI产品经理，5年企业级AI平台产品管理经验。

工作经历
ABC公司 | 产品经理 | 2020.03 - 2025.05
- 主导AI Agent平台从0到1建设，DAU增长200%
- 管理5人技术团队，完成10+个AI项目交付

教育背景
大学 | 计算机科学 | 硕士`;

function log(test, pass, detail = '') {
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${test}${detail ? ' - ' + detail : ''}`);
  RESULTS.push({ test, pass, detail });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableErrorText(text = '') {
  const lower = String(text).toLowerCase();
  return lower.includes('配额不足')
    || lower.includes('resource_exhausted')
    || lower.includes('429')
    || lower.includes('503')
    || lower.includes('unavailable')
    || lower.includes('high demand')
    || lower.includes('网络问题')
    || lower.includes('无法连接 gemini api');
}

function parseSSEText(text) {
  let result = '';
  let error = null;
  let usage = null;
  let model = null;

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.type === 'chunk') result += data.text || '';
      if (data.type === 'error') error = data.message || '未知错误';
      if (data.type === 'done') {
        usage = data.usage || null;
        model = data.model || null;
      }
    } catch {}
  }

  return { text: result, error, usage, model };
}

async function postJSON(pathname, body) {
  return fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getJSON(pathname) {
  return fetch(`${BASE}${pathname}`);
}

async function postSSEWithRetry(pathname, body, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await postJSON(pathname, body);
    const text = await res.text();
    const parsed = parseSSEText(text);

    if (parsed.error && isRetryableErrorText(parsed.error) && attempt < retries) {
      const waitSec = 15 * (attempt + 1);
      console.log(`  retryable error, waiting ${waitSec}s before retry ${attempt + 2}/${retries + 1}`);
      await delay(waitSec * 1000);
      continue;
    }

    if (!parsed.text && isRetryableErrorText(text) && attempt < retries) {
      const waitSec = 15 * (attempt + 1);
      console.log(`  retryable transport issue, waiting ${waitSec}s before retry ${attempt + 2}/${retries + 1}`);
      await delay(waitSec * 1000);
      continue;
    }

    if (!parsed.text && parsed.error) {
      throw new Error(parsed.error);
    }

    return parsed;
  }

  throw new Error(`SSE request failed after retries: ${pathname}`);
}

function getInitPayload(piiEnabled = false, extraAllowedPaths = ['/tmp']) {
  const payload = {
    modelConnections: [
      { id: MODEL, key: GEMINI_KEY, model: GEMINI_MODEL_ID, label: 'Google AI Studio' },
    ],
    allowedPaths: extraAllowedPaths,
  };

  if (piiEnabled) {
    payload.piiConfig = {
      enabled: true,
      nameEn: PII.nameEn,
      nameZh: PII.nameZh,
      nameVariants: ['johnsmith'],
      email: PII.email,
      phones: [PII.phone],
      linkedin: PII.linkedin,
      github: PII.github,
      website: '',
      other: [],
    };
  }

  return payload;
}

function checkPiiRestored(result, testName, expectRealPii = true) {
  const leakedPlaceholders = PLACEHOLDERS.filter(token => result.includes(token));
  log(`${testName} no placeholders leaked`, leakedPlaceholders.length === 0,
    leakedPlaceholders.length ? leakedPlaceholders.join(', ') : 'OK');

  if (!expectRealPii) return;

  const restored = REAL_VALUES.filter(value => result.includes(value));
  log(`${testName} real PII restored`, restored.length > 0,
    restored.length ? restored.join(', ') : 'none');
}

async function testInitBase() {
  const res = await postJSON('/init', getInitPayload(false));
  const data = await res.json();
  log('base /init ready', data.success && data.readyConnections.includes(MODEL), `connections=${data.readyConnections}`);
}

async function testExtractJdInfo() {
  let info = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await postJSON('/extract-jd-info', { model: MODEL, jd: SAMPLE_JD });
    info = await res.json();
    if (info.company && info.title && info.usage && typeof info.usage.input === 'number') break;
    if (attempt < 3) {
      const waitSec = 10 * (attempt + 1);
      console.log(`  /extract-jd-info unstable, waiting ${waitSec}s before retry ${attempt + 2}/4`);
      await delay(waitSec * 1000);
    }
  }
  log('/extract-jd-info company', !!info.company, `company="${info.company}"`);
  log('/extract-jd-info title', !!info.title, `title="${info.title}"`);
  log('/extract-jd-info language', info.language === 'zh', `language="${info.language}"`);
  log('/extract-jd-info usage returned', !!info.usage && typeof info.usage.input === 'number', JSON.stringify(info.usage || {}));
}

async function testExtractJdInfoLocalFallback() {
  const res = await postJSON('/extract-jd-info', { jd: LOCAL_PARSE_JD });
  const info = await res.json();
  log('/extract-jd-info local fallback company', info.company === 'Example Labs', JSON.stringify(info));
  log('/extract-jd-info local fallback title', info.title === 'Senior Product Manager', JSON.stringify(info));
  log('/extract-jd-info local fallback usage.local', info.usage?.local === true, JSON.stringify(info.usage || {}));
}

async function testListModels() {
  const res = await postJSON('/list-models', { connectionId: MODEL });
  const data = await res.json();
  const models = data.models || [];
  const searchTexts = models.map(model => `${model.id} ${model.displayName || ''}`);
  const banned = searchTexts.filter(text => BANNED_MODEL_PATTERNS.some(pattern => pattern.test(text)));
  const allGemini = models.every(model => /^gemini-/i.test(model.id));

  log('/list-models has results', models.length > 0, `count=${models.length}`);
  log('/list-models only free text-suitable Gemini', banned.length === 0, banned.join(', '));
  log('/list-models all Gemini family', allGemini, models.map(model => model.id).join(', '));
}

async function testFileRoutesAndDigest() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-e2e-'));
  const alpha = path.join(dir, 'alpha.txt');
  const beta = path.join(dir, 'beta.md');
  const gamma = path.join(dir, 'gamma.pages');
  const html = path.join(dir, 'delta.html');

  await fs.writeFile(alpha, 'Summary\n\nShared Paragraph\n\nAlpha Only', 'utf-8');
  await fs.writeFile(beta, '# Title\n\nShared Paragraph\n\nBeta Only', 'utf-8');
  await fs.writeFile(gamma, '', 'utf-8');
  await fs.writeFile(html, '<html><body><h1>Hello</h1><p>HTML Only</p></body></html>', 'utf-8');

  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));

  const listRes = await getJSON(`/list-files?dir=${encodeURIComponent(dir)}`);
  const listData = await listRes.json();
  const names = listData.files.map(f => `${f.name}:${f.readable}`);
  log('/list-files lists supported files', listData.files.length === 4, names.join(', '));
  log('/list-files marks pages unreadable', listData.files.some(f => f.name === 'gamma.pages' && f.readable === false), names.join(', '));

  const readTxtRes = await getJSON(`/read-file?path=${encodeURIComponent(alpha)}`);
  const readTxtData = await readTxtRes.json();
  log('/read-file txt returns content', readTxtData.content.includes('Alpha Only'), readTxtData.content);

  const readPagesRes = await getJSON(`/read-file?path=${encodeURIComponent(gamma)}`);
  const readPagesData = await readPagesRes.json();
  log('/read-file pages returns manual paste hint', readPagesRes.status === 400 && readPagesData.error === 'PAGES_NOT_SUPPORTED', JSON.stringify(readPagesData));

  const savePath = path.join(dir, 'saved.txt');
  const saveRes = await postJSON('/save-file', { filePath: savePath, content: 'Saved\n\nShared Paragraph\n\nNew Info' });
  const saveData = await saveRes.json();
  log('/save-file success', saveData.success === true, JSON.stringify(saveData));

  const digestRes = await postJSON('/library-digest', { dir, excludeNames: ['gamma.pages'] });
  const digest = await digestRes.json();
  const flattened = digest.digest.map(item => item.content).join('\n');
  const sharedCount = (flattened.match(/Shared Paragraph/g) || []).length;
  log('/library-digest deduplicates shared paragraphs', sharedCount === 1, flattened);

  // Full export (no excludeNames) — simulates the "导出预处理文本素材库" feature
  const exportRes = await postJSON('/library-digest', { dir });
  const exportData = await exportRes.json();
  const exportNames = exportData.digest.map(item => item.name);
  const hasAllReadable = ['alpha.txt', 'beta.md', 'delta.html', 'saved.txt'].every(n => exportNames.includes(n));
  log('/library-digest full export includes all readable files', hasAllReadable, exportNames.join(', '));
  log('/library-digest full export fileCount', exportData.fileCount >= 4, `fileCount=${exportData.fileCount}`);
  const exportFlattened = exportData.digest.map(item => item.content).join('\n');
  const exportSharedCount = (exportFlattened.match(/Shared Paragraph/g) || []).length;
  log('/library-digest full export still deduplicates', exportSharedCount === 1, `sharedCount=${exportSharedCount}`);
}

async function testMockJdImageOcr() {
  const res = await postJSON('/ocr-jd-images', {
    model: MODEL,
    mock: true,
    images: [{ mimeType: 'image/jpeg', data: 'ZmFrZQ==' }],
  });
  const data = await res.json();
  log('/ocr-jd-images mock returns text', data.text?.includes('岗位职责'), JSON.stringify(data));
}

async function testJdImageOcrValidation() {
  const res = await postJSON('/ocr-jd-images', {
    model: MODEL,
    images: [],
  });
  const data = await res.json();
  log('/ocr-jd-images empty images -> 400', res.status === 400, JSON.stringify(data));
}

async function testJdImageOcrInvalidModel() {
  const res = await postJSON('/ocr-jd-images', {
    model: '',
    images: [{ mimeType: 'image/jpeg', data: 'ZmFrZQ==' }],
  });
  const data = await res.json();
  log('/ocr-jd-images invalid model returns error', !res.ok && !!data.error, JSON.stringify(data));
}

async function testJdImageOcrRealOptional() {
  // Optional real OCR smoke to avoid flaky failures in constrained CI/network environments.
  if (process.env.RUN_OCR_REAL !== '1') {
    log('/ocr-jd-images real smoke skipped', true, 'set RUN_OCR_REAL=1 to enable');
    return;
  }

  // 1x1 png (transparent) base64; valid image payload for route plumbing.
  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP+2y4wqQAAAABJRU5ErkJggg==';
  const res = await postJSON('/ocr-jd-images', {
    model: MODEL,
    images: [{ mimeType: 'image/png', data: tinyPngBase64 }],
  });
  const data = await res.json();
  const hasShape = res.ok && typeof data.text === 'string' && data.usage && typeof data.model === 'string';
  log('/ocr-jd-images real smoke structure', hasShape, JSON.stringify(data));
}

async function testGenerate() {
  const result = await postSSEWithRetry('/generate', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    generateCoverLetter: true,
    previouslySubmitted: '',
  });

  log('/generate has content', result.text.length > 500, `length=${result.text.length}`);
  log('/generate resume marker', result.text.includes('简历正文'));
  log('/generate cover letter', result.text.includes('求职信'));
  log('/generate AI notes', result.text.includes('AI备注'));
  log('/generate usage returned', !!result.usage && typeof result.usage.input === 'number', JSON.stringify(result.usage || {}));
  return result.text;
}

async function testGenerateNoNotes() {
  const result = await postSSEWithRetry('/generate', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    generateCoverLetter: false,
    generateNotes: false,
  });

  log('/generate generateNotes=false', !result.text.includes('AI备注'), `length=${result.text.length}`);
}

async function testReview(generatedResume) {
  const result = await postSSEWithRetry('/review', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    updatedResume: generatedResume || SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    previouslySubmitted: '',
  });

  log('/review has content', result.text.length > 200, `length=${result.text.length}`);
  log('/review has score-like output', /\d{1,3}/.test(result.text), result.text.slice(0, 120).replace(/\n/g, '\\n'));
  return result.text;
}

async function testReviewMulti(generatedResume) {
  const result = await postSSEWithRetry('/review-multi', {
    models: [MODEL, MODEL],
    orchestratorModel: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    updatedResume: generatedResume || SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    previouslySubmitted: '',
  });

  log('/review-multi has merged content', result.text.length > 250, `length=${result.text.length}`);
  log('/review-multi merge banner present', result.text.includes('正在合并评审意见') || result.text.includes('综合'), result.text.slice(0, 120).replace(/\n/g, '\\n'));
}

async function testApplyReview(reviewComments) {
  const result = await postSSEWithRetry('/apply-review', {
    model: MODEL,
    currentResume: SAMPLE_RESUME,
    reviewComments: reviewComments || '1. Summary需要更精炼\n2. 需要增加数据标注相关经验的描述',
    jd: SAMPLE_JD,
  });

  const diffs = [];
  const regex = /\[REPLACE\]\s*\n<<<\n([\s\S]*?)\n>>>\n([\s\S]*?)\n\[\/REPLACE\]/g;
  let match;
  while ((match = regex.exec(result.text)) !== null) {
    diffs.push({ old: match[1], next: match[2] });
  }

  log('/apply-review has REPLACE blocks', result.text.includes('[REPLACE]'), `length=${result.text.length}`);
  log('/apply-review parseable diffs', diffs.length > 0, `count=${diffs.length}`);
}

async function testReviewChat() {
  const result = await postSSEWithRetry('/chat', {
    model: MODEL,
    chatType: 'review',
    messages: [
      { role: 'user', content: `请问这份简历的Summary部分有什么需要改进的？\n\n简历：\n${SAMPLE_RESUME}` },
    ],
  });

  log('/chat review has content', result.text.length > 50, `length=${result.text.length}`);
}

async function testConnectionFallbackWithoutModel() {
  await postJSON('/init', getInitPayload(false));
  const result = await postSSEWithRetry('/chat', {
    chatType: 'review',
    messages: [{ role: 'user', content: '请用一句话评价这份简历。' }],
  });
  log('/chat single-connection fallback works', result.text.length > 10, result.text.slice(0, 80));
}

async function testGenerateHtml() {
  const result = await postSSEWithRetry('/generate-html', {
    model: MODEL,
    resumeText: SAMPLE_RESUME,
    htmlInstructions: '',
  });

  const hasHtmlTag = /<html/i.test(result.text);
  const hasSemantics = result.text.includes('<h1') || result.text.includes('<h2') || result.text.includes('<p');
  log('/generate-html semantics returned', hasSemantics, `length=${result.text.length}`);
  log('/generate-html body-only response', !hasHtmlTag, `hasHtmlTag=${hasHtmlTag}`);
}

async function testInitPii() {
  const res = await postJSON('/init', getInitPayload(true));
  const data = await res.json();
  log('pii /init ready', data.success && data.readyConnections.includes(MODEL), `connections=${data.readyConnections}`);
}

async function testPiiGenerate() {
  const result = await postSSEWithRetry('/generate', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: PII_SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    generateCoverLetter: false,
    generateNotes: false,
    previouslySubmitted: '',
  });

  log('pii /generate has content', result.text.length > 200, `length=${result.text.length}`);
  checkPiiRestored(result.text, 'pii /generate');
  return result.text;
}

async function testPiiReview(generatedResume) {
  const result = await postSSEWithRetry('/review', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: PII_SAMPLE_RESUME,
    updatedResume: generatedResume,
    resumeLibrary: [],
    instructions: '',
    previouslySubmitted: '',
  });

  log('pii /review has content', result.text.length > 100, `length=${result.text.length}`);
  checkPiiRestored(result.text, 'pii /review', false);
}

async function testPiiChat() {
  const result = await postSSEWithRetry('/chat', {
    model: MODEL,
    chatType: 'generator',
    messages: [
      { role: 'user', content: `请先原样复述这份简历开头的姓名和联系方式，再给出一句Summary改进建议。\n\n${PII_SAMPLE_RESUME}` },
    ],
  });

  log('pii /chat generator has content', result.text.length > 30, `length=${result.text.length}`);
  checkPiiRestored(result.text, 'pii /chat generator');
}

async function testPiiGenerateHtml() {
  const result = await postSSEWithRetry('/generate-html', {
    model: MODEL,
    resumeText: PII_SAMPLE_RESUME,
    htmlInstructions: '',
  });

  log('pii /generate-html has content', result.text.length > 100, `length=${result.text.length}`);
  checkPiiRestored(result.text, 'pii /generate-html');
}

async function main() {
  console.log('\n=== Resume Tailor Lean E2E ===\n');

  try {
    await testInitBase();
    await delay(RATE_LIMIT_DELAY);
    await testExtractJdInfo();
    await testExtractJdInfoLocalFallback();
    await delay(RATE_LIMIT_DELAY);
    await testListModels();
    await testFileRoutesAndDigest();
    await testMockJdImageOcr();
    await testJdImageOcrValidation();
    await testJdImageOcrInvalidModel();
    await testJdImageOcrRealOptional();
    await delay(RATE_LIMIT_DELAY);
    const generated = await testGenerate();
    await delay(RATE_LIMIT_DELAY);
    await testGenerateNoNotes();
    await delay(RATE_LIMIT_DELAY);
    const review = await testReview(generated);
    await delay(RATE_LIMIT_DELAY);
    await testReviewMulti(generated);
    await delay(RATE_LIMIT_DELAY);
    await testApplyReview(review);
    await delay(RATE_LIMIT_DELAY);
    await testReviewChat();
    await delay(RATE_LIMIT_DELAY);
    await testConnectionFallbackWithoutModel();
    await delay(RATE_LIMIT_DELAY);
    await testGenerateHtml();

    await delay(RATE_LIMIT_DELAY);
    await testInitPii();
    await delay(RATE_LIMIT_DELAY);
    const piiGenerated = await testPiiGenerate();
    await delay(RATE_LIMIT_DELAY);
    await testPiiReview(piiGenerated);
    await delay(RATE_LIMIT_DELAY);
    await testPiiChat();
    await delay(RATE_LIMIT_DELAY);
    await testPiiGenerateHtml();
  } catch (err) {
    console.error('\nFATAL:', err.message);
    RESULTS.push({ test: 'FATAL', pass: false, detail: err.message });
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

  process.exit(failed > 0 ? 1 : 0);
}

main();
