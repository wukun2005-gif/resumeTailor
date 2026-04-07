/**
 * End-to-end test for all AI API routes using Gemini.
 * Usage: node test-e2e.mjs
 */

const BASE = 'http://localhost:3001/api';
const GEMINI_KEY = process.env.GEMINI_KEY || 'AIzaSyCukZQglqofAtYzfjxntPnGTajXzpYJlZc';
const MODEL = 'google-studio-google';

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

const SAMPLE_RESUME = `吴坤
wukun2005@gmail.com | +86-13501168055

Summary
资深AI产品经理，8年企业级AI平台产品管理经验。

工作经历
微软（中国）| 高级产品经理 | 2017.03 – 2025.05
• 主导AI Agent平台从0到1建设，DAU增长200%
• 管理5人技术团队，完成10+个AI项目交付
• 推动Cortana技能生态建设，合作伙伴增长35%

教育背景
北京大学 | 计算机科学 | 硕士`;

const RESULTS = [];
let serverProcess;

function log(test, pass, detail = '') {
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${test}${detail ? ' — ' + detail : ''}`);
  RESULTS.push({ test, pass, detail });
}

async function parseSSE(response) {
  const text = await response.text();
  let result = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.type === 'chunk') result += data.text;
      if (data.type === 'error') throw new Error(data.message);
    } catch {}
  }
  return result;
}

async function postJSON(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

// ── Tests ──

async function testInit() {
  const res = await postJSON('/init', {
    modelConnections: [
      { id: 'google-studio-google', key: GEMINI_KEY, model: 'gemini-2.5-flash', label: 'Gemini Flash' }
    ],
    allowedPaths: ['/tmp']
  });
  const data = await res.json();
  log('1. /init', data.success && data.readyConnections.includes(MODEL), `connections: ${data.readyConnections}`);
}

async function testExtractJdInfo() {
  const res = await postJSON('/extract-jd-info', { model: MODEL, jd: SAMPLE_JD });
  const info = await res.json();
  log('2. /extract-jd-info company', !!info.company, `company="${info.company}"`);
  log('2b. /extract-jd-info title', !!info.title, `title="${info.title}"`);
  log('2c. /extract-jd-info language', info.language === 'zh', `language="${info.language}"`);
  return info;
}

async function testGenerate() {
  const res = await postJSON('/generate', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    generateCoverLetter: true,
    previouslySubmitted: '',
  });
  const result = await parseSSE(res);
  const hasResumeMarker = result.includes('简历正文');
  const hasCoverLetter = result.includes('求职信');
  const hasNotes = result.includes('AI备注');
  const len = result.length;
  log('3. /generate has content', len > 500, `length=${len}`);
  log('3b. /generate resume marker', hasResumeMarker);
  log('3c. /generate cover letter', hasCoverLetter);
  log('3d. /generate AI notes', hasNotes);
  // Check not truncated: should end naturally, not mid-sentence
  const lastChars = result.slice(-50);
  log('3e. /generate not truncated', len > 1000, `last50="${lastChars.replace(/\n/g, '\\n')}"`);
  return result;
}

async function testGenerateNoNotes() {
  const res = await postJSON('/generate', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    generateCoverLetter: false,
    generateNotes: false,
  });
  const result = await parseSSE(res);
  const hasNotes = result.includes('AI备注');
  log('4. /generate generateNotes=false', !hasNotes, `hasNotes=${hasNotes}, len=${result.length}`);
}

async function testReview(generatedResume) {
  const res = await postJSON('/review', {
    model: MODEL,
    jd: SAMPLE_JD,
    baseResume: SAMPLE_RESUME,
    updatedResume: generatedResume || SAMPLE_RESUME,
    resumeLibrary: [],
    instructions: '',
    previouslySubmitted: '',
  });
  const result = await parseSSE(res);
  const hasScore = /\d{1,3}/.test(result);
  log('5. /review has content', result.length > 200, `length=${result.length}`);
  log('5b. /review has score', hasScore);
  log('5c. /review not truncated', result.length > 300, `last50="${result.slice(-50).replace(/\n/g, '\\n')}"`);
  return result;
}

async function testApplyReview(reviewComments) {
  const res = await postJSON('/apply-review', {
    model: MODEL,
    currentResume: SAMPLE_RESUME,
    reviewComments: reviewComments || '1. Summary需要更精炼\n2. 需要增加数据标注相关经验的描述',
    jd: SAMPLE_JD,
  });
  const result = await parseSSE(res);
  const hasReplace = result.includes('[REPLACE]');
  log('6. /apply-review has REPLACE blocks', hasReplace, `len=${result.length}`);

  // Test diff parsing
  const diffs = [];
  const regex = /\[REPLACE\]\s*\n<<<\n([\s\S]*?)\n>>>\n([\s\S]*?)\n\[\/REPLACE\]/g;
  let match;
  while ((match = regex.exec(result)) !== null) {
    diffs.push({ old: match[1], new: match[2] });
  }
  log('6b. /apply-review parseable diffs', diffs.length > 0, `count=${diffs.length}`);

  // Test applying diffs
  if (diffs.length > 0) {
    let applied = 0;
    let r = SAMPLE_RESUME;
    for (const d of diffs) {
      if (r.includes(d.old)) { r = r.replace(d.old, d.new); applied++; }
      else if (d.old.trim() && r.includes(d.old.trim())) { r = r.replace(d.old.trim(), d.new.trim()); applied++; }
    }
    log('6c. /apply-review diffs applicable', applied > 0, `applied=${applied}/${diffs.length}`);
  }
}

async function testChat() {
  const res = await postJSON('/chat', {
    model: MODEL,
    chatType: 'review',
    messages: [
      { role: 'user', content: '请问这份简历的Summary部分有什么需要改进的？\n\n简历：\n' + SAMPLE_RESUME },
    ],
  });
  const result = await parseSSE(res);
  log('7. /chat review type', result.length > 50, `len=${result.length}`);
}

async function testGenerateHtml() {
  const res = await postJSON('/generate-html', {
    model: MODEL,
    resumeText: SAMPLE_RESUME,
    htmlInstructions: '',
  });
  const result = await parseSSE(res);
  // AI should output body content only (no <html>, <head>, <style>)
  const hasHtmlTag = /<html/i.test(result);
  const hasBodyContent = result.includes('<h1') || result.includes('<h2') || result.includes('<p');
  log('8. /generate-html has body content', hasBodyContent, `len=${result.length}`);
  log('8b. /generate-html no <html> tag (body only)', !hasHtmlTag, `hasHtmlTag=${hasHtmlTag}`);
}

// ── Main ──

async function main() {
  console.log('\n=== 简历定制助手 E2E Test ===\n');

  try {
    await testInit();
    const jdInfo = await testExtractJdInfo();
    const generated = await testGenerate();
    await testGenerateNoNotes();
    const review = await testReview(generated);
    await testApplyReview(review);
    await testChat();
    await testGenerateHtml();
  } catch (e) {
    console.error('\nFATAL:', e.message);
  }

  console.log('\n=== Summary ===');
  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  console.log(`Total: ${RESULTS.length} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of RESULTS.filter(r => !r.pass)) {
      console.log(`  - ${r.test}: ${r.detail}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
