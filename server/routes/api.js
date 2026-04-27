import { Router } from 'express';
import { initGemini, callGemini, listGeminiModels, getFallbackModels, setFallbackModels } from '../services/gemini.js';
import { initAnthropic, callAnthropic } from '../services/anthropic.js';
import { initOpenAICompat, callOpenAICompat } from '../services/openai-compat.js';
import { readFileContent, listResumeFiles } from '../services/fileReader.js';
import { getLibraryDigest, appendToDigestCache, getAiPreprocessedLibrary, saveAiDigestCache, readRawLibraryFiles } from '../services/libraryCache.js';
import { getResumeGenerationPrompt, getReviewPrompt, getReviewPromptConcise, getReviewMergePrompt, getHtmlGenerationPrompt, getApplyReviewPrompt, getLibraryPreprocessPrompt } from '../prompts/templates.js';
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
// Map of connectionId → { sdkType, label, key, url, model }
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

function normalizeConnectionId(connectionId) {
  let resolvedId = connectionId;
  if (resolvedId === 'opus') resolvedId = 'jiekou-anthropic';
  if (resolvedId === 'gemini') resolvedId = 'google-studio-google';

  if (resolvedId && connectionRegistry.has(resolvedId)) {
    return resolvedId;
  }

  if (connectionRegistry.size === 1) {
    return [...connectionRegistry.keys()][0];
  }

  if (!resolvedId) {
    throw new Error('模型连接未配置，请先在“设置”中填写 API Key 并保存');
  }

  throw new Error(`模型连接 "${resolvedId}" 未初始化，请先在“设置”中保存有效 API Key`);
}

function getModelCaller(connectionId) {
  connectionId = normalizeConnectionId(connectionId);

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
  jdOcr: '岗位职责\n1. 参与美团小团Agent的产品功能优化和上线。\n2. 深入洞察用户需求与AI生成式能力。',
};

function detectJdLanguage(text) {
  const chinese = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
  const total = String(text).replace(/\s/g, '').length || 1;
  return chinese / total > 0.15 ? 'zh' : 'en';
}

function tryLocalJdParse(jdText) {
  const lang = detectJdLanguage(jdText);
  let company = '';
  let department = '';
  let title = '';

  const companyPatterns = [
    /(?:Company|公司)[:\s：]+([^\n,，]+)/i,
    /(?:About|关于)\s+([A-Z][\w&.\- ]+)/i,
    /(?:^|\n)([A-Z][\w&.\- ]{2,})\s+(?:is |are |was )/m,
  ];
  for (const pattern of companyPatterns) {
    const match = jdText.match(pattern);
    if (match) {
      company = match[1].trim();
      break;
    }
  }

  const titlePatterns = [
    /(?:Position|Title|Role|Job Title|职位|岗位)[:\s：]+([^\n,，]+)/i,
    /(?:^|\n)(?:Senior |Staff |Lead |Principal |Jr\.? |Junior )?(\w[\w\s/&]+(?:Manager|Engineer|Developer|Designer|Analyst|Architect|Scientist|Director|Coordinator|Specialist|Consultant|Administrator|Strategist|Producer|Writer|Editor))/im,
  ];
  for (const pattern of titlePatterns) {
    const match = jdText.match(pattern);
    if (match) {
      title = match[1].trim();
      break;
    }
  }

  const deptPatterns = [
    /(?:Department|Team|Division|Group|部门|团队)[:\s：]+([^\n,，]+)/i,
  ];
  for (const pattern of deptPatterns) {
    const match = jdText.match(pattern);
    if (match) {
      department = match[1].trim();
      break;
    }
  }

  if (!company || !title) return null;
  return { company, department, title, language: lang };
}

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

  // Reset registry on each init to avoid stale connections
  // affecting model fallback behavior.
  connectionRegistry.clear();

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

      connectionRegistry.set(id, { sdkType, label: conn.label || id, key, url, model });
      readyConnections.push(id);
    }
  } else {
    // Old format fallback
    if (geminiKey) {
      initGemini(geminiKey, geminiModel);
      connectionRegistry.set('google-studio-google', { sdkType: 'google', label: 'Google AI Studio', key: geminiKey, url: '', model: geminiModel });
      readyConnections.push('google-studio-google');
    }
    if (anthropicKey) {
      initAnthropic(anthropicBaseUrl, anthropicKey);
      connectionRegistry.set('jiekou-anthropic', { sdkType: 'anthropic', label: 'Jiekou Anthropic', key: anthropicKey, url: anthropicBaseUrl, model: '' });
      readyConnections.push('jiekou-anthropic');
    }
  }

  if (allowedPaths && Array.isArray(allowedPaths)) {
    setAllowedDirs(allowedPaths);
  }

  res.json({ success: true, readyConnections });
});

router.post('/list-models', async (req, res) => {
  try {
    const { connectionId, apiKey } = req.body;
    if (!connectionId) return res.status(400).json({ error: '需要提供 connectionId' });

    // Currently only supports google-studio-google
    if (connectionId !== 'google-studio-google') {
      return res.status(400).json({ error: '目前仅支持 google-studio-google' });
    }

    const conn = connectionRegistry.get(connectionId);
    const effectiveKey = String(apiKey || '').trim() || conn?.key;
    if (!effectiveKey) return res.status(400).json({ error: '连接未初始化，请先保存设置，或在当前输入框填写有效 API Key' });

    const models = await listGeminiModels(effectiveKey);
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const { digest, fromCache, sourceTokens, digestTokens } = await getLibraryDigest(validDir, excludeNames || []);
    res.json({ digest, fromCache, fileCount: digest.length, sourceTokens, digestTokens });
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
    const result = await caller(user, onChunk, { system, maxTokens: 8192, userBlocks });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done', usage: result.usage, model });
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
    const { model, jd, baseResume, updatedResume, resumeLibrary, instructions, reviewInstructions, previouslySubmitted } = req.body;
    const caller = getModelCaller(model);
    const { system, user, userBlocks } = getReviewPrompt({ jd, originalResume: baseResume, updatedResume, resumeLibrary, instructions, reviewInstructions, previouslySubmitted });
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    const result = await caller(user, onChunk, { system, maxTokens: 6144, userBlocks });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done', usage: result.usage, model });
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
    const { models, orchestratorModel, jd, baseResume, updatedResume, resumeLibrary, instructions, reviewInstructions, previouslySubmitted } = req.body;
    const { system, user, userBlocks } = getReviewPromptConcise({ jd, originalResume: baseResume, updatedResume, resumeLibrary, instructions, reviewInstructions, previouslySubmitted });

    // Run all reviewers in parallel (concise format, no SSE streaming for individual results)
    sendSSE(res, { type: 'chunk', text: '正在并行调用多个评审模型...\n\n' });
    const results = await Promise.all(models.map(async (model) => {
      const caller = getModelCaller(model);
      const result = await caller(user, () => {}, { system, maxTokens: 3072, userBlocks });
      return { model, text: result.text, usage: result.usage };
    }));

    // Merge using orchestrator (with system message for Anthropic caching)
    sendSSE(res, { type: 'chunk', text: '--- 正在合并评审意见 ---\n\n' });
    const { system: mergeSystem, user: mergeUser } = getReviewMergePrompt(results.map(r => ({ model: r.model, label: getConnectionLabel(r.model), review: r.text })));
    const mergeCaller = getModelCaller(orchestratorModel);
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    const mergeResult = await mergeCaller(mergeUser, onChunk, { system: mergeSystem, maxTokens: 4096 });
    if (restorer) restorer.end();

    sendSSE(res, { type: 'done', usage: mergeResult.usage, model: orchestratorModel });
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
      sanitizeRequestBody(req.body, ['currentResume', 'reviewComments', 'jd', 'previouslySubmitted', 'instructions'], piiEntries);
    }
    const { model, currentResume, reviewComments, jd, previouslySubmitted, instructions } = req.body;
    const caller = getModelCaller(model);
    const { system, user } = getApplyReviewPrompt({ currentResume, reviewComments, jd, previouslySubmitted, instructions });
    const restorer = piiEntries.length > 0 ? createStreamRestorer(piiEntries, text => sendSSE(res, { type: 'chunk', text })) : null;
    const onChunk = restorer ? chunk => restorer.push(chunk) : chunk => sendSSE(res, { type: 'chunk', text: chunk });
    const result = await caller(user, onChunk, { system, maxTokens: 4096 });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done', usage: result.usage, model });
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
    const result = await caller(null, onChunk, { messages, maxTokens: config.maxTokens, system: config.system });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done', usage: result.usage, model });
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
    const result = await caller(user, onChunk, { system, maxTokens: 8192 });
    if (restorer) restorer.end();
    sendSSE(res, { type: 'done', usage: result.usage, model });
  } catch (err) {
    sendSSE(res, { type: 'error', message: err.message });
  }
  res.end();
});

router.post('/ocr-jd-images', async (req, res) => {
  if (req.body.mock) return res.json({ text: MOCK.jdOcr, usage: { input: 0, output: 0 }, model: req.body.model || '' });
  try {
    const { model, images } = req.body;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: '需要提供至少一张 JD 图片' });
    }

    const caller = getModelCaller(model);
    const messages = [{
      role: 'user',
      content: [
        ...images.map(img => ({ type: 'file', mimeType: img.mimeType, data: img.data })),
        {
          type: 'text',
          text: `请按图片顺序读取这些招聘JD截图，输出一份干净的纯文本JD。

要求：
1. 保留职位名称、公司、部门、岗位职责、任职要求等关键信息
2. 按原顺序合并多张图片的内容
3. 修复明显的换行断裂和 OCR 断句问题
4. 不要总结，不要改写，不要补充图片里没有的信息
5. 只输出最终JD纯文本，不要Markdown，不要解释`,
        },
      ],
    }];

    const result = await caller(null, () => {}, { messages, maxTokens: 4096, temperature: 0.1 });
    res.json({ text: result.text.trim(), usage: result.usage, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const localInfo = tryLocalJdParse(jd);
    if (localInfo) {
      return res.json({ ...localInfo, usage: { input: 0, output: 0, local: true } });
    }
    const caller = getModelCaller(model);
    const prompt = `你的任务是从招聘JD中精确提取关键信息。

【必须输出的内容】
只输出一个JSON对象，包含以下字段，不要有任何其他文本：
{
  "company": "公司名称",
  "department": "部门名称（如果有）",
  "title": "职位名称",
  "language": "zh或en"
}

【提取规则】
1. company: 从JD中找公司名。如果是中文JD用中文，英文JD用英文
2. department: 部门或团队名。没有则留空
3. title: 职位标题。MUST FROM JD
4. language: zh表示中文JD，en表示英文JD
5. 任何找不到的字段都用空字符串""表示

【重要】只输出JSON，不要任何解释或额外文本。

我要处理的JD：
${jd}`;
    const result = await caller(prompt, () => {}, { maxTokens: 256, jsonMode: true });
    // Robust JSON extraction: strip code fences, then find first {...}
    let cleaned = result.text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const info = JSON.parse(jsonMatch[0]);
    res.json({ ...info, usage: result.usage });
  } catch (err) {
    res.json({ company: '', department: '', title: '', language: 'en' });
  }
});

// ============================================================================
// AI Preprocessing Routes
// ============================================================================

// Hardcoded path for default preprocess prompt
const DEFAULT_PREPROCESS_PROMPT_PATH = '/Users/wukun/Documents/jl/预处理-prompt.md';

/**
 * GET /api/default-preprocess-prompt
 * Returns the default preprocessing prompt from hardcoded path.
 */
router.get('/default-preprocess-prompt', async (req, res) => {
  try {
    const content = await fs.readFile(DEFAULT_PREPROCESS_PROMPT_PATH, 'utf-8');
    res.json({ content });
  } catch (err) {
    // Return a basic default if file not found
    res.json({ 
      content: `你是一位简历素材库预处理工程师。请处理以下素材库文件，按照以下原则：

1. 严格不推断 — 不从 A+B 合成 C；不补全未出现的数字/Title/技术名/年份
2. 不改写原文措辞 — 保留中英文、缩写、大小写、标点原样
3. 保守 lossless 压缩 — 重复段落相似度 ≥ 0.82 才能删除
4. 完整 provenance — 每条事实标注来源文件名
5. 冲突不融合 — 同一事实不同说法时，两版都保留并标记 ⚠ [冲突]

输出格式：
===== 预处理文本开始 =====
[预处理内容]
===== 预处理文本结束 =====` 
    });
  }
});

// Mock preprocessing output for testing
const MOCK_PREPROCESS = `===== 预处理文本开始 =====
╔════════════════════════════════════════════════════════════════╗
║ 简历素材预处理纯文本文件
║ Generated: 2026-04-23 20:40
║ Source files: 3 份
║ Source tokens: ~15,000
║ Output tokens: ~8,000
╚════════════════════════════════════════════════════════════════╝

# §1. 基础事实简历（完整原文保留）

## §1.1 resume_base.txt
吴坤
AI平台产品经理

工作经历：
微软（中国）| 高级产品项目经理 | 2015.03 – 2025.05
• 主导企业级Agent RAG平台从0到1建设...

# §10. 自检报告
- [x] 源文件扫描总数：3
- [x] 无任何字段是本 AI 推理/合成出来的 ✓

===== 预处理文本结束 =====`;

/**
 * POST /api/preprocess-library
 * AI preprocessing of resume library.
 * 
 * Request body:
 * - dir: library directory path
 * - model: model connection ID
 * - instructions: user's preprocessing instructions
 * - messages: chat messages for multi-turn conversation
 * - excludeNames: file names to exclude
 * - mock: if true, return mock response
 * 
 * Response: SSE stream
 * - type: 'chunk' | 'system' | 'done' | 'error'
 * - For 'done': includes sourceTokens, digestTokens, exportText, fromCache, fallbackUsed
 */
router.post('/preprocess-library', async (req, res) => {
  const { dir, model, instructions, messages, excludeNames, mock } = req.body;
  
  if (!dir) {
    return res.status(400).json({ error: '需要提供素材库路径' });
  }

  try {
    const validDir = validatePath(dir);
    
    // Get PII entries for sanitization
    const piiEntries = getPiiEntries();
    const piiEnabled = piiEntries.length > 0;

    // Check AI cache first (with piiEnabled for cache validation)
    const cached = await getAiPreprocessedLibrary(validDir, instructions, model, piiEnabled);
    if (cached) {
      setupSSE(res);
      // Restore PII in cached export text before sending to user
      let restoredExportText = cached.exportText;
      if (piiEntries.length > 0) {
        const { restore } = await import('../services/piiSanitizer.js');
        restoredExportText = restore(restoredExportText, piiEntries);
      }
      sendSSE(res, { 
        type: 'system', 
        message: `✓ 命中AI预处理缓存\n  - 源文件 tokens: ${cached.sourceTokens.toLocaleString()}\n  - 预处理后 tokens: ${cached.digestTokens.toLocaleString()}\n  - 压缩比: ${cached.sourceTokens > 0 ? Math.round((1 - cached.digestTokens / cached.sourceTokens) * 100) : 0}%` 
      });
      sendSSE(res, { 
        type: 'done', 
        sourceTokens: cached.sourceTokens, 
        digestTokens: cached.digestTokens, 
        exportText: restoredExportText,
        fromCache: true,
        fallbackUsed: false
      });
      return res.end();
    }

    // Mock mode
    if (mock) {
      setupSSE(res);
      sendSSE(res, { type: 'system', message: `[仿真模式] 源文件 tokens: 15,000\n[仿真模式] 预处理后 tokens: 8,000` });
      // Stream mock preprocess output
      const chars = MOCK_PREPROCESS.split('');
      for (const c of chars) {
        sendSSE(res, { type: 'chunk', text: c });
        await new Promise(r => setTimeout(r, 5));
      }
      sendSSE(res, { 
        type: 'done', 
        sourceTokens: 15000, 
        digestTokens: 8000, 
        exportText: MOCK_PREPROCESS,
        fromCache: false,
        fallbackUsed: false
      });
      return res.end();
    }

    // Read raw library files
    const { files, sourceTokens } = await readRawLibraryFiles(validDir, excludeNames || []);
    
    if (files.length === 0) {
      return res.status(400).json({ error: '素材库中没有可处理的文件' });
    }

    // Sanitize PII in library files before sending to AI
    if (piiEntries.length > 0) {
      sanitizeLibrary(files, piiEntries);
    }

    // Sanitize PII in instructions before sending to AI
    let sanitizedInstructions = instructions;
    if (piiEntries.length > 0 && instructions) {
      const sanitized = { instructions };
      sanitizeRequestBody(sanitized, ['instructions'], piiEntries);
      sanitizedInstructions = sanitized.instructions;
    }

    setupSSE(res);
    sendSSE(res, { type: 'system', message: `读取到 ${files.length} 个文件，源文件 tokens: ${sourceTokens.toLocaleString()}` });

    // Build prompt (with sanitized instructions)
    const { system, user } = getLibraryPreprocessPrompt(files, sanitizedInstructions);
    const caller = getModelCaller(model);

    // Build messages array for multi-turn conversation
    let chatMessages = null;
    if (messages && messages.length > 0) {
      chatMessages = messages;
      // Sanitize PII in chat messages
      if (piiEntries.length > 0) {
        sanitizeMessages(chatMessages, piiEntries);
      }
    }

    let rawText = ''; // Raw AI output (with placeholders if PII enabled)
    let restoredText = ''; // Restored text (with real PII)
    
    // Use stream restorer to restore PII in AI output
    const restorer = piiEntries.length > 0 
      ? createStreamRestorer(piiEntries, text => { 
          restoredText += text;
          sendSSE(res, { type: 'chunk', text }); 
        }) 
      : null;
    const onChunk = restorer 
      ? chunk => { rawText += chunk; restorer.push(chunk); }
      : chunk => { restoredText += chunk; sendSSE(res, { type: 'chunk', text: chunk }); };

    try {
      const result = await caller(
        chatMessages ? null : user, 
        onChunk, 
        { 
          system, 
          messages: chatMessages, 
          maxTokens: 16384 
        }
      );

      // End the restorer to flush any remaining content
      if (restorer) restorer.end();

      // Calculate digest tokens from restored text
      const digestTokens = restoredText.length; // Simplified estimation

      // Extract export text from delimited output
      let exportText = restoredText;
      const startMarker = '===== 预处理文本开始 =====';
      const endMarker = '===== 预处理文本结束 =====';
      const startIdx = restoredText.indexOf(startMarker);
      const endIdx = restoredText.indexOf(endMarker);
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        exportText = restoredText.slice(startIdx + startMarker.length, endIdx).trim();
      }

      // Save to AI cache (with PII restored, as cache is for user consumption)
      await saveAiDigestCache(validDir, exportText, sourceTokens, digestTokens, instructions, model, piiEnabled);

      sendSSE(res, { 
        type: 'done', 
        sourceTokens, 
        digestTokens, 
        exportText,
        fromCache: false,
        fallbackUsed: false,
        usage: result.usage,
        model
      });

    } catch (aiErr) {
      // AI failed, fallback to local preprocessing

      // Provide more helpful error message
      let errorMessage = aiErr.message;
      if (sourceTokens > 1000000) {
        errorMessage += ` (素材库 ${sourceTokens.toLocaleString()} tokens 可能超出模型限制，建议使用 Gemini 2.5 Pro 或分批处理)`;
      } else if (sourceTokens > 500000) {
        errorMessage += ` (素材库 ${sourceTokens.toLocaleString()} tokens 较大，建议使用 Gemini 2.5 Flash/Pro)`;
      }
      
      sendSSE(res, { type: 'system', message: `⚠ AI预处理失败，回退到本地预处理: ${errorMessage}` });
      
      const { digest, sourceTokens: localSourceTokens, digestTokens: localDigestTokens } = await getLibraryDigest(validDir, excludeNames || []);
      
      // Build export text from local digest
      let localExportText = `════════════════════════════════════════════════════════════════\n简历素材预处理纯文本文件（本地预处理）\nGenerated: ${new Date().toISOString()}\nSource files: ${digest.length} 份\nSource tokens: ~${localSourceTokens}\nOutput tokens: ~${localDigestTokens}\n════════════════════════════════════════════════════════════════\n\n`;
      
      for (const item of digest) {
        localExportText += `--- ${item.name} ---\n${item.content}\n\n`;
      }

      sendSSE(res, { 
        type: 'done', 
        sourceTokens: localSourceTokens, 
        digestTokens: localDigestTokens, 
        exportText: localExportText,
        fromCache: false,
        fallbackUsed: true
      });
    }

  } catch (err) {
    if (!res.headersSent) {
      res.status(err.message.includes('拒绝') ? 403 : 500).json({ error: err.message });
    } else {
      sendSSE(res, { type: 'error', message: err.message });
    }
  }
  res.end();
});

// ============================================================================
// Gemini Fallback Models Routes
// ============================================================================

/**
 * GET /api/gemini/fallback-models
 * Returns the current fallback model list.
 */
router.get('/gemini/fallback-models', (req, res) => {
  try {
    const models = getFallbackModels();
    res.json({ success: true, models });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/gemini/fallback-models
 * Updates the fallback model list and saves to config.
 * Request body: { models: string[] }
 */
router.post('/gemini/fallback-models', (req, res) => {
  try {
    const { models } = req.body;
    if (!models || !Array.isArray(models)) {
      return res.status(400).json({ 
        success: false, 
        error: '需要提供模型列表数组' 
      });
    }

    const updatedModels = setFallbackModels(models);
    res.json({ 
      success: true, 
      models: updatedModels, 
      message: `已保存 ${updatedModels.length} 个 fallback 模型` 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
