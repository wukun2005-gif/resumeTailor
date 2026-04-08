import { Router } from 'express';
import { initGemini, callGemini } from '../services/gemini.js';
import { initAnthropic, callAnthropic } from '../services/anthropic.js';
import { initOpenAICompat, callOpenAICompat } from '../services/openai-compat.js';
import { readFileContent, listResumeFiles } from '../services/fileReader.js';
import { getLibraryDigest, appendToDigestCache } from '../services/libraryCache.js';
import { getResumeGenerationPrompt, getReviewPrompt, getReviewPromptConcise, getReviewMergePrompt, getHtmlGenerationPrompt, getApplyReviewPrompt } from '../prompts/templates.js';
import { setPiiConfig, getPiiEntries, sanitizeRequestBody, sanitizeLibrary, sanitizeMessages, createStreamRestorer } from '../services/piiSanitizer.js';
import fs from 'fs/promises';
import path from 'path';

const router = Router();

/* ── Path security ── */
let allowedDirs = [];

function setAllowedDirs(dirs) {
  allowedDirs = dirs.map(d => path.resolve(d));
}

function validatePath(filePath) {
  const resolved = path.resolve(filePath);
  if (allowedDirs.length === 0) return resolved;
  const allowed = allowedDirs.some(d => resolved.startsWith(d + path.sep) || resolved === d);
  if (!allowed) throw new Error('路径访问被拒绝：不在允许的目录范围内');
  return resolved;
}

/* ── SSE helpers ── */
function setupSSE(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
}
function sendSSE(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

/* ── Model connection registry ── */
// Map of connectionId → { sdkType, label }
const connectionRegistry = new Map();

/**
 * Determine which SDK to use based on connection ID.
 * - google-studio-google → Google GenAI SDK
 * - jiekou-anthropic → Anthropic SDK
 * - everything else → OpenAI-compatible
 */
function getSdkType(connectionId) {
  if (connectionId === 'google-studio-google') return 'google';
  if (connectionId === 'jiekou-anthropic') return 'anthropic';
  return 'openai-compat';
}

function getModelCaller(connectionId) {
  // Backward compat: map old names
  if (connectionId === 'opus') connectionId = 'jiekou-anthropic';
  if (connectionId === 'gemini') connectionId = 'google-studio-google';

  const sdkType = getSdkType(connectionId);

  if (sdkType === 'google') {
    return (prompt, onChunk, opts) => callGemini(prompt, onChunk, opts);
  }
  if (sdkType === 'anthropic') {
    return (prompt, onChunk, opts) => callAnthropic(prompt, onChunk, opts);
  }
  // openai-compat
  return (prompt, onChunk, opts) => callOpenAICompat(connectionId, prompt, onChunk, opts);
}

function getConnectionLabel(connectionId) {
  const reg = connectionRegistry.get(connectionId);
  if (reg?.label) return reg.label;
  return connectionId;
}

const MOCK = {
  resume: '===== 简历正文 =====\n吴坤\n+86-135011-68055 | wukun2005@gmail.com\n============\n[仿真测试] 这是模拟生成的简历，用于测试工作流。\n\n个人简介\nAI平台产品经理...\n\n工作经历\n微软（中国）| 高级产品项目经理 | 2015.03 – 2025.05\n• 主导企业级Agent RAG...\n\n教育背景\n北京大学 | 计算机科学与技术 | 硕士',
  coverLetter: '\n\n===== 求职信正文 =====\n尊敬的招聘经理：\n\n[仿真测试] 这是模拟生成的求职信，用于测试工作流。\n\n我对贵司发布的产品经理职位深感兴趣。凭借在微软8年的企业级AI产品管理经验，我有信心能为团队带来显著价值。\n\n在微软期间，我主导了多个AI Agent平台的从0到1建设，积累了丰富的跨团队协作和产品战略规划经验。\n\n期待有机会进一步交流。\n\n此致\n吴坤',
  notes: '\n\n===== AI备注 =====\n[仿真测试] 以下事项需要您确认：\n1. 工作经历中的项目数据是否准确？\n2. 是否需要调整Summary的侧重方向？\n\n分析策略：根据JD重点突出了AI和产品管理经验。',
  review: '## 简历评审\n\n### 总体评分: 82/100\n\n### 优点\n- [仿真测试] 结构清晰\n- 和JD的匹配度适中\n\n### 需要修改的问题\n1. [仿真] Summary可以更精炼\n2. [仿真] 建议调整早期经历的篇幅\n\n### 与原始简历的事实不一致之处\n- 无（仿真模式）\n\n### 具体修改建议\n- [仿真测试模式 - 非真实评审]',
  reviewCoverLetter: '\n\n## 求职信评审\n\n### 评分: 78/100\n\n### 优点\n- [仿真] 开头有针对性\n- 篇幅适中\n\n### 需要修改的问题\n1. [仿真] 可以更具体地提及JD中的关键技能\n2. [仿真] 结尾的call-to-action可以更强\n\n### 具体修改建议\n- [仿真测试模式 - 非真实评审]',
  reviewMerge: '## 综合评审意见（合并两位评审员的结果）\n\n## 总体评分: 80/100\n\n## 共识优点\n- [仿真] 结构清晰，格式规范\n\n## 综合需改进项\n1. [仿真] Summary需更精炼\n2. [仿真] 早期经历篇幅需调整\n\n## 评审员分歧\n- 无（仿真模式）\n\n## 最终建议\n- [仿真测试模式 - 非真实评审]',
  reviewMergeCoverLetter: '\n\n## 求职信综合评审\n\n### 评分: 76/100\n\n### 共识优点\n- [仿真] 结构完整\n\n### 综合需改进项\n1. [仿真] 增加对JD关键技能的具体呼应\n\n### 最终建议\n- [仿真测试模式 - 非真实评审]',
  chat: '[仿真测试] 这是模拟回复。关闭仿真模式后将使用真实AI回复。',
  html: '<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:24px 40px;font-size:10.5pt;line-height:1.4;color:#222}h1{text-align:center;font-size:20pt}</style></head><body><h1>吴坤</h1><p>[仿真测试模式] HTML预览</p></body></html>',
  extractJdInfo: '{"company":"Amazon","department":"AGS","title":"Senior Product Manager","language":"en"}',
};

async function streamMock(res, text) {
  setupSSE(res);
  const chars = text.split('');
  for (const c of chars) {
    sendSSE(res, { type: 'chunk', text: c });
    await new Promise(r => setTimeout(r, 12));
  }
  sendSSE(res, { type: 'done' });
  res.end();
}

/* ── API routes ── */

router.post('/init', (req, res) => {
  const { modelConnections, allowedPaths, piiConfig } = req.body;

  // PII sanitization config
  if (piiConfig) setPiiConfig(piiConfig);

  // Backward compat: accept old format
  const { geminiKey, geminiModel, anthropicKey, anthropicBaseUrl } = req.body;

  const readyConnections = [];

  if (modelConnections && Array.isArray(modelConnections)) {
    for (const conn of modelConnections) {
      const { id, url, key, model } = conn;
      if (!id || !key) continue;

      const sdkType = getSdkType(id);
      if (sdkType === 'google') {
        initGemini(key, model);
      } else if (sdkType === 'anthropic') {
        initAnthropic(url, key, model);
      } else {
        initOpenAICompat(id, url, key, model);
      }

      connectionRegistry.set(id, { sdkType, label: conn.label || id });
      readyConnections.push(id);
    }
  } else {
    // Old format fallback
    if (geminiKey) {
      initGemini(geminiKey, geminiModel);
      connectionRegistry.set('google-studio-google', { sdkType: 'google', label: 'Google AI Studio' });
      readyConnections.push('google-studio-google');
    }
    if (anthropicKey) {
      initAnthropic(anthropicBaseUrl, anthropicKey);
      connectionRegistry.set('jiekou-anthropic', { sdkType: 'anthropic', label: 'Jiekou Anthropic' });
      readyConnections.push('jiekou-anthropic');
    }
  }

  if (allowedPaths && Array.isArray(allowedPaths)) {
    setAllowedDirs(allowedPaths);
  }

  res.json({ success: true, readyConnections });
});

router.get('/list-files', async (req, res) => {
  try {
    const dir = req.query.dir;
    if (!dir) return res.status(400).json({ error: '需要提供文件夹路径' });
    const validDir = validatePath(dir);
    await fs.access(validDir);
    const files = await listResumeFiles(validDir);
    res.json({ files });
  } catch (err) {
    res.status(err.message.includes('拒绝') ? 403 : 500).json({ error: err.code === 'ENOENT' ? '文件夹不存在' : err.message });
  }
});

router.get('/read-file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: '需要提供文件路径' });
    const validPath = validatePath(filePath);
    const content = await readFileContent(validPath);
    res.json({ content });
  } catch (err) {
    if (err.message === 'PAGES_NOT_SUPPORTED') {
      return res.status(400).json({ error: 'PAGES_NOT_SUPPORTED', message: '.pages文件无法直接解析，请手动复制粘贴内容' });
    }
    res.status(err.message.includes('拒绝') ? 403 : 500).json({ error: err.message });
  }
});

router.post('/save-file', async (req, res) => {
  try {
    const { filePath, content } = req.body;
    const validPath = validatePath(filePath);
    const dir = path.dirname(validPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(validPath, content, 'utf-8');
    // Incrementally update digest cache
    const fileName = path.basename(validPath);
    appendToDigestCache(dir, fileName, content).catch(() => {});
    res.json({ success: true, path: validPath });
  } catch (err) {
    res.status(err.message.includes('拒绝') ? 403 : 500).json({ error: err.message });
  }
});

router.post('/library-digest', async (req, res) => {
  try {
    const { dir, excludeNames } = req.body;
    if (!dir) return res.status(400).json({ error: '需要提供素材库路径' });
    const validDir = validatePath(dir);
    const { digest, fromCache } = await getLibraryDigest(validDir, excludeNames || []);
    res.json({ digest, fromCache, fileCount: digest.length });
  } catch (err) {
    res.status(err.message.includes('拒绝') ? 403 : 500).json({ error: err.message });
  }
});

router.post('/generate', async (req, res) => {
  if (req.body.mock) {
    let mockText = MOCK.resume;
    if (req.body.generateCoverLetter) mockText += MOCK.coverLetter;
    mockText += MOCK.notes;
    return streamMock(res, mockText);
  }
  setupSSE(res);
  try {
    const piiEntries = getPiiEntries();
    if (piiEntries.length > 0) {
      sanitizeRequestBody(req.body, ['jd', 'baseResume', 'instructions', 'previouslySubmitted'], piiEntries);
      sanitizeLibrary(req.body.resumeLibrary, piiEntries);
    }
    const { model, jd, baseResume, resumeLibrary, instructions, generateCoverLetter, previouslySubmitted, generateNotes } = req.body;
    const caller = getModelCaller(model);
    const { system, user, userBlocks } = getResumeGenerationPrompt({ jd, originalResume: baseResume, resumeLibrary, instructions, previouslySubmitted, generateCoverLetter, generateNotes });
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    await caller(user, onChunk, { system, maxTokens: 8192, userBlocks });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done' });
  } catch (err) {
    sendSSE(res, { type: 'error', message: err.message });
  }
  res.end();
});

router.post('/review', async (req, res) => {
  if (req.body.mock) {
    const hasCoverLetter = (req.body.updatedResume || '').includes('求职信');
    return streamMock(res, MOCK.review + (hasCoverLetter ? MOCK.reviewCoverLetter : ''));
  }
  setupSSE(res);
  try {
    const piiEntries = getPiiEntries();
    if (piiEntries.length > 0) {
      sanitizeRequestBody(req.body, ['jd', 'baseResume', 'updatedResume', 'instructions', 'previouslySubmitted'], piiEntries);
      sanitizeLibrary(req.body.resumeLibrary, piiEntries);
    }
    const { model, jd, baseResume, updatedResume, resumeLibrary, instructions, previouslySubmitted } = req.body;
    const caller = getModelCaller(model);
    const { system, user, userBlocks } = getReviewPrompt({ jd, originalResume: baseResume, updatedResume, resumeLibrary, instructions, previouslySubmitted });
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    await caller(user, onChunk, { system, maxTokens: 6144, userBlocks });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done' });
  } catch (err) {
    sendSSE(res, { type: 'error', message: err.message });
  }
  res.end();
});

// Multi-reviewer: run multiple models in parallel, then merge
router.post('/review-multi', async (req, res) => {
  if (req.body.mock) {
    const hasCoverLetter = (req.body.updatedResume || '').includes('求职信');
    return streamMock(res, MOCK.reviewMerge + (hasCoverLetter ? MOCK.reviewMergeCoverLetter : ''));
  }
  setupSSE(res);
  try {
    const piiEntries = getPiiEntries();
    if (piiEntries.length > 0) {
      sanitizeRequestBody(req.body, ['jd', 'baseResume', 'updatedResume', 'instructions', 'previouslySubmitted'], piiEntries);
      sanitizeLibrary(req.body.resumeLibrary, piiEntries);
    }
    const { models, orchestratorModel, jd, baseResume, updatedResume, resumeLibrary, instructions, previouslySubmitted } = req.body;
    const { system, user, userBlocks } = getReviewPromptConcise({ jd, originalResume: baseResume, updatedResume, resumeLibrary, instructions, previouslySubmitted });

    // Run all reviewers in parallel (concise format, no SSE streaming for individual results)
    sendSSE(res, { type: 'chunk', text: '正在并行调用多个评审模型...\n\n' });
    const results = await Promise.all(models.map(async (model) => {
      const caller = getModelCaller(model);
      const result = await caller(user, () => {}, { system, maxTokens: 3072, userBlocks });
      return { model, result };
    }));

    // Merge using orchestrator (with system message for Anthropic caching)
    sendSSE(res, { type: 'chunk', text: '--- 正在合并评审意见 ---\n\n' });
    const { system: mergeSystem, user: mergeUser } = getReviewMergePrompt(results.map(r => ({ model: r.model, label: getConnectionLabel(r.model), review: r.result })));
    const mergeCaller = getModelCaller(orchestratorModel);
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    await mergeCaller(mergeUser, onChunk, { system: mergeSystem, maxTokens: 4096 });
    if (restorer) restorer.end();

    sendSSE(res, { type: 'done' });
  } catch (err) {
    sendSSE(res, { type: 'error', message: err.message });
  }
  res.end();
});

// Apply review: diff mode — AI outputs structured edit instructions
router.post('/apply-review', async (req, res) => {
  if (req.body.mock) {
    return streamMock(res, '===== 修改列表 =====\n[REPLACE]\n<<<\n[仿真测试] 这是模拟生成的简历\n>>>\n[仿真测试] 这是根据Review修改后的简历\n[/REPLACE]');
  }
  setupSSE(res);
  try {
    const piiEntries = getPiiEntries();
    if (piiEntries.length > 0) {
      sanitizeRequestBody(req.body, ['currentResume', 'reviewComments', 'jd', 'previouslySubmitted'], piiEntries);
    }
    const { model, currentResume, reviewComments, jd, previouslySubmitted } = req.body;
    const caller = getModelCaller(model);
    const { system, user } = getApplyReviewPrompt({ currentResume, reviewComments, jd, previouslySubmitted });
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    await caller(user, onChunk, { system, maxTokens: 4096 });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done' });
  } catch (err) {
    sendSSE(res, { type: 'error', message: err.message });
  }
  res.end();
});

router.post('/chat', async (req, res) => {
  if (req.body.mock) return streamMock(res, MOCK.chat);
  setupSSE(res);
  try {
    const piiEntries = getPiiEntries();
    if (piiEntries.length > 0) {
      sanitizeMessages(req.body.messages, piiEntries);
    }
    const { model, messages, chatType } = req.body;
    const chatConfigs = {
      review:    { maxTokens: 4096, system: '你是简历评审助手。回答简明扼要，不超过3段。不要重新生成整份简历。' },
      generator: { maxTokens: 4096, system: '你是简历修改助手。如果需要修改简历，只输出修改后的完整简历并用===== 简历正文 =====标记。简短问答不需要标记。' },
      html:      { maxTokens: 8192, system: '你是HTML排版助手。如需修改HTML，输出完整HTML文档。仅回答问题时简短回复。' },
    };
    const config = chatConfigs[chatType] || { maxTokens: 8192 };
    const caller = getModelCaller(model);
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    await caller(null, onChunk, { messages, maxTokens: config.maxTokens, system: config.system });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done' });
  } catch (err) {
    sendSSE(res, { type: 'error', message: err.message });
  }
  res.end();
});

router.post('/generate-html', async (req, res) => {
  if (req.body.mock) return streamMock(res, MOCK.html);
  setupSSE(res);
  try {
    const piiEntries = getPiiEntries();
    if (piiEntries.length > 0) {
      sanitizeRequestBody(req.body, ['resumeText', 'htmlInstructions'], piiEntries);
    }
    const { model, resumeText, htmlInstructions, hyperlinks } = req.body;
    const caller = getModelCaller(model);
    const { system, user } = getHtmlGenerationPrompt({ resumeText, formatRequirements: htmlInstructions, hyperlinks });
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    await caller(user, onChunk, { system, maxTokens: 8192 });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done' });
  } catch (err) {
    sendSSE(res, { type: 'error', message: err.message });
  }
  res.end();
});

// Extract JD info (company, dept, title) for file naming
router.post('/extract-jd-info', async (req, res) => {
  if (req.body.mock) return res.json(JSON.parse(MOCK.extractJdInfo));
  try {
    const piiEntries = getPiiEntries();
    if (piiEntries.length > 0) {
      sanitizeRequestBody(req.body, ['jd'], piiEntries);
    }
    const { model, jd } = req.body;
    const caller = getModelCaller(model);
    const prompt = `从以下JD中提取公司名、部门名、职位名称、和JD语言。只输出JSON格式，不要输出任何其他内容：
{"company":"公司英文名","department":"部门英文名","title":"职位英文名","language":"en或zh"}
如果是中文JD，company/department/title也用中文。如果找不到某个字段就留空字符串""。

JD:
${jd}`;
    const result = await caller(prompt, () => {}, { maxTokens: 256, jsonMode: true });
    // Robust JSON extraction: strip code fences, then find first {...}
    let cleaned = result.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const info = JSON.parse(jsonMatch[0]);
    res.json(info);
  } catch (err) {
    res.json({ company: '', department: '', title: '', language: 'en' });
  }
});

export default router;
