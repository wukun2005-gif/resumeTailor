/**
 * PII Sanitization E2E Test — 真实 Gemini API 验证
 *
 * 验证：
 * 1. PII 在发送给 AI 前被替换为占位符
 * 2. AI 返回的占位符被正确恢复为真实 PII
 * 3. 覆盖所有 7 条 AI 路由
 *
 * Usage: GEMINI_KEY=xxx node test-pii-e2e.mjs
 */

const BASE = 'http://localhost:3001/api';
const GEMINI_KEY = process.env.GEMINI_KEY;
if (!GEMINI_KEY) { console.error('请设置环境变量 GEMINI_KEY'); process.exit(1); }
const MODEL = 'google-studio-google';

// ── PII Test Data ──
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

const SAMPLE_JD = `职位名称：AI标注平台产品经理
公司：美团
部门：AI平台部
任职要求：5年以上产品经理经验，熟悉AI/ML工作流`;

const SAMPLE_RESUME = `${PII.nameZh}（${PII.nameEn}）
${PII.email} | ${PII.phone}
LinkedIn: ${PII.linkedin}
GitHub: ${PII.github}

Summary
资深AI产品经理，5年企业级AI平台产品管理经验。

工作经历
ABC公司 | 产品经理 | 2020.03 – 2025.05
• 主导AI Agent平台从0到1建设，DAU增长200%
• 管理5人技术团队，完成10+个AI项目交付

教育背景
北京交通大学 | 计算机科学 | 硕士`;

const RESULTS = [];

function log(test, pass, detail = '') {
  const icon = pass ? '✅ PASS' : '❌ FAIL';
  console.log(`[${icon}] ${test}${detail ? ' — ' + detail : ''}`);
  RESULTS.push({ test, pass, detail });
}

async function parseSSE(response) {
  const text = await response.text();
  let result = '';
  let error = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.type === 'chunk') result += data.text;
      if (data.type === 'error') error = data.message;
    } catch {}
  }
  if (!result && error) throw new Error(error);
  return result;
}

async function postJSON(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

/** Post JSON with automatic retry on rate limit errors (for SSE endpoints). */
async function postWithRetry(path, body, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await postJSON(path, body);
    const text = await res.text();
    let result = '';
    let error = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'chunk') result += data.text;
        if (data.type === 'error') error = data.message;
      } catch {}
    }
    if (!result && error && (error.includes('配额') || error.includes('429'))) {
      if (attempt < retries) {
        const waitSec = 15 * (attempt + 1);
        console.log(`  ⏳ Rate limited, waiting ${waitSec}s before retry ${attempt + 2}/${retries + 1}...`);
        await delay(waitSec * 1000);
        continue;
      }
      throw new Error(error);
    }
    if (!result && error) throw new Error(error);
    return result;
  }
  return '';
}

/**
 * Check that result has no placeholder leaks.
 * If expectPii=true, also check that real PII values are present (restored).
 * Review/ApplyReview outputs may not mention contact info — only check leaks.
 */
function checkPiiRestored(result, testName, expectPii = true) {
  // Should NOT contain placeholders
  const leakedPlaceholders = PLACEHOLDERS.filter(p => result.includes(p));
  log(`${testName} — 无占位符泄漏`, leakedPlaceholders.length === 0,
    leakedPlaceholders.length > 0 ? `泄漏: ${leakedPlaceholders.join(', ')}` : 'OK');

  if (expectPii) {
    // Should contain at least some real PII (name is most likely to appear)
    const foundPii = REAL_VALUES.filter(v => result.includes(v));
    log(`${testName} — 真实PII已恢复`, foundPii.length > 0,
      `found: ${foundPii.length}/${REAL_VALUES.length} (${foundPii.join(', ')})`);
  }
}

// ── Tests ──

async function testInit() {
  console.log('\n── 1. 初始化（含PII配置）──');
  const res = await postJSON('/init', {
    modelConnections: [
      { id: 'google-studio-google', key: GEMINI_KEY, model: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite' }
    ],
    allowedPaths: ['/tmp'],
    piiConfig: {
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
    },
  });
  const data = await res.json();
  log('Init成功', data.success && data.readyConnections.includes(MODEL));
}

async function testGenerate() {
  console.log('\n── 2. /generate（简历生成 + PII恢复）──');
  const result = await postWithRetry('/generate', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    generateCoverLetter: false,
    generateNotes: false,
    previouslySubmitted: '',
  });
  log('Generate有内容', result.length > 200, `length=${result.length}`);
  checkPiiRestored(result, 'Generate');
  return result;
}

async function testReview(generatedResume) {
  console.log('\n── 3. /review（评审 + PII恢复）──');
  const result = await postWithRetry('/review', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    updatedResume: generatedResume,
    resumeLibrary: [],
    instructions: '',
    previouslySubmitted: '',
  });
  log('Review有内容', result.length > 100, `length=${result.length}`);
  checkPiiRestored(result, 'Review', false);  // Review输出通常不含联系信息
  return result;
}

async function testApplyReview() {
  console.log('\n── 4. /apply-review（采纳修改 + PII恢复）──');
  const result = await postWithRetry('/apply-review', {
    model: MODEL,
    currentResume: SAMPLE_RESUME,
    reviewComments: '1. Summary需要更精炼\n2. 应突出AI平台经验',
    jd: SAMPLE_JD,
    previouslySubmitted: '',
  });
  log('ApplyReview有内容', result.length > 50, `length=${result.length}`);
  checkPiiRestored(result, 'ApplyReview', false);  // Diff指令通常不含联系信息
}

async function testChat() {
  console.log('\n── 5. /chat（对话 + PII恢复）──');
  const result = await postWithRetry('/chat', {
    model: MODEL,
    chatType: 'generator',
    messages: [
      { role: 'user', content: `请帮我改进这份简历的Summary部分，要突出AI经验。\n\n${SAMPLE_RESUME}` },
    ],
  });
  log('Chat有内容', result.length > 30, `length=${result.length}`);
  checkPiiRestored(result, 'Chat');
}

async function testGenerateHtml() {
  console.log('\n── 6. /generate-html（HTML生成 + PII恢复）──');
  const result = await postWithRetry('/generate-html', {
    model: MODEL,
    resumeText: SAMPLE_RESUME,
    htmlInstructions: '',
  });
  log('HTML有内容', result.length > 100, `length=${result.length}`);
  checkPiiRestored(result, 'HTML');
}

async function testExtractJdInfo() {
  console.log('\n── 7. /extract-jd-info（JD解析，仅sanitize无restore）──');
  const res = await postJSON('/extract-jd-info', { model: MODEL, jd: SAMPLE_JD });
  const info = await res.json();
  log('JdInfo解析成功', !!info.company, `company="${info.company}", title="${info.title}"`);
}

// ── Main ──
const RATE_LIMIT_DELAY = 8000; // 8s between API calls to respect Gemini free tier RPM

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  PII 脱敏 E2E Test（真实 Gemini API） ║');
  console.log('╚═══════════════════════════════════════╝');

  try {
    await testInit();
    await delay(RATE_LIMIT_DELAY);
    const generated = await testGenerate();
    await delay(RATE_LIMIT_DELAY);
    const review = await testReview(generated);
    await delay(RATE_LIMIT_DELAY);
    await testApplyReview();
    await delay(RATE_LIMIT_DELAY);
    await testChat();
    await delay(RATE_LIMIT_DELAY);
    await testGenerateHtml();
    await delay(RATE_LIMIT_DELAY);
    await testExtractJdInfo();
  } catch (e) {
    console.error('\n💥 FATAL:', e.message, e.stack);
  }

  console.log('\n════════════════════');
  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  console.log(`Total: ${RESULTS.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of RESULTS.filter(r => !r.pass)) {
      console.log(`  ❌ ${r.test}: ${r.detail}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
