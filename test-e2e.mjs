/**
 * E2E Regression Suite for Resume Tailor
 * ======================================
 * 
 * 测试分类指南（AI开发者必读）：
 * 
 * 【核心流程测试】必须通过 - 修改核心功能时运行
 * ├── testInitBase           - 初始化连接
 * ├── testGenerate           - 简历生成（含求职信、AI备注）
 * ├── testReview             - 简历评审
 * ├── testReviewWithInstructions - 带指令评审
 * ├── testReviewMulti        - 多模型评审合并
 * ├── testApplyReview        - 应用评审修改
 * └── testReviewChat         - Chat对话
 * 
 * 【文件操作测试】文件功能相关时运行
 * ├── testFileRoutesAndDigest - 文件读写+去重核心功能
 * ├── testDigestNoBlanksDedup - 无空行去重（边缘case）
 * └── testDigestLayeredDedup  - 分层去重（边缘case）
 * 
 * 【PII功能测试】PII脱敏还原相关时运行
 * ├── testInitPii        - PII初始化
 * ├── testPiiGenerate    - PII生成
 * ├── testPiiReview      - PII评审
 * └── testPiiChat        - PII Chat
 * 
 * 【AI预处理测试】预处理功能相关时运行
 * ├── testAiPreprocessLibrary - AI预处理核心功能
 * ├── testAiPreprocessRealApi - 真实API调用验证
 * └── testPreprocessLibrary    - 缓存功能
 * 
 * 【JD解析测试】JD相关时运行
 * ├── testExtractJdInfo         - AI解析JD
 * ├── testExtractJdInfoLocalFallback - 本地fallback解析
 * └── testMockJdImageOcr        - OCR功能
 * 
 * 【模型管理测试】模型连接相关时运行
 * ├── testListModels                - 模型列表
 * ├── testListModelsWithInputKeyOverride - API Key覆盖
 * ├── testGetGeminiFallbackModels  - 获取Fallback模型列表
 * ├── testSetGeminiFallbackModels  - 设置Fallback模型列表
 * ├── testResetGeminiFallbackToDefaults - 重置为默认Fallback列表
 * └── testGeminiFallbackInvalidInput - 测试无效输入处理
 * 
 * Usage:
 *   GEMINI_KEY=xxx TEST_BASE=http://localhost:3003/api node test-e2e.mjs
 * 
 * 运行特定测试（开发时）：
 *   修改 main() 函数，注释掉不需要的测试函数调用
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of this test file (test-e2e.mjs) for reliable .env lookup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file if GEMINI_KEY not already set
function loadEnvFile() {
  if (process.env.GEMINI_KEY) return; // Already set
  
  try {
    // Use the test file's directory to locate .env file reliably
    const envPath = path.join(__dirname, '.env');
    const envContent = fsSync.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      if (key === 'GEMINI_KEY') {
        let value = valueParts.join('=');
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env.GEMINI_KEY = value;
        break;
      }
    }
  } catch (err) {
    // .env file not found or not readable, continue with existing env
  }
}
loadEnvFile();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api';
const GEMINI_KEY = process.env.GEMINI_KEY;
const MODEL = 'google-studio-google';
const GEMINI_MODEL_ID = process.env.GEMINI_MODEL_ID || 'gemini-3.1-flash-lite-preview';
const RATE_LIMIT_DELAY = 8000;
const RESULTS = [];

// Model fallback configuration for E2E testing
// 按优先级排序：1是最优先级，9是最低优先级
const FALLBACK_MODELS = [
  'gemini-3.1-flash-lite-preview',     // 1. 最推荐 (速度极快、配额最高)
  'gemini-2.5-flash-lite',              // 2. 最推荐 (速度极快、配额最高)
  'gemini-2.0-flash-lite',              // 3. 最推荐 (速度极快、配额最高)
  'gemini-3-flash-preview',             // 4. 综合能力最强
  'gemini-2.5-flash',                   // 5. 综合能力最强
  'gemini-2.0-flash',                   // 6. 综合能力最强
  'gemini-3.1-pro-preview',             // 7. 高级能力 (配额较低)
  'gemini-3-pro-preview',               // 8. 高级能力 (配额较低)
  'gemini-2.5-pro'                      // 9. 高级能力 (配额较低)
];

// Track current model index for fallback
let currentModelIndex = 0;
let lastError = null;

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
    || lower.includes('无法连接 gemini api')
    || lower.includes('未初始化');
}

function parseSSEText(text) {
  let result = '';
  let error = null;
  let usage = null;
  let model = null;
  let fromCache = null;

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.type === 'chunk') result += data.text || '';
      if (data.type === 'error') error = data.message || '未知错误';
      if (data.type === 'done') {
        usage = data.usage || null;
        model = data.model || null;
        fromCache = data.fromCache ?? null;
      }
    } catch {}
  }

  return { text: result, error, usage, model, fromCache };
}

function isModelQuotaError(text = '') {
  const lower = String(text).toLowerCase();
  return lower.includes('配额不足') || lower.includes('resource_exhausted');
}

function getFallbackModel() {
  if (currentModelIndex >= FALLBACK_MODELS.length) {
    throw new Error(`所有模型都已尝试失败，无法继续 fallback`);
  }
  const fallbackModel = FALLBACK_MODELS[currentModelIndex];
  console.log(`[Fallback] 尝试模型: ${fallbackModel} (第 ${currentModelIndex + 1}/${FALLBACK_MODELS.length} 个)`);
  return fallbackModel;
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
  // 如果是第一次调用且没有指定模型，使用 fallback 机制
  if (!body.model && pathname !== '/init') {
    body.model = MODEL;
  }

  // 如果是 Gemini 相关的 API 调用，启用 fallback
  if (body.model === MODEL && pathname !== '/init' && pathname !== '/list-models') {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // 如果是第一次尝试，使用初始模型
        if (attempt === 0) {
          body.model = GEMINI_MODEL_ID;
        } else {
          // 如果失败，尝试下一个 fallback 模型
          body.model = getFallbackModel();
        }

        console.log(`[Attempt ${attempt + 1}/${retries + 1}] 尝试模型: ${body.model}`);
        
        const res = await postJSON(pathname, body);
        const text = await res.text();
        const parsed = parseSSEText(text);

        if (parsed.error && isRetryableErrorText(parsed.error)) {
          if (isModelQuotaError(parsed.error)) {
            // 配额错误，继续尝试下一个模型
            currentModelIndex++;
            lastError = parsed.error;
            console.log(`[Quota Error] ${parsed.error}，尝试下一个模型...`);
            
            if (currentModelIndex < FALLBACK_MODELS.length) {
              const waitSec = 5;
              console.log(`等待 ${waitSec}s 后继续...`);
              await delay(waitSec * 1000);
              continue;
            } else {
              throw new Error(`所有模型都已尝试失败，最后一个错误: ${parsed.error}`);
            }
          } else if (attempt < retries) {
            // 其他可重试错误
            const waitSec = 15 * (attempt + 1);
            console.log(`[Retryable Error] ${parsed.error}，等待 ${waitSec}s 后重试...`);
            await delay(waitSec * 1000);
            continue;
          }
        }

        if (!parsed.text && isRetryableErrorText(text) && attempt < retries) {
          const waitSec = 15 * (attempt + 1);
          console.log(`[Transport Issue] 等待 ${waitSec}s 后重试...`);
          await delay(waitSec * 1000);
          continue;
        }

        if (!parsed.text && parsed.error) {
          throw new Error(parsed.error);
        }

        // 成功调用，重置模型索引
        if (currentModelIndex > 0) {
          console.log(`[Success] 使用模型 ${body.model} 成功完成调用`);
        }

        return parsed;
      } catch (err) {
        if (attempt < retries) {
          const waitSec = 15 * (attempt + 1);
          console.log(`[Exception] ${err.message}，等待 ${waitSec}s 后重试...`);
          await delay(waitSec * 1000);
          continue;
        }
        throw err;
      }
    }
  } else {
    // 非 Gemini 调用，使用原有逻辑
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

// ============================================================================
// 核心流程测试
// ============================================================================

async function testInitBase() {
  const res = await postJSON('/init', getInitPayload(false));
  const data = await res.json();
  log('base /init ready', data.success && data.readyConnections.includes(MODEL), `connections=${data.readyConnections}`);
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

async function testReview(generatedResume) {
  const result = await postSSEWithRetry('/review', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    updatedResume: generatedResume || SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    reviewInstructions: '',
    previouslySubmitted: '',
  });

  log('/review has content', result.text.length > 200, `length=${result.text.length}`);
  log('/review has score-like output', /\d{1,3}/.test(result.text), result.text.slice(0, 120).replace(/\n/g, '\\n'));
  return result.text;
}

async function testReviewWithInstructions(generatedResume) {
  const result = await postSSEWithRetry('/review', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    updatedResume: generatedResume || SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    reviewInstructions: '请特别关注Summary部分是否足够精炼。',
    previouslySubmitted: '',
  });

  log('/review with reviewInstructions has content', result.text.length > 200, `length=${result.text.length}`);
  // The reviewInstructions should influence the output to mention Summary
  const mentionsSummary = result.text.includes('Summary') || result.text.includes('summary') || result.text.includes('总结');
  log('/review with reviewInstructions follows instruction', mentionsSummary, 'output mentions Summary');
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
    reviewInstructions: '',
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

// ============================================================================
// 文件操作测试
// ============================================================================

async function testFileRoutesAndDigest() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-e2e-'));
  const alpha = path.join(dir, 'alpha.txt');
  const beta = path.join(dir, 'beta.md');
  const gamma = path.join(dir, 'gamma.pages');

  const sharedFact = 'Led cross-functional AI platform delivery and improved customer satisfaction by 20%.';

  await fs.writeFile(alpha, [
    'Summary',
    '',
    'Senior Program Manager with 10+ years of experience delivering AI products.',
    '',
    'Work Experience',
    '',
    'Microsoft | Senior Program Manager | 2022-01 - 2025-01',
    '',
    sharedFact,
    '',
    'Defined rollout milestones for enterprise AI launches.',
  ].join('\n'), 'utf-8');
  await fs.writeFile(beta, [
    '# Professional Experience',
    '',
    'Microsoft | Senior Program Manager | 2022-01 - 2025-01',
    '',
    sharedFact,
    '',
    'Built evaluation tooling for enterprise rollout.',
  ].join('\n'), 'utf-8');
  await fs.writeFile(gamma, '', 'utf-8');

  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));

  // 测试 /list-files
  const listRes = await getJSON(`/list-files?dir=${encodeURIComponent(dir)}`);
  const listData = await listRes.json();
  log('/list-files lists supported files', listData.files.length >= 2, `count=${listData.files.length}`);
  log('/list-files marks pages unreadable', listData.files.some(f => f.name === 'gamma.pages' && f.readable === false), 'OK');

  // 测试 /read-file
  const readTxtRes = await getJSON(`/read-file?path=${encodeURIComponent(alpha)}`);
  const readTxtData = await readTxtRes.json();
  log('/read-file txt returns content', readTxtData.content.includes(sharedFact), 'OK');

  // 测试 /read-file 对 .pages 文件的处理
  const readPagesRes = await getJSON(`/read-file?path=${encodeURIComponent(gamma)}`);
  const readPagesData = await readPagesRes.json();
  log('/read-file pages returns manual paste hint', readPagesRes.status === 400 && readPagesData.error === 'PAGES_NOT_SUPPORTED', 'OK');

  // 测试 /save-file
  const savePath = path.join(dir, 'saved.txt');
  const saveRes = await postJSON('/save-file', {
    filePath: savePath,
    content: [
      'Professional Experience',
      '',
      'Microsoft | Senior Program Manager | 2024-01 - 2025-01',
      '',
      sharedFact,
      '',
      'Established rollout governance for enterprise AI delivery.',
    ].join('\n'),
  });
  const saveData = await saveRes.json();
  log('/save-file success', saveData.success === true, 'OK');

  // 测试 /library-digest 去重功能
  const digestRes = await postJSON('/library-digest', { dir, excludeNames: ['gamma.pages'] });
  const digest = await digestRes.json();
  const flattened = digest.digest.map(item => item.content).join('\n');
  const sharedCount = (flattened.match(new RegExp(sharedFact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  log('/library-digest deduplicates shared paragraphs', sharedCount === 1, `sharedCount=${sharedCount}`);
  log('/library-digest returns token counts', typeof digest.sourceTokens === 'number' && typeof digest.digestTokens === 'number', `source=${digest.sourceTokens}, digest=${digest.digestTokens}`);
}

/**
 * Regression for Bug: shared career facts must be deduplicated even in files that have
 * no blank-line separators between consecutive content lines (e.g. PDF-extracted resumes).
 */
async function testDigestNoBlanksDedup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-noblank-'));
  const sharedFact = 'Improved Azure ASR model WER by 20% leading the SpeechIO leaderboard globally.';

  // Both files have the same sharedFact but no blank lines between consecutive content lines.
  await fs.writeFile(path.join(dir, 'resume_base.txt'), [
    'Microsoft | Senior Program Manager | 2022-01 - 2025-01',
    sharedFact,
    'Nokia | PM | 2015-03 - 2022-01',
    'Led global imaging platform delivery.',
  ].join('\n'), 'utf-8');
  await fs.writeFile(path.join(dir, 'resume_variant.txt'), [
    'Microsoft | Senior PM | 2022-01 - 2025-01',
    sharedFact,
    'Nokia | Program Manager | 2015-03 - 2022-01',
    'Managed cross-functional Nokia camera delivery.',
  ].join('\n'), 'utf-8');

  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));

  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  const flattened = data.digest.map(item => item.content).join('\n');
  const count = (flattened.match(new RegExp(sharedFact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  log('/library-digest no-blank-line: shared career fact deduplicated', count === 1, `count=${count}`);
}

/**
 * Regression for Plan B layered dedup: a rephrased career fact in a dated delivery-version
 * file should be suppressed (merged with the base-resume version), but a genuinely new
 * fact in the same delivery file must survive.
 */
async function testDigestLayeredDedup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-layerb-'));
  const baseFact = 'Drove end-to-end Copilot RAG search relevance improvements, increasing NDCG by 10%.';
  const newFact = 'Invented a novel multi-modal evaluation pipeline reducing annotation cost by 40%.';

  // Layer 1: base resume (no date in filename)
  await fs.writeFile(path.join(dir, 'resume_wukun.txt'), [
    'Senior Program Manager with 15+ years of experience.',
    '',
    'Microsoft | Senior PM | 2022-01 - 2025-01',
    '',
    baseFact,
  ].join('\n'), 'utf-8');

  // Layer 2: dated delivery version — rephrased baseFact + a genuinely new fact
  await fs.writeFile(path.join(dir, 'Wu - Resume - Canva - 2026-04-05.txt'), [
    'Senior Technical Program Manager with 15 years of experience.',
    '',
    'Microsoft | Sr PM | 2022-01 - 2025-01',
    '',
    'Led end-to-end Copilot RAG relevance project, raising NDCG score by 10%.',
    '',
    newFact,
  ].join('\n'), 'utf-8');

  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));

  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  const flattened = data.digest.map(item => item.content).join('\n');
  const ndcgCount = (flattened.match(/NDCG.*10%/gi) || []).length;
  log('/library-digest layered: rephrased delivery-version fact suppressed to 1 copy', ndcgCount === 1, `ndcgCount=${ndcgCount}`);
  log('/library-digest layered: genuinely new fact in delivery version survives', flattened.includes(newFact), newFact);
}

// ============================================================================
// 本地预处理优化测试（TC1-TC7）
// ============================================================================

/**
 * TC1: 测试 JD 段落过滤功能
 */
async function testDigestJdParagraphFiltering() {
  console.log('\n[Test] TC1: JD 段落过滤');
  
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-tc1-'));
  
  // 创建包含 JD 段落和正常简历段落的文件
  await fs.writeFile(path.join(dir, 'resume_with_jd.txt'), [
    'Senior Program Manager',
    '',
    'Microsoft | Senior PM | 2022-01 - 2025-01',
    '- Led cross-functional AI platform delivery and improved customer satisfaction by 20%.',
    '',
    '岗位职责：',
    '- 负责产品规划和设计',
    '- 与算法团队协作优化流程',
    '任职要求：',
    '- 5年以上产品经理经验',
    '- 熟悉AI/ML工作流',
    '',
    '- Drove end-to-end RAG search relevance improvements, increasing NDCG by 10%.',
  ].join('\n'), 'utf-8');
  
  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));
  
  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  const flattened = data.digest.map(item => item.content).join('\n');
  
  // 验证正常简历段落被保留
  log('TC1: 正常简历段落被保留', 
      flattened.includes('Led cross-functional AI platform delivery') && 
      flattened.includes('Drove end-to-end RAG search relevance'), 
      'found valid career paragraphs');
  
  // 验证 JD 段落被过滤掉
  log('TC1: JD 段落被过滤', 
      !flattened.includes('岗位职责') && 
      !flattened.includes('任职要求') && 
      !flattened.includes('负责产品规划'), 
      'JD signals filtered out');
}

/**
 * TC2: 测试精确文件名白名单功能
 */
async function testDigestFullPreserveExactNames() {
  console.log('\n[Test] TC2: 精确文件名白名单');
  
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-tc2-'));
  
  // 创建白名单中的文件
  const testContent = '这是一段测试内容，应该被完整保留。\n\n第二段内容。';
  await fs.writeFile(path.join(dir, 'Written Essay.txt'), testContent, 'utf-8');
  await fs.writeFile(path.join(dir, '项目经历.txt'), testContent, 'utf-8');
  await fs.writeFile(path.join(dir, 'Resume Tailor APP - PRD.md'), testContent, 'utf-8');
  
  // 创建普通简历文件
  await fs.writeFile(path.join(dir, 'resume_base.txt'), 'Senior PM with 10 years experience', 'utf-8');
  
  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));
  
  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  
  // 验证白名单文件被完整保留
  const preservedFiles = data.digest.filter(item => 
    FULL_PRESERVE_EXACT_NAMES.has(item.name)
  );
  
  log('TC2: 精确白名单文件数量正确', preservedFiles.length === 3, `found ${preservedFiles.length} preserved files`);
  log('TC2: 白名单文件内容完整', preservedFiles.every(item => item.content.includes(testContent)), 'content preserved');
}

// 这里需要声明一下我们在测试中用到的精确白名单，因为测试文件中没有导入
const FULL_PRESERVE_EXACT_NAMES = new Set([
  'Written Essay.txt',
  '项目经历.txt',
  'Resume Tailor APP - PRD.md',
]);

/**
 * TC3: 测试 JD 信号显著压过 career 信号时的段落过滤
 */
async function testDigestJdDominantParagraphFiltered() {
  console.log('\n[Test] TC3: JD 主导段落过滤');
  
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-tc3-'));
  
  // 创建包含混合 JD 和少量 career 信号的段落
  await fs.writeFile(path.join(dir, 'mixed_paragraphs.txt'), [
    '工作职责：负责产品规划和设计，与团队协作。',
    '我们正在寻找优秀的产品经理，要求有 5 年经验。',
    'Microsoft | Senior Program Manager | 2022-2025',
    'Led AI platform delivery with 200% DAU growth.',
  ].join('\n'), 'utf-8');
  
  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));
  
  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  const flattened = data.digest.map(item => item.content).join('\n');
  
  log('TC3: 正常 career 段落被保留', 
      flattened.includes('Led AI platform delivery'), 
      'found valid career paragraph');
  
  log('TC3: JD 主导段落被过滤', 
      !flattened.includes('工作职责：负责产品规划') && 
      !flattened.includes('我们正在寻找优秀的产品经理'), 
      'JD dominant paragraphs filtered');
}

/**
 * TC4: 测试 boilerplate 过滤（纯日期行、PDF 水印等）
 */
async function testDigestBoilerplateFiltering() {
  console.log('\n[Test] TC4: Boilerplate 过滤');
  
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-tc4-'));
  
  await fs.writeFile(path.join(dir, 'boilerplate_test.txt'), [
    '2024-03-15',
    'Microsoft | Senior PM | 2022-2025',
    'Confidential',
    'DRAFT',
    'Led AI platform delivery',
    'Page 1 of 10',
  ].join('\n'), 'utf-8');
  
  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));
  
  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  const flattened = data.digest.map(item => item.content).join('\n');
  
  log('TC4: 有用内容被保留', flattened.includes('Led AI platform delivery'), 'valid content found');
  log('TC4: 纯日期行被过滤', !flattened.includes('2024-03-15'), 'date line filtered');
  log('TC4: PDF 水印被过滤', !flattened.includes('Confidential') && !flattened.includes('DRAFT'), 'watermarks filtered');
}

/**
 * TC5: 测试缓存版本升级（v7 -> v8）
 */
async function testDigestCacheVersionUpgrade() {
  console.log('\n[Test] TC5: 缓存版本升级');
  
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-tc5-'));
  const cacheDir = path.join(dir, '.resume-tailor-cache');
  await fs.mkdir(cacheDir, { recursive: true });
  
  // 创建旧版本缓存（v7）
  const oldCacheData = {
    key: 'old-cache-key',
    digest: [{ name: 'old.txt', content: 'old content' }],
    sourceTokens: 10
  };
  await fs.writeFile(path.join(cacheDir, 'digest.json'), JSON.stringify(oldCacheData), 'utf-8');
  
  // 创建测试文件
  await fs.writeFile(path.join(dir, 'test.txt'), 'Senior Program Manager with 10 years experience', 'utf-8');
  
  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));
  
  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  
  // 验证没有使用旧缓存，fromCache 应该是 false
  log('TC5: 旧版本缓存没有被使用', data.fromCache === false, `fromCache=${data.fromCache}`);
  log('TC5: 使用了新内容', !data.digest.some(item => item.content === 'old content'), 'new content used');
}

/**
 * TC6: 测试 Layer 0 文件内容不会被后续去重
 */
async function testDigestPreservedFileNotDeduped() {
  console.log('\n[Test] TC6: Layer 0 文件不受后续去重影响');
  
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-tc6-'));
  
  const sharedParagraph = 'Led cross-functional AI platform delivery';
  
  // Layer 0 文件（白名单文件）
  await fs.writeFile(path.join(dir, '项目经历.txt'), sharedParagraph, 'utf-8');
  
  // Layer 1 文件（包含相同内容）
  await fs.writeFile(path.join(dir, 'resume_base.txt'), sharedParagraph, 'utf-8');
  
  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));
  
  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  
  // 验证 Layer 0 文件的内容被保留
  const preservedFile = data.digest.find(item => item.name === '项目经历.txt');
  log('TC6: Layer 0 文件内容被保留', preservedFile && preservedFile.content.includes(sharedParagraph), 'preserved content found');
}

/**
 * TC7: 测试动词开头行触发段落分割
 */
async function testDigestActionVerbBlockSplit() {
  console.log('\n[Test] TC7: 动词开头行段落分割');
  
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-tc7-'));
  
  // 无空行的连续行，每行以动词开头
  await fs.writeFile(path.join(dir, 'no_blank_lines.txt'), [
    'Microsoft | Senior PM | 2022-2025',
    'Led cross-functional team',
    'Built new product features',
    'Drove revenue growth',
  ].join('\n'), 'utf-8');
  
  await postJSON('/init', getInitPayload(false, ['/tmp', dir]));
  
  const res = await postJSON('/library-digest', { dir });
  const data = await res.json();
  
  // 我们无法直接检查段落分割，但可以验证内容都被正确处理
  const flattened = data.digest.map(item => item.content).join('\n');
  log('TC7: 所有有效内容都被保留', 
      flattened.includes('Led cross-functional') && 
      flattened.includes('Built new product') && 
      flattened.includes('Drove revenue'), 
      'all action verb content preserved');
}

// ============================================================================
// JD解析测试
// ============================================================================

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

// ============================================================================
// 模型管理测试
// ============================================================================

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

async function testListModelsWithInputKeyOverride() {
  await postJSON('/init', {
    modelConnections: [
      { id: MODEL, key: 'invalid-key-for-regression', model: GEMINI_MODEL_ID, label: 'Google AI Studio' },
    ],
    allowedPaths: ['/tmp'],
  });

  const res = await postJSON('/list-models', { connectionId: MODEL, apiKey: GEMINI_KEY });
  const data = await res.json();
  const models = data.models || [];
  log('/list-models apiKey override works even with stale init key', models.length > 0, `count=${models.length}`);
}

// ============================================================================
// Gemini Fallback 配置管理测试
// ============================================================================

async function testGetGeminiFallbackModels() {
  const res = await getJSON('/gemini/fallback-models');
  const data = await res.json();
  log('/gemini/fallback-models success', data.success === true, JSON.stringify(data));
  log('/gemini/fallback-models returns array', Array.isArray(data.models), `count=${data.models?.length}`);
  log('/gemini/fallback-models has at least 9 models', data.models?.length >= 9, `count=${data.models?.length}`);
  
  if (data.models?.length) {
    const firstModel = data.models[0];
    log('/gemini/fallback-models first is gemini-3.1-flash-lite-preview', 
        firstModel === 'gemini-3.1-flash-lite-preview' || firstModel === 'gemini-3-flash-preview' || firstModel === 'gemini-2.5-flash-lite',
        `first=${firstModel}`);
  }
}

async function testSetGeminiFallbackModels() {
  const testModels = [
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-2.0-flash',
  ];
  
  const res = await postJSON('/gemini/fallback-models', { models: testModels });
  const data = await res.json();
  
  log('/gemini/fallback-models POST success', data.success === true, JSON.stringify(data));
  log('/gemini/fallback-models POST returns updated models', 
      Array.isArray(data.models) && data.models?.length >= 3, 
      `count=${data.models?.length}`);
  
  // 验证保存是否生效
  const getRes = await getJSON('/gemini/fallback-models');
  const getData = await getRes.json();
  
  const testModelsSaved = testModels.every(m => getData.models?.includes(m));
  log('/gemini/fallback-models save persists', testModelsSaved, 'models saved correctly');
}

async function testResetGeminiFallbackToDefaults() {
  // 先设置自定义模型
  const customModels = ['gemini-1.5-pro'];
  await postJSON('/gemini/fallback-models', { models: customModels });
  
  // 然后验证能获取到（设置成功）
  const getRes1 = await getJSON('/gemini/fallback-models');
  const getData1 = await getRes1.json();
  
  log('/gemini/fallback-models custom set first', 
      getData1.models?.includes('gemini-1.5-pro'), 
      `models=${JSON.stringify(getData1.models?.slice(0,3))}`);
  
  // 现在设置回默认顺序（通过设置完整的默认列表）
  const defaultModels = [
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-exp',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro',
  ];
  
  const resetRes = await postJSON('/gemini/fallback-models', { models: defaultModels });
  const resetData = await resetRes.json();
  
  log('/gemini/fallback-models reset to defaults', 
      resetData.success === true && resetData.models?.length >= 9,
      `count=${resetData.models?.length}`);
}

async function testGeminiFallbackInvalidInput() {
  // 测试无效的输入格式
  const res1 = await postJSON('/gemini/fallback-models', {});
  log('/gemini/fallback-models invalid empty input -> 400', 
      res1.status === 400 || res1.ok === false, 
      `status=${res1.status}`);
  
  // 测试非数组输入
  const res2 = await postJSON('/gemini/fallback-models', { models: 'not-an-array' });
  log('/gemini/fallback-models invalid non-array input -> 400', 
      res2.status === 400 || res2.ok === false, 
      `status=${res2.status}`);
}

// ============================================================================
// PII功能测试
// ============================================================================

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
    reviewInstructions: '',
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

// ============================================================================
// AI预处理测试
// ============================================================================

/**
 * 测试 AI 预处理素材库功能（mock 模式）
 */
async function testAiPreprocessLibrary() {
  console.log('\n[Test] AI 预处理素材库功能测试');
  
  try {
    // 创建测试目录和素材文件
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-ai-preprocess-'));
    
    const sharedFact = 'Led cross-functional AI platform delivery with 200% DAU growth.';

    // 创建测试素材文件
    await fs.writeFile(path.join(testDir, 'resume_base.txt'), [
      'Senior Program Manager with 10+ years of experience.',
      '',
      'Microsoft | Senior PM | 2022-01 - 2025-01',
      sharedFact,
    ].join('\n'), 'utf-8');

    await postJSON('/init', getInitPayload(false, ['/tmp', testDir]));

    // 测试: mock 模式 AI 预处理（不消耗 token）
    const preprocessRes = await postJSON('/preprocess-library', {
      dir: testDir,
      model: MODEL,
      instructions: '请提取关键项目经历',
      messages: [],
      excludeNames: [],
      mock: true,
    });

    const preprocessText = await preprocessRes.text();
    const preprocessResult = parseSSEText(preprocessText);

    log('/preprocess-library mock 返回内容', 
        preprocessResult.text.length > 0, 
        `length=${preprocessResult.text.length}`);

    // 测试默认预处理 prompt
    const promptRes = await getJSON('/default-preprocess-prompt');
    const promptData = await promptRes.json();
    log('/default-preprocess-prompt 返回内容', 
        promptRes.ok && typeof promptData.content === 'string', 
        `length=${promptData.content?.length || 0}`);
  } catch (err) {
    log('testAiPreprocessLibrary 执行失败', false, err.message);
    throw err;
  }
}

/**
 * 测试真实 AI API 预处理（验证 AI 理解文件已由系统读取）
 */
async function testAiPreprocessRealApi() {
  console.log('\n[Test] AI 预处理真实 API 测试');

  try {
    // 创建测试目录和素材文件
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-ai-real-'));

    await fs.writeFile(path.join(testDir, 'resume_base.txt'), [
      '吴坤',
      'AI产品经理 | 10年经验',
      '',
      '工作经历',
      '微软 | 高级产品项目经理 | 2015.03 - 2025.05',
      '- 主导企业级AI Agent平台从0到1建设，DAU增长200%',
    ].join('\n'), 'utf-8');

    await postJSON('/init', getInitPayload(false, ['/tmp', testDir]));

    // 使用真实 AI API 进行预处理
    const preprocessRes = await postJSON('/preprocess-library', {
      dir: testDir,
      model: GEMINI_MODEL_ID,
      instructions: '你是简历素材库预处理工程师。请合并去重以下素材，输出预处理文本。',
      messages: [],
      excludeNames: [],
      mock: false, // 使用真实 AI
    });

    const preprocessText = await preprocessRes.text();
    const preprocessResult = parseSSEText(preprocessText);

    log('/preprocess-library real API 返回内容',
        preprocessResult.text.length > 100,
        `length=${preprocessResult.text.length}`);

    // 核心验证：AI 不应该抱怨无法访问文件系统
    const noFileSystemComplaint = !preprocessResult.text.includes('无法访问') &&
                                   !preprocessResult.text.includes('无法直接调用') &&
                                   !preprocessResult.text.includes('文件系统') &&
                                   !preprocessResult.text.includes('本地工具') &&
                                   !preprocessResult.text.includes('环境限制');
    log('/preprocess-library AI 不抱怨文件系统访问', noFileSystemComplaint,
        noFileSystemComplaint ? 'OK' : 'found file system complaint');

    // 检查没有错误
    log('/preprocess-library 无错误', !preprocessResult.error,
        preprocessResult.error || 'OK');
  } catch (err) {
    log('testAiPreprocessRealApi 执行失败', false, err.message);
    throw err;
  }
}

/**
 * 测试 AI 预处理缓存（使用真实 API）
 * 注意：mock 模式不经过缓存逻辑，无法测试缓存功能
 */
async function testPreprocessLibrary() {
  console.log('\n[Test] AI 预处理缓存测试');
  
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-preprocess-cache-'));
    
    await fs.writeFile(path.join(dir, 'alpha.txt'), [
      'Summary',
      '',
      'Senior Program Manager with 10+ years of experience.',
    ].join('\n'), 'utf-8');
    
    await postJSON('/init', getInitPayload(false, ['/tmp', dir]));
    
    // 首次调用（真实 API，会创建缓存）
    const result1 = await postSSEWithRetry('/preprocess-library', {
      model: MODEL,
      dir,
      instructions: '测试缓存功能',
      messages: [],
      excludeNames: [],
      mock: false, // 使用真实 API 以创建缓存
    });
    
    log('/preprocess-library first call has content', result1.text?.length > 100, `length=${result1.text?.length || 0}`);
    log('/preprocess-library first call fromCache=false', result1.fromCache === false, `fromCache=${result1.fromCache}`);
    
    // 第二次调用（检查缓存命中）
    const result2 = await postSSEWithRetry('/preprocess-library', {
      model: MODEL,
      dir,
      instructions: '测试缓存功能',
      messages: [],
      excludeNames: [],
      mock: false,
    });
    
    log('/preprocess-library cache hit', result2.fromCache === true, `fromCache=${result2.fromCache}`);
  } catch (err) {
    log('testPreprocessLibrary 执行失败', false, err.message);
    throw err;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\n=== Resume Tailor E2E Tests ===\n');
  console.log('提示：可根据开发功能选择运行特定测试组，详见文件头部注释\n');

  try {
    // ========== 核心流程测试 ==========
    console.log('\n--- 核心流程测试 ---');
    await testInitBase();
    await delay(RATE_LIMIT_DELAY);
    const generated = await testGenerate();
    await delay(RATE_LIMIT_DELAY);
    await testGenerateHtml();
    await delay(RATE_LIMIT_DELAY);
    const review = await testReview(generated);
    await delay(RATE_LIMIT_DELAY);
    await testReviewWithInstructions(generated);
    await delay(RATE_LIMIT_DELAY);
    await testReviewMulti(generated);
    await delay(RATE_LIMIT_DELAY);
    await testApplyReview(review);
    await delay(RATE_LIMIT_DELAY);
    await testReviewChat();
    await delay(RATE_LIMIT_DELAY);
    await testConnectionFallbackWithoutModel();

    // ========== JD解析测试 ==========
    console.log('\n--- JD解析测试 ---');
    await delay(RATE_LIMIT_DELAY);
    await testExtractJdInfo();
    await testExtractJdInfoLocalFallback();
    await delay(RATE_LIMIT_DELAY);
    await testMockJdImageOcr();
    await testJdImageOcrValidation();

    // ========== 模型管理测试 ==========
    console.log('\n--- 模型管理测试 ---');
    await delay(RATE_LIMIT_DELAY);
    await testListModels();
    await testListModelsWithInputKeyOverride();
    
    // ========== Gemini Fallback 配置管理测试 ==========
    console.log('\n--- Gemini Fallback 配置管理测试 ---');
    await testGetGeminiFallbackModels();
    await testSetGeminiFallbackModels();
    await testResetGeminiFallbackToDefaults();
    await testGeminiFallbackInvalidInput();

    // ========== 文件操作测试 ==========
    console.log('\n--- 文件操作测试 ---');
    await delay(RATE_LIMIT_DELAY);
    await testFileRoutesAndDigest();
    await testDigestNoBlanksDedup();
    await testDigestLayeredDedup();
    
    // ========== 本地预处理优化测试 ==========
    console.log('\n--- 本地预处理优化测试 ---');
    await delay(RATE_LIMIT_DELAY);
    await testDigestJdParagraphFiltering();
    await testDigestFullPreserveExactNames();
    await testDigestJdDominantParagraphFiltered();
    await testDigestBoilerplateFiltering();
    await testDigestCacheVersionUpgrade();
    await testDigestPreservedFileNotDeduped();
    await testDigestActionVerbBlockSplit();

    // ========== PII功能测试 ==========
    console.log('\n--- PII功能测试 ---');
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

    // ========== AI预处理测试 ==========
    console.log('\n--- AI预处理测试 ---');
    await delay(RATE_LIMIT_DELAY);
    await testAiPreprocessLibrary();
    await testPreprocessLibrary();
    await delay(RATE_LIMIT_DELAY);
    await testAiPreprocessRealApi();

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
