import * as state from './state.js';
import * as api from './api.js';
import { createWorker } from 'tesseract.js';

/* ── Chat history utilities ── */
const CHAT_WINDOW_SIZE = 5; // keep seed (2 msgs) + last N rounds (2N msgs)

/* ── HTML CSS Template (pre-built, AI only outputs <body> content) ── */
const HTML_CSS_TEMPLATE = `@page { size: A4; margin: 15mm 18mm; }
body { font-family: Arial, Helvetica, 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 10.5pt; line-height: 1.35; color: #333; margin: 0; padding: 0; }
h1 { font-size: 16pt; margin: 0 0 4pt; }
h2 { font-size: 11pt; margin: 10pt 0 3pt; border-bottom: 1px solid #ccc; padding-bottom: 2pt; }
h3 { font-size: 10.5pt; margin: 6pt 0 2pt; }
p, li { margin: 1pt 0; }
ul { margin: 2pt 0; padding-left: 18pt; }
a { color: #0066cc; text-decoration: none; }
.contact-info { text-align: center; margin-bottom: 6pt; }
@media print { body { margin: 0; } }`;

/**
 * Sliding window: keep seed messages (first 2) + last N rounds of conversation.
 * Also strips base64 data from older messages to prevent token accumulation.
 */
function truncateHistory(messages) {
  const seedCount = 2;
  const keepTailCount = CHAT_WINDOW_SIZE * 2; // each round = user + assistant
  if (messages.length <= seedCount + keepTailCount) {
    return cleanBase64InHistory(messages);
  }
  const seed = messages.slice(0, seedCount);
  const tail = messages.slice(-keepTailCount);
  return cleanBase64InHistory([...seed, ...tail]);
}

/**
 * Replace base64 data in non-last messages with a placeholder to save tokens.
 */
function cleanBase64InHistory(messages) {
  return messages.map((m, i) => {
    if (i >= messages.length - 2) return m; // keep last round intact
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map(part =>
        part.type === 'file'
          ? { type: 'text', text: `[之前上传的${part.mimeType?.includes('pdf') ? 'PDF' : '图片'}文件]` }
          : part
      ),
    };
  });
}

/* ── DOM refs ── */
const $ = id => document.getElementById(id);

const els = {
  mockMode: $('mockMode'),
  settingsBtn: $('settingsBtn'), settingsModal: $('settingsModal'), settingsClose: $('settingsClose'), settingsSave: $('settingsSave'), settingsStatus: $('settingsStatus'),
  // Agent assignment dropdowns
  cfgAgentOrchestrator: $('cfgAgentOrchestrator'), cfgAgentGenerator: $('cfgAgentGenerator'),
  cfgAgentReviewers: $('cfgAgentReviewers'), cfgAgentHtml: $('cfgAgentHtml'),
  jdInput: $('jdInput'), libraryPath: $('libraryPath'), browseLibraryBtn: $('browseLibraryBtn'), loadLibraryBtn: $('loadLibraryBtn'), exportDigestBtn: $('exportDigestBtn'), exportDigestStatus: $('exportDigestStatus'), baseResumeSelect: $('baseResumeSelect'),
  jdImageUpload: $('jdImageUpload'), jdImageUseAi: $('jdImageUseAi'), jdImageStatus: $('jdImageStatus'), jdImageAiRetryBtn: $('jdImageAiRetryBtn'), jdImageQualityHint: $('jdImageQualityHint'),
  manualResumeRow: $('manualResumeRow'), manualResumeInput: $('manualResumeInput'),
  genInstructions: $('genInstructions'), reviewInstructions: $('reviewInstructions'), htmlInstructions: $('htmlInstructions'), generateCoverLetter: $('generateCoverLetter'),
  generateBtn: $('generateBtn'), outputSection: $('outputSection'),
   resumeOutput: $('resumeOutput'), resumeStatusAndToken: $('resumeStatusAndToken'),
  saveResumeBtn: $('saveResumeBtn'), regenerateBtn: $('regenerateBtn'),
  saveFilenameRow: $('saveFilenameRow'), saveFilename: $('saveFilename'), confirmSaveBtn: $('confirmSaveBtn'), cancelSaveBtn: $('cancelSaveBtn'),
   reviewBtn: $('reviewBtn'), reviewOutput: $('reviewOutput'), reviewStatusAndToken: $('reviewStatusAndToken'),
  applyReviewBtn: $('applyReviewBtn'),
  chatHistory: $('chatHistory'), chatInput: $('chatInput'), chatSendBtn: $('chatSendBtn'),
  genNotesSection: $('genNotesSection'), genNotesOutput: $('genNotesOutput'),
  genChatSection: $('genChatSection'), genChatHistory: $('genChatHistory'), genChatInput: $('genChatInput'), genChatSendBtn: $('genChatSendBtn'),
  generateHtmlBtn: $('generateHtmlBtn'), htmlStatus: $('htmlStatus'),
  htmlChatSection: $('htmlChatSection'), htmlChatHistory: $('htmlChatHistory'), htmlChatInput: $('htmlChatInput'), htmlChatSendBtn: $('htmlChatSendBtn'),
  htmlPdfUpload: $('htmlPdfUpload'), htmlUploadStatus: $('htmlUploadStatus'), htmlTokenInfo: $('htmlTokenInfo'),
  openPdfBtn: $('openPdfBtn'), openPdfFileInput: $('openPdfFileInput'),
  sessionTotalInfo: $('sessionTotalInfo'),
  // PII config
  cfgPiiEnabled: $('cfgPiiEnabled'),
  cfgPiiNameEn: $('cfgPiiNameEn'), cfgPiiNameZh: $('cfgPiiNameZh'), cfgPiiNameVariants: $('cfgPiiNameVariants'),
  cfgPiiEmail: $('cfgPiiEmail'), cfgPiiPhone: $('cfgPiiPhone'),
  cfgPiiLinkedin: $('cfgPiiLinkedin'), cfgPiiGithub: $('cfgPiiGithub'),
  cfgPiiWebsite: $('cfgPiiWebsite'), cfgPiiOther: $('cfgPiiOther'),
};

let libraryFiles = [];
let baseResumeContent = '';
let resumeLibraryContents = [];
let chatMessages = [];
let isStreaming = false;
let jdInfo = null; // cached JD extraction result
let genChatMessages = []; // Generator chat context
let htmlChatMessages = []; // HTML chat context
let lastHtmlContent = ''; // Last generated HTML for chat context
let uploadedFileData = null; // { mimeType, data } for PDF/image upload
let baseResumeCache = new Map(); // key=filename, value={content, modified}
let jdImageLastBatch = null;
let jdOcrWorkerPromise = null;

/* ── Session Token & Cost Tracking ── */
let sessionUsage = { totalInput: 0, totalOutput: 0, totalCost: 0 };
const PRICING = {
  'google-studio-google': { input: 0, output: 0, note: '免费额度' },
  'jiekou-anthropic': { input: 15 / 1000000, output: 75 / 1000000, note: 'Anthropic' },
  'jiekou-openai': { input: 2.5 / 1000000, output: 10 / 1000000, note: 'OpenAI' },
  'jiekou-google': { input: 0.075 / 1000000, output: 0.3 / 1000000, note: 'Google' },
};

function getNormalizedJdText(raw = els.jdInput.value) {
  return String(raw)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function evaluateJdOcrQuality(text) {
  const normalized = normalizeOcrText(text);
  const compact = normalized.replace(/\s/g, '');
  const keywordHits = ['岗位', '职位', '职责', '要求', '任职', '工作内容', '岗位职责', 'Job', 'Responsibilities', 'Requirements']
    .filter(keyword => normalized.includes(keyword)).length;
  const suspiciousChars = (normalized.match(/[|_~`]/g) || []).length;
  const lineCount = normalized.split('\n').filter(Boolean).length;
  const score = compact.length + keywordHits * 80 - suspiciousChars * 10 + lineCount * 5;
  const weak = compact.length < 80 || keywordHits === 0 || suspiciousChars > 12;

  return {
    weak,
    score,
    compactLength: compact.length,
    keywordHits,
  };
}

function setJdImageStatus(text, type = '') {
  if (!els.jdImageStatus) return;
  els.jdImageStatus.textContent = text;
  els.jdImageStatus.className = type ? `status-text ${type}` : 'status-text';
}

function setJdImageQualityHint(text = '', type = 'warning') {
  if (!els.jdImageQualityHint) return;
  if (!text) {
    els.jdImageQualityHint.style.display = 'none';
    els.jdImageQualityHint.textContent = '';
    return;
  }
  els.jdImageQualityHint.textContent = text;
  els.jdImageQualityHint.style.display = '';
  els.jdImageQualityHint.className = type === 'error' ? 'jd-quality-hint status-text error' : 'jd-quality-hint';
}

function appendJdText(text) {
  const normalized = normalizeOcrText(text);
  if (!normalized) return;
  const current = getNormalizedJdText();
  els.jdInput.value = current ? `${current}\n\n${normalized}` : normalized;
}

function replaceLastAppendedJdText(previousText, nextText) {
  const previous = normalizeOcrText(previousText);
  const next = normalizeOcrText(nextText);
  const current = els.jdInput.value;
  if (!previous) {
    appendJdText(next);
    return false;
  }

  const index = current.lastIndexOf(previous);
  if (index === -1) {
    appendJdText(next);
    return false;
  }

  els.jdInput.value = `${current.slice(0, index)}${next}${current.slice(index + previous.length)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return true;
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function fileToBase64Payload(file) {
  const dataUrl = await fileToDataUrl(file);
  return {
    name: file.name,
    mimeType: file.type || 'image/jpeg',
    data: String(dataUrl).split(',')[1],
  };
}

async function loadImageFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`无法读取图片: ${file.name}`));
      el.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function preprocessJdImage(file) {
  const img = await loadImageFromFile(file);
  const maxDim = 2200;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    total += gray;
  }
  const threshold = Math.max(135, Math.min(205, total / (data.length / 4) + 10));

  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const contrasted = gray > threshold ? 255 : 0;
    data[i] = contrasted;
    data[i + 1] = contrasted;
    data[i + 2] = contrasted;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function getJdOcrWorker(logger) {
  if (!jdOcrWorkerPromise) {
    jdOcrWorkerPromise = createWorker('chi_sim+eng', 1, {
      logger,
    });
  }
  return jdOcrWorkerPromise;
}

function persistDraftState() {}

function clearWorkspaceState() {
  state.set('draftState', null);
  state.set('baseResume', '');

  els.jdInput.value = '';
  els.manualResumeInput.value = '';
  els.generateCoverLetter.checked = false;
  els.resumeOutput.value = '';
  els.reviewOutput.value = '';
  els.genNotesOutput.value = '';
  els.chatInput.value = '';
  els.genChatInput.value = '';
  els.htmlChatInput.value = '';

  els.manualResumeRow.style.display = 'none';
  els.genNotesSection.style.display = 'none';
  els.genNotesSection.open = false;
  els.htmlChatSection.style.display = 'none';
  els.saveFilenameRow.style.display = 'none';

  els.resumeStatusAndToken.textContent = '';
  els.reviewStatusAndToken.textContent = '';
  els.htmlStatus.textContent = '';
  els.htmlTokenInfo.textContent = '';
  els.sessionTotalInfo.textContent = '';
  els.htmlUploadStatus.textContent = '';

  setJdImageStatus('');
  setJdImageQualityHint('');
  updateJdAiRetryVisibility(false);
  hideSameCompanyHint();

  els.chatHistory.innerHTML = '';
  els.genChatHistory.innerHTML = '';
  els.htmlChatHistory.innerHTML = '';

  if (els.jdImageUpload) els.jdImageUpload.value = '';
  if (els.jdImageUseAi) els.jdImageUseAi.checked = true;
  if (els.htmlPdfUpload) els.htmlPdfUpload.value = '';

  chatMessages = [];
  genChatMessages = [];
  htmlChatMessages = [];
  lastHtmlContent = '';
  uploadedFileData = null;
  baseResumeContent = '';
  jdInfo = null;
  jdImageLastBatch = null;
  sessionUsage = { totalInput: 0, totalOutput: 0, totalCost: 0 };
}

function restoreDraftState() {
  clearWorkspaceState();
}

/* ── Model Connection Definitions ── */
const MODEL_CONNECTIONS = [
  // Jiekou.ai
  { id: 'jiekou-openai',     provider: 'Jiekou.ai', family: 'OpenAI',    label: 'Jiekou OpenAI',     defaultUrl: 'https://api.jiekou.ai/v1',        defaultModel: '' },
  { id: 'jiekou-google',     provider: 'Jiekou.ai', family: 'Google',    label: 'Jiekou Google',     defaultUrl: 'https://api.jiekou.ai/v1',        defaultModel: '' },
  { id: 'jiekou-anthropic',  provider: 'Jiekou.ai', family: 'Anthropic', label: 'Jiekou Anthropic',  defaultUrl: 'https://api.jiekou.ai/anthropic',  defaultModel: 'claude-opus-4-6' },
  // OpenRouter.ai
  { id: 'openrouter-openai',    provider: 'OpenRouter.ai', family: 'OpenAI',    label: 'OpenRouter OpenAI',    defaultUrl: 'https://openrouter.ai/api/v1', defaultModel: '' },
  { id: 'openrouter-google',    provider: 'OpenRouter.ai', family: 'Google',    label: 'OpenRouter Google',    defaultUrl: 'https://openrouter.ai/api/v1', defaultModel: '' },
  { id: 'openrouter-anthropic', provider: 'OpenRouter.ai', family: 'Anthropic', label: 'OpenRouter Anthropic', defaultUrl: 'https://openrouter.ai/api/v1', defaultModel: '' },
  // Google AI Studio
  { id: 'google-studio-google', provider: 'Google AI Studio', family: 'Google', label: 'Google AI Studio', defaultUrl: '', defaultModel: 'gemini-2.5-flash' },
];

function getConnInput(connId, field) {
  const row = document.querySelector(`tr[data-conn="${connId}"]`);
  return row?.querySelector(`input[data-field="${field}"]`);
}

function getConfiguredConnections() {
  return MODEL_CONNECTIONS.filter(def => {
    const keyInput = getConnInput(def.id, 'key');
    return keyInput && keyInput.value.trim();
  });
}

function getSelectedReviewers() {
  return [...els.cfgAgentReviewers.querySelectorAll('input:checked')].map(cb => cb.value);
}

function migrateConnectionId(id) {
  if (id === 'opus') return 'jiekou-anthropic';
  if (id === 'gemini') return 'google-studio-google';
  return id || '';
}

function getConfiguredConnectionIds() {
  return getConfiguredConnections().map(def => def.id);
}

function resolveSingleConnectionId(currentValue, savedValue, defaultValue) {
  const configuredIds = getConfiguredConnectionIds();
  if (!configuredIds.length) return '';

  for (const candidate of [currentValue, savedValue, defaultValue]) {
    const id = migrateConnectionId(candidate);
    if (id && configuredIds.includes(id)) return id;
  }
  return configuredIds[0];
}

function resolveReviewerConnectionIds(currentValues = [], savedValues = [], defaultValue = 'google-studio-google') {
  const configuredIds = getConfiguredConnectionIds();
  if (!configuredIds.length) return [];

  const selected = [];
  for (const candidate of [...currentValues, ...(Array.isArray(savedValues) ? savedValues : []), defaultValue]) {
    const id = migrateConnectionId(candidate);
    if (id && configuredIds.includes(id) && !selected.includes(id)) selected.push(id);
  }
  return selected.length ? selected : [configuredIds[0]];
}

function applyResolvedAgentSelections(overrides = {}) {
  const orchestratorModel = resolveSingleConnectionId(
    overrides.orchestratorValue ?? els.cfgAgentOrchestrator.value,
    state.get('orchestratorModel', getBestOrchestratorModelId()),
    getBestOrchestratorModelId(),
  );
  
  const generatorModel = resolveSingleConnectionId(
    overrides.generatorValue ?? els.cfgAgentGenerator.value,
    state.get('generatorModel', 'jiekou-anthropic'),
    'jiekou-anthropic',
  );
  const htmlModel = resolveSingleConnectionId(
    overrides.htmlValue ?? els.cfgAgentHtml.value,
    state.get('htmlModel', 'google-studio-google'),
    'google-studio-google',
  );
  const reviewerModels = resolveReviewerConnectionIds(
    overrides.reviewerValues ?? getSelectedReviewers(),
    state.get('reviewerModels', ['google-studio-google']),
    'google-studio-google',
  );

  if (els.cfgAgentOrchestrator) els.cfgAgentOrchestrator.value = orchestratorModel;
  els.cfgAgentGenerator.value = generatorModel;
  els.cfgAgentHtml.value = htmlModel;
  for (const cb of els.cfgAgentReviewers.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = reviewerModels.includes(cb.value);
  }

  return { orchestratorModel, generatorModel, htmlModel, reviewerModels };
}

function getBestOrchestratorModelId() {
  const configured = getConfiguredConnections();
  if (!configured.length) return '';
  // Rank by cost efficiency internally
  const score = (c) => {
    if (c.id === 'google-studio-google') return 100;
    const modelLower = (getConnInput(c.id, 'model')?.value || c.defaultModel || '').toLowerCase();
    if (modelLower.includes('flash')) return 90;
    if (modelLower.includes('mini')) return 80;
    if (modelLower.includes('haiku')) return 70;
    return 10; // Catch all for expensive models
  };
  return configured.reduce((best, current) => score(current) > score(best) ? current : best, configured[0]).id;
}

function populateAgentDropdowns() {
  const configured = getConfiguredConnections();
  const prevSelections = {
    orchestratorValue: els.cfgAgentOrchestrator?.value,
    generatorValue: els.cfgAgentGenerator.value,
    htmlValue: els.cfgAgentHtml.value,
    reviewerValues: getSelectedReviewers(),
  };
  const bestOrchestratorId = getBestOrchestratorModelId();
  
  const options = configured.map(c =>
    `<option value="${c.id}">${c.label} (${getConnInput(c.id, 'model')?.value || c.defaultModel || c.family})</option>`
  ).join('');
  const orchestratorOptions = configured.map(c =>
    `<option value="${c.id}">${c.label} (${getConnInput(c.id, 'model')?.value || c.defaultModel || c.family}) ${c.id === bestOrchestratorId ? '[系统推荐：最高性价比]' : ''}</option>`
  ).join('');
  
  const emptyOption = '<option value="">— 未配置 —</option>';

  if (els.cfgAgentOrchestrator) els.cfgAgentOrchestrator.innerHTML = emptyOption + orchestratorOptions;
  if (els.cfgAgentGenerator) els.cfgAgentGenerator.innerHTML = emptyOption + options;
  if (els.cfgAgentHtml) els.cfgAgentHtml.innerHTML = emptyOption + options;

  els.cfgAgentReviewers.innerHTML = configured.map(c =>
    `<label class="checkbox-label"><input type="checkbox" value="${c.id}"> ${c.label}</label>`
  ).join('');

  return applyResolvedAgentSelections(prevSelections);
}

function getGeneratorModelId() {
  return resolveSingleConnectionId(els.cfgAgentGenerator.value, state.get('generatorModel', 'jiekou-anthropic'), 'jiekou-anthropic');
}

function getHtmlModelId() {
  return resolveSingleConnectionId(els.cfgAgentHtml.value, state.get('htmlModel', 'google-studio-google'), 'google-studio-google');
}

function getReviewerModelIds() {
  return resolveReviewerConnectionIds(getSelectedReviewers(), state.get('reviewerModels', ['google-studio-google']), 'google-studio-google');
}

function getJdAnalysisModelId() {
  return getGeneratorModelId();
}

function getReviewCoordinatorModelId() {
  const reviewers = getReviewerModelIds();
  return reviewers[0] || getGeneratorModelId();
}

function requireConfiguredConnection(connectionId, roleLabel) {
  if (connectionId || els.mockMode.checked) return connectionId;
  throw new Error(`${roleLabel} 模型连接未配置，请先在“设置”中填写 API Key 并保存`);
}

/* ── Token & Cost Utilities ── */
function formatUsage(usage, model) {
  if (!usage) return '';
  const pricing = PRICING[model] || { input: 0, output: 0, note: '未知模型' };
  const cost = (usage.input || 0) * pricing.input + (usage.output || 0) * pricing.output;
  const inp = (usage.input || 0).toLocaleString();
  const out = (usage.output || 0).toLocaleString();
  if (pricing.input === 0 && pricing.output === 0) {
    return `输入: ${inp} | 输出: ${out} tokens · (${pricing.note})`;
  } else {
    return `输入: ${inp} | 输出: ${out} tokens · $${cost.toFixed(4)}`;
  }
}

function updateSessionTotal() {
  if (!els.sessionTotalInfo) return;
  if (sessionUsage.totalInput === 0 && sessionUsage.totalOutput === 0) {
    els.sessionTotalInfo.textContent = '';
  } else {
    const inp = sessionUsage.totalInput.toLocaleString();
    const out = sessionUsage.totalOutput.toLocaleString();
    const cost = sessionUsage.totalCost.toFixed(4);
    els.sessionTotalInfo.textContent = `本次: 输入 ${inp} | 输出 ${out} · $${cost}`;
  }
}

/* ── Gemini Model Discovery ── */
async function fetchGeminiModels() {
  const statusEl = document.getElementById('geminiModelStatus');
  const queryBtn = document.getElementById('geminiQueryModelsBtn');
  const keyInput = getConnInput('google-studio-google', 'key');
  const currentKey = keyInput?.value.trim() || '';

  if (!currentKey) {
    if (statusEl) {
      statusEl.textContent = '请先填写 API Key';
      statusEl.className = 'status-text error';
    }
    alert('请先在 Google AI Studio 一行填写 API Key');
    return;
  }

  if (statusEl) {
    statusEl.textContent = '查询中...';
    statusEl.className = 'status-text';
  }
  if (queryBtn) queryBtn.disabled = true;
  try {
    const response = await api.listModels('google-studio-google', currentKey);
    const { models } = response;

    const tbody = document.getElementById('geminiModelListBody');
    if (!models.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="padding:8px;color:#666;">未找到适合简历/求职信文本生成的模型</td>
        </tr>
      `;
    } else {
      tbody.innerHTML = models.map(m => {
        const rpmStr = `${m.rateLimits.rpm}/${m.rateLimits.rpm}`;
        const rpdStr = `${m.rateLimits.rpd}/${m.rateLimits.rpd}`;
        const tpmStr = m.rateLimits.tpm > 0 ? (m.rateLimits.tpm / 1000000).toFixed(1) + 'M' : '-';
        return `
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:4px;">${m.recommendation}</td>
            <td style="padding:4px;"><code style="font-size:0.8rem;">${m.id}</code></td>
            <td style="padding:4px;font-size:0.75rem;">RPM ${rpmStr} / RPD ${rpdStr} / TPM ${tpmStr}</td>
            <td style="padding:4px;">
              <button class="btn-secondary btn-sm" data-select-model="${m.id}" style="padding:2px 8px;font-size:0.75rem;">选择</button>
            </td>
          </tr>
        `;
      }).join('');
    }

    tbody.onclick = (e) => {
      const btn = e.target.closest('[data-select-model]');
      if (btn) selectGeminiModel(btn.dataset.selectModel);
    };

    const modelList = document.getElementById('geminiModelList');
    modelList.style.display = '';
    if (statusEl) {
      statusEl.textContent = '查询完毕';
      statusEl.className = 'status-text success';
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = '查询失败';
      statusEl.className = 'status-text error';
    }
    alert('获取模型列表失败: ' + e.message);
  } finally {
    if (queryBtn) queryBtn.disabled = false;
  }
}

function selectGeminiModel(modelId) {
  const modelInput = getConnInput('google-studio-google', 'model');
  if (modelInput) {
    modelInput.value = modelId;
    populateAgentDropdowns();
  }
}

/* ── Init ── */
async function init() {
  await restoreState();
  bindEvents();
  populateAgentDropdowns();
  restoreAgentAssignments();
  updateGenerateBtn();
  await autoInitAPI();
  if (els.libraryPath.value.trim()) {
    await loadLibrary(true);
  }
}

function buildPiiConfig() {
  const enabled = els.cfgPiiEnabled.checked;
  if (!enabled) return { enabled: false };
  const splitTrim = val => val.split(',').map(s => s.trim()).filter(Boolean);
  return {
    enabled: true,
    nameEn: els.cfgPiiNameEn.value.trim(),
    nameZh: els.cfgPiiNameZh.value.trim(),
    nameVariants: splitTrim(els.cfgPiiNameVariants.value),
    email: els.cfgPiiEmail.value.trim(),
    phones: splitTrim(els.cfgPiiPhone.value),
    linkedin: els.cfgPiiLinkedin.value.trim(),
    github: els.cfgPiiGithub.value.trim(),
    website: els.cfgPiiWebsite.value.trim(),
    other: splitTrim(els.cfgPiiOther.value),
  };
}

async function autoInitAPI() {
  const connections = buildModelConnections();
  if (connections.length === 0) return;
  try {
    const allowedPaths = ['/Users/wukun/Documents/tmp/resumeTailor/vscCCOpus'];
    const libPath = els.libraryPath.value.trim();
    if (libPath) allowedPaths.push(libPath);
    await api.initAPI({ modelConnections: connections, allowedPaths, piiConfig: buildPiiConfig() });
  } catch {}
}

function buildModelConnections() {
  const connections = [];
  for (const def of MODEL_CONNECTIONS) {
    const keyInput = getConnInput(def.id, 'key');
    const key = keyInput?.value.trim();
    if (!key) continue;
    const urlInput = getConnInput(def.id, 'url');
    const modelInput = getConnInput(def.id, 'model');
    connections.push({
      id: def.id,
      url: urlInput?.value.trim() || def.defaultUrl,
      key,
      model: modelInput?.value.trim() || def.defaultModel,
      label: def.label,
    });
  }
  return connections;
}

async function restoreState() {
  // Restore connection fields from encrypted storage
  for (const def of MODEL_CONNECTIONS) {
    const savedKey = await state.getCredential(`connKey_${def.id}`);
    const savedUrl = state.get(`connUrl_${def.id}`, def.defaultUrl);
    const savedModel = state.get(`connModel_${def.id}`, def.defaultModel);
    const keyInput = getConnInput(def.id, 'key');
    const urlInput = getConnInput(def.id, 'url');
    const modelInput = getConnInput(def.id, 'model');
    if (keyInput) keyInput.value = savedKey;
    if (urlInput) urlInput.value = savedUrl;
    if (modelInput) modelInput.value = savedModel;
  }

  // Migrate from old format if needed
  const oldAnthropicKey = await state.getCredential('anthropicKey');
  const oldGeminiKey = await state.getCredential('geminiKey');
  if (oldAnthropicKey && !await state.getCredential('connKey_jiekou-anthropic')) {
    const keyInput = getConnInput('jiekou-anthropic', 'key');
    if (keyInput) keyInput.value = oldAnthropicKey;
    const urlInput = getConnInput('jiekou-anthropic', 'url');
    const oldUrl = await state.getCredential('anthropicUrl', 'https://api.jiekou.ai/anthropic');
    if (urlInput) urlInput.value = oldUrl;
  }
  if (oldGeminiKey && !await state.getCredential('connKey_google-studio-google')) {
    const keyInput = getConnInput('google-studio-google', 'key');
    if (keyInput) keyInput.value = oldGeminiKey;
    const modelInput = getConnInput('google-studio-google', 'model');
    if (modelInput) modelInput.value = state.get('geminiModelName', 'gemini-2.5-flash');
  }

  // Restore non-connection settings
  els.libraryPath.value = state.get('libraryPath');
  els.genInstructions.value = state.get('genInstructions');
  els.reviewInstructions.value = state.get('reviewInstructions');
  els.htmlInstructions.value = state.get('htmlInstructions');
  els.mockMode.checked = state.get('mockMode', false);
  if (els.jdImageUseAi) els.jdImageUseAi.checked = state.get('jdImageUseAi', true);

  // Restore PII config
  els.cfgPiiEnabled.checked = state.get('piiEnabled', false);
  els.cfgPiiNameEn.value = await state.getCredential('pii_nameEn');
  els.cfgPiiNameZh.value = await state.getCredential('pii_nameZh');
  els.cfgPiiNameVariants.value = await state.getCredential('pii_nameVariants');
  els.cfgPiiEmail.value = await state.getCredential('pii_email');
  els.cfgPiiPhone.value = await state.getCredential('pii_phone');
  els.cfgPiiLinkedin.value = await state.getCredential('pii_linkedin');
  els.cfgPiiGithub.value = await state.getCredential('pii_github');
  els.cfgPiiWebsite.value = await state.getCredential('pii_website');
  els.cfgPiiOther.value = await state.getCredential('pii_other');

  restoreDraftState();
}

function restoreAgentAssignments() {
  applyResolvedAgentSelections();
}

function persistInputs() {
  state.set('libraryPath', els.libraryPath.value);
  state.set('genInstructions', els.genInstructions.value);
  state.set('reviewInstructions', els.reviewInstructions.value);
  state.set('htmlInstructions', els.htmlInstructions.value);
  persistDraftState();
}

/* ── Events ── */
function bindEvents() {
  els.settingsBtn.addEventListener('click', () => els.settingsModal.classList.add('open'));
  els.settingsClose.addEventListener('click', () => els.settingsModal.classList.remove('open'));
  els.settingsModal.addEventListener('click', e => { if (e.target === els.settingsModal) els.settingsModal.classList.remove('open'); });
  els.settingsSave.addEventListener('click', saveSettings);
  els.browseLibraryBtn.addEventListener('click', browseLibrary);
  els.loadLibraryBtn.addEventListener('click', () => loadLibrary());
  els.exportDigestBtn.addEventListener('click', exportDigest);
  els.baseResumeSelect.addEventListener('change', onBaseResumeChange);
  els.generateBtn.addEventListener('click', doGenerate);
  els.regenerateBtn.addEventListener('click', doGenerate);
  els.jdImageUpload.addEventListener('change', handleJdImageUpload);
  if (els.jdImageUseAi) {
    els.jdImageUseAi.addEventListener('change', () => {
      state.set('jdImageUseAi', els.jdImageUseAi.checked);
    });
  }
  els.jdImageAiRetryBtn.addEventListener('click', retryJdImageWithAi);
  els.saveResumeBtn.addEventListener('click', showSaveDialog);
  els.confirmSaveBtn.addEventListener('click', doSave);
  els.cancelSaveBtn.addEventListener('click', () => { els.saveFilenameRow.style.display = 'none'; });
  els.reviewBtn.addEventListener('click', doReview);
  els.applyReviewBtn.addEventListener('click', doApplyReview);
  els.chatSendBtn.addEventListener('click', doChat);
  els.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doChat(); } });
  els.genChatSendBtn.addEventListener('click', doGenChat);
  els.genChatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doGenChat(); } });
  els.generateHtmlBtn.addEventListener('click', doGenerateHtml);
  els.htmlChatSendBtn.addEventListener('click', doHtmlChat);
  els.htmlChatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doHtmlChat(); } });
  els.htmlPdfUpload.addEventListener('change', handlePdfUpload);
  els.openPdfBtn.addEventListener('click', (e) => {
    console.log('openPdfBtn click event fired');
    console.log('Button element:', els.openPdfBtn);
    console.log('File input element:', els.openPdfFileInput);
    e.preventDefault();
    e.stopPropagation();
    
    if (!els.openPdfFileInput) {
      console.error('openPdfFileInput is null or undefined!');
      return;
    }
    
    console.log('Triggering file input click...');
    try {
      els.openPdfFileInput.click();
      console.log('File input click triggered');
    } catch (error) {
      console.error('Error triggering file input click:', error);
    }
  });
  els.openPdfFileInput.addEventListener('change', handleOpenPdf);
  els.mockMode.addEventListener('change', () => { state.set('mockMode', els.mockMode.checked); updateGenerateBtn(); });
  const geminiQueryBtn = document.getElementById('geminiQueryModelsBtn');
  if (geminiQueryBtn) geminiQueryBtn.addEventListener('click', fetchGeminiModels);
  // Update agent dropdowns when connection keys change
  for (const def of MODEL_CONNECTIONS) {
    const keyInput = getConnInput(def.id, 'key');
    if (keyInput) keyInput.addEventListener('input', populateAgentDropdowns);
    const modelInput = getConnInput(def.id, 'model');
    if (modelInput) modelInput.addEventListener('input', populateAgentDropdowns);
  }
  els.jdInput.addEventListener('input', () => { jdInfo = null; updateGenerateBtn(); persistDraftState(); });
  els.manualResumeInput.addEventListener('input', persistDraftState);
  els.generateCoverLetter.addEventListener('change', persistDraftState);
  els.resumeOutput.addEventListener('input', () => { onResumeEdited(); persistDraftState(); });
  els.reviewOutput.addEventListener('input', persistDraftState);
  els.genInstructions.addEventListener('change', persistInputs);
  els.reviewInstructions.addEventListener('change', persistInputs);
  els.htmlInstructions.addEventListener('change', persistInputs);
  window.addEventListener('beforeunload', () => persistDraftState(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistDraftState(true);
  });
  // Auto-resize chat textareas
  for (const ta of [els.genChatInput, els.chatInput, els.htmlChatInput]) {
    if (ta) ta.addEventListener('input', () => autoResize(ta));
  }
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
}

function onResumeEdited() {
  updateGenerateBtn();
}

function updateGenerateBtn() {
  const hasJD = getNormalizedJdText().length > 0;
  const hasGenerator = !!getGeneratorModelId();
  const hasHtml = !!getHtmlModelId();
  const hasReviewer = getReviewerModelIds().length > 0;
  els.generateBtn.disabled = !hasJD || isStreaming || (!els.mockMode.checked && !hasGenerator);
  els.generateHtmlBtn.disabled = !els.resumeOutput.value.trim() || isStreaming || (!els.mockMode.checked && !hasHtml);
  els.reviewBtn.disabled = !els.resumeOutput.value.trim() || isStreaming || (!els.mockMode.checked && !hasReviewer);
}

/* ── Browse folder (Chrome File System Access API) ── */
async function browseLibrary() {
  if (!('showDirectoryPicker' in window)) {
    alert('当前浏览器不支持文件夹选择，请手动输入路径');
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    // showDirectoryPicker doesn't give us a filesystem path directly.
    // We use the directory name as hint and let user confirm/edit the path.
    const currentPath = els.libraryPath.value.trim();
    if (!currentPath) {
      alert(`已选择文件夹 "${dirHandle.name}"。由于浏览器安全限制，无法获取完整路径。\n请在输入框中填写完整路径后点击"加载"。`);
    } else {
      await loadLibrary();
    }
  } catch (e) {
    if (e.name !== 'AbortError') alert('选择文件夹失败: ' + e.message);
  }
}

/* ── Settings ── */
async function saveSettings() {
  // Save connection fields (encrypted keys)
  for (const def of MODEL_CONNECTIONS) {
    const keyInput = getConnInput(def.id, 'key');
    const urlInput = getConnInput(def.id, 'url');
    const modelInput = getConnInput(def.id, 'model');
    if (keyInput) await state.setCredential(`connKey_${def.id}`, keyInput.value.trim());
    if (urlInput) state.set(`connUrl_${def.id}`, urlInput.value.trim());
    if (modelInput) state.set(`connModel_${def.id}`, modelInput.value.trim());
  }

  const assignments = populateAgentDropdowns();
  state.set('orchestratorModel', assignments.orchestratorModel);
  state.set('generatorModel', assignments.generatorModel);
  state.set('reviewerModels', assignments.reviewerModels);
  state.set('htmlModel', assignments.htmlModel);

  // Save PII config (encrypted)
  state.set('piiEnabled', els.cfgPiiEnabled.checked);
  await state.setCredential('pii_nameEn', els.cfgPiiNameEn.value.trim());
  await state.setCredential('pii_nameZh', els.cfgPiiNameZh.value.trim());
  await state.setCredential('pii_nameVariants', els.cfgPiiNameVariants.value.trim());
  await state.setCredential('pii_email', els.cfgPiiEmail.value.trim());
  await state.setCredential('pii_phone', els.cfgPiiPhone.value.trim());
  await state.setCredential('pii_linkedin', els.cfgPiiLinkedin.value.trim());
  await state.setCredential('pii_github', els.cfgPiiGithub.value.trim());
  await state.setCredential('pii_website', els.cfgPiiWebsite.value.trim());
  await state.setCredential('pii_other', els.cfgPiiOther.value.trim());

  els.settingsStatus.textContent = '连接中...';
  els.settingsStatus.className = 'status-text';
  try {
    const allowedPaths = ['/Users/wukun/Documents/tmp/resumeTailor/vscCCOpus'];
    const libPath = els.libraryPath.value.trim();
    if (libPath) allowedPaths.push(libPath);
    const connections = buildModelConnections();

    const result = await api.initAPI({ modelConnections: connections, allowedPaths, piiConfig: buildPiiConfig() });
    const readyCount = result.readyConnections?.length || 0;
    if (readyCount > 0) {
      els.settingsStatus.textContent = `${readyCount} 个连接已就绪: ${result.readyConnections.join(', ')}`;
      els.settingsStatus.className = 'status-text success';
      setTimeout(() => els.settingsModal.classList.remove('open'), 800);
    } else {
      els.settingsStatus.textContent = '未配置任何API连接';
      els.settingsStatus.className = 'status-text error';
    }
  } catch (e) {
    els.settingsStatus.textContent = '连接失败: ' + e.message;
    els.settingsStatus.className = 'status-text error';
  }
}

function canUseAiJdOcr() {
  if (els.mockMode.checked) return true;
  return !!getHtmlModelId();
}

function updateJdAiRetryVisibility(show) {
  if (!els.jdImageAiRetryBtn) return;
  els.jdImageAiRetryBtn.style.display = show ? '' : 'none';
  els.jdImageAiRetryBtn.disabled = !show;
}

async function handleJdImageUpload(e) {
  const files = [...(e.target.files || [])].filter(file => file.type.startsWith('image/'));
  els.jdImageUpload.value = '';
  if (!files.length) return;

  jdImageLastBatch = { files, localText: '', appliedText: '', quality: null, aiUsed: false };
  updateJdAiRetryVisibility(false);
  setJdImageQualityHint('');
  
  if (els.jdImageUseAi && els.jdImageUseAi.checked) {
    await handleJdImageUploadWithAi(files);
  } else {
    await handleJdImageUploadWithLocal(files);
  }
}

async function handleJdImageUploadWithLocal(files) {
  setJdImageStatus(`准备本地识别 ${files.length} 张 JD 图片...`);

  try {
    const worker = await getJdOcrWorker(msg => {
      if (msg.status === 'recognizing text') {
        setJdImageStatus(`本地 OCR 中... ${Math.round((msg.progress || 0) * 100)}%`);
      } else if (msg.status === 'loading language traineddata') {
        setJdImageStatus('首次识别，正在下载本地 OCR 语言包...');
      }
    });

    const sections = [];
    for (let i = 0; i < files.length; i++) {
      setJdImageStatus(`正在本地识别第 ${i + 1}/${files.length} 张图片...`);
      const canvas = await preprocessJdImage(files[i]);
      const { data } = await worker.recognize(canvas, { rotateAuto: true });
      const text = normalizeOcrText(data.text);
      if (text) sections.push(text);
    }

    const merged = sections.join('\n\n');
    jdImageLastBatch.localText = merged;
    jdImageLastBatch.appliedText = merged;
    jdImageLastBatch.quality = evaluateJdOcrQuality(merged);

    if (merged) appendJdText(merged);
    jdInfo = null;
    updateGenerateBtn();
    persistDraftState(true);

    if (!merged) {
      const canRetry = canUseAiJdOcr();
      setJdImageStatus(`未能从 ${files.length} 张图片识别出有效 JD 文本`, 'error');
      setJdImageQualityHint(canRetry
        ? '本地 OCR 没有提取到可用内容，可点击“用 AI 改进识别”，或手动补充 JD 文本。'
        : '本地 OCR 没有提取到可用内容。当前未配置 Format Converter，暂时不能使用 AI OCR 兜底。', 'error');
      updateJdAiRetryVisibility(canRetry);
      return;
    }

    setJdImageStatus(`已通过本地 OCR 提取 JD 文本，并追加到输入框`, 'success');
    if (jdImageLastBatch.quality.weak) {
      const canRetry = canUseAiJdOcr();
      setJdImageQualityHint(canRetry
        ? '本地 OCR 结果可能不完整，建议先手动检查；如仍不理想，可点击“用 AI 改进识别”。'
        : '本地 OCR 结果可能不完整。当前未配置 Format Converter，暂时不能使用 AI OCR 兜底，请先检查或手动修正 JD 文本。');
      updateJdAiRetryVisibility(canRetry);
    } else {
      setJdImageQualityHint('本地 OCR 结果质量较好，建议快速检查后直接使用。');
    }
  } catch (err) {
    setJdImageStatus(`本地识别失败: ${err.message}`, 'error');
    setJdImageQualityHint('本地 OCR 未完成。你可以重新上传图片，或在配置好 Format Converter 后尝试“用 AI 改进识别”。', 'error');
    updateJdAiRetryVisibility(canUseAiJdOcr());
  }
}

async function handleJdImageUploadWithAi(files) {
  try {
    const model = requireConfiguredConnection(getHtmlModelId(), 'Format Converter');
    setJdImageStatus(`正在调用 AI (${model}) 识别 ${files.length} 张 JD 图片...`);
    
    const result = await performAiJdOcr(model, files);
    const text = result.text;

    appendJdText(text);
    jdImageLastBatch.appliedText = text;
    jdImageLastBatch.aiUsed = true;
    jdImageLastBatch.quality = evaluateJdOcrQuality(text);
    jdInfo = null;
    updateGenerateBtn();
    persistDraftState(true);

    setJdImageStatus(`已通过 AI 识别 ${files.length} 张图片，并追加到 JD 输入框`, 'success');
    setJdImageQualityHint('已使用 AI 识别图片；后续生成/评审仍只使用 JD 文本，不会重复发送图片。');
    updateJdAiRetryVisibility(false);
  } catch (err) {
    setJdImageStatus(`AI 识别失败: ${err.message}`, 'error');
    setJdImageQualityHint('AI 识别遇到问题。你可以尝试切换回本地识别，或检查 API 配置。', 'error');
    // If AI fails upfront, we don't automatically fall back to local as per user's "AI already exists" hint, 
    // but we allow the user to try again or use the retry button if they switch modes.
    updateJdAiRetryVisibility(true);
  }
}

async function performAiJdOcr(model, files) {
  const images = await Promise.all(files.map(fileToBase64Payload));
  const result = await api.ocrJdImages(model, images, els.mockMode.checked);
  const text = normalizeOcrText(result.text);
  if (!text) throw new Error('AI 未返回有效 JD 文本');
  return { text, usage: result.usage, model };
}

async function retryJdImageWithAi() {
  if (!jdImageLastBatch?.files?.length || isStreaming) return;
  try {
    const model = requireConfiguredConnection(getHtmlModelId(), 'Format Converter');
    els.jdImageAiRetryBtn.disabled = true;
    setJdImageStatus('正在用 AI 改进图片识别结果...');
    
    const result = await performAiJdOcr(model, jdImageLastBatch.files);
    const text = result.text;

    const replaced = replaceLastAppendedJdText(jdImageLastBatch.appliedText, text);
    jdImageLastBatch.appliedText = text;
    jdImageLastBatch.aiUsed = true;
    jdImageLastBatch.quality = evaluateJdOcrQuality(text);
    jdInfo = null;
    updateGenerateBtn();
    persistDraftState(true);

    updateJdAiRetryVisibility(false);
    setJdImageStatus(replaced ? 'AI 已改进最新一批 JD 图片识别结果' : 'AI 已改进识别结果，并追加到 JD 输入框末尾', 'success');
    setJdImageQualityHint('已使用 Format Converter 进行 AI OCR 兜底；后续生成/评审仍只使用 JD 文本，不会重复发送图片。');
  } catch (err) {
    setJdImageStatus(`AI 改进失败: ${err.message}`, 'error');
    setJdImageQualityHint('AI OCR 兜底失败，请手动修正 JD 文本后继续。', 'error');
  } finally {
    els.jdImageAiRetryBtn.disabled = false;
  }
}

/* ── Library ── */
async function loadLibrary(silent = false) {
  const dir = els.libraryPath.value.trim();
  if (!dir) { if (!silent) alert('请输入素材库路径'); return; }
  state.set('libraryPath', dir);
  try {
    const files = await api.listFiles(dir);
    await applyLibraryFiles(files);
    const readableCount = files.filter(f => f.readable).length;
    if (!silent) {
      els.resumeStatusAndToken.textContent = `已加载 ${files.length} 个文件（${readableCount} 个可读取）`;
    }
    // Enable export button when library has readable files
    els.exportDigestBtn.disabled = readableCount === 0;
  } catch (e) {
    if (!silent) alert('加载失败: ' + e.message);
    els.exportDigestBtn.disabled = true;
  }
}

/**
 * Export the preprocessed (paragraph-deduplicated) text library as a
 * human-readable .txt file for use with other AI tools.
 */
/**
 * 估算文本的token数量（本地计算，不需要调用AI API）
 * 基于tiktoken的通用经验：
 * - 中文：1个汉字 ≈ 1 token（更准确的经验值）
 * - 英文/数字/标点：平均约4字符 ≈ 1 token
 * - 这是一个近似估算，实际token数量可能因具体文本而异
 */
async function calculateEstimatedTokens(text) {
  const content = String(text);
  
  // 统计中文字符（基本汉字区）
  const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
  
  // 统计CJK扩展字符（ Rare Chinese characters）
  const cjkExtChars = (content.match(/[\u3400-\u4dbf]/g) || []).length;
  
  // 统计日文/韩文字符（如果存在）
  const japaneseChars = (content.match(/[\u3040-\u309f]/g) || []).length; // Hiragana
  const koreanChars = (content.match(/[\uac00-\ud7af]/g) || []).length; // Hangul
  
  // 统计其他字符（英文、数字、标点、空格等）
  const otherChars = content.length - chineseChars - cjkExtChars - japaneseChars - koreanChars;
  
  // Token估算：
  // - 中文字符：每个汉字 ≈ 1 token
  // - CJK扩展字符：每个 ≈ 1 token
  // - 日韩字符：每个 ≈ 1 token
  // - 其他字符：平均4字符 ≈ 1 token
  const estimatedTokens = Math.ceil(
    chineseChars * 1.0 +
    cjkExtChars * 1.0 +
    japaneseChars * 1.0 +
    koreanChars * 1.0 +
    otherChars / 4
  );
  
  return estimatedTokens;
}

async function exportDigest() {
  const dir = els.libraryPath.value.trim();
  if (!dir) { alert('请先输入素材库路径并加载'); return; }
  els.exportDigestBtn.disabled = true;
  els.exportDigestStatus.textContent = '正在导出...';
  els.exportDigestStatus.className = 'status-text';
  try {
    const { digest, fileCount, sourceTokens, digestTokens } = await api.getLibraryDigest(dir, []);
    if (!digest || digest.length === 0) {
      els.exportDigestStatus.textContent = '素材库为空，无可导出内容';
      els.exportDigestStatus.className = 'status-text error';
      return;
    }
    // Build human-readable text
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const lines = [
      '========== 素材库预处理文本 ==========',
      `导出时间：${dateStr} ${timeStr}`,
      `素材库路径：${dir}`,
      `文件数量：${fileCount}`,
      `源文件总输入 Token：${sourceTokens.toLocaleString()}`,
      `预处理后输入 Token：${digestTokens.toLocaleString()}`,
      '已去重段落',
      '',
    ];
    for (const item of digest) {
      lines.push(`---------- ${item.name} ----------`);
      lines.push(item.content);
      lines.push('');
    }
    const text = lines.join('\n');
    // Trigger browser download
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `素材库预处理文本-${dateStr}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    els.exportDigestStatus.textContent = `导出完成（${fileCount} 个文件，源文件: ${sourceTokens.toLocaleString()} tokens，预处理后: ${digestTokens.toLocaleString()} tokens）`;
    els.exportDigestStatus.className = 'status-text success';
  } catch (e) {
    els.exportDigestStatus.textContent = '导出失败: ' + e.message;
    els.exportDigestStatus.className = 'status-text error';
  } finally {
    els.exportDigestBtn.disabled = false;
  }
}

async function ensureLibraryContents() {
  if (resumeLibraryContents.length > 0) return resumeLibraryContents;
  const dir = els.libraryPath.value.trim();
  if (!dir || libraryFiles.length === 0) return [];
  resumeLibraryContents = [];
  for (const f of libraryFiles) {
    if (f.readable) {
      try {
        const content = await api.readFile(dir + '/' + f.name);
        resumeLibraryContents.push({ name: f.name, content });
      } catch {}
    }
  }
  return resumeLibraryContents;
}

function populateBaseResumeSelect() {
  const sel = els.baseResumeSelect;
  const prev = state.get('baseResume');
  sel.innerHTML = '<option value="">— 选择基础简历 —</option>' +
    '<option value="__manual__">手动输入</option>' +
    libraryFiles.map(f =>
      `<option value="${f.name}" ${!f.readable ? 'data-unreadable="1"' : ''}>${f.name} ${!f.readable ? '(需手动粘贴)' : ''}</option>`
    ).join('');
  if (prev) sel.value = prev;
}

async function applyLibraryFiles(files) {
  libraryFiles = files;
  resumeLibraryContents = [];
  populateBaseResumeSelect();
  await onBaseResumeChange();
}

function hasLibraryMetadataChanged(currentFiles, nextFiles) {
  if (currentFiles.length !== nextFiles.length) return true;
  for (let i = 0; i < currentFiles.length; i++) {
    const current = currentFiles[i];
    const next = nextFiles[i];
    if (!current || !next) return true;
    if (current.name !== next.name) return true;
    if (current.ext !== next.ext) return true;
    if (current.size !== next.size) return true;
    if (current.readable !== next.readable) return true;
    if (new Date(current.modified).getTime() !== new Date(next.modified).getTime()) return true;
  }
  return false;
}

async function refreshLibraryMetadataIfChanged() {
  const dir = els.libraryPath.value.trim();
  if (!dir) return false;

  const latestFiles = await api.listFiles(dir);
  if (!hasLibraryMetadataChanged(libraryFiles, latestFiles)) {
    return false;
  }

  await applyLibraryFiles(latestFiles);
  return true;
}

async function onBaseResumeChange() {
  const val = els.baseResumeSelect.value;
  state.set('baseResume', val);
  els.manualResumeRow.style.display = 'none';
  baseResumeContent = '';

  if (!val || val === '__manual__') {
    if (val === '__manual__') els.manualResumeRow.style.display = '';
    updateGenerateBtn();
    return;
  }

  const file = libraryFiles.find(f => f.name === val);
  if (file && !file.readable) {
    els.manualResumeRow.style.display = '';
    els.manualResumeInput.placeholder = `${val} 无法自动解析，请手动粘贴内容...`;
    updateGenerateBtn();
    return;
  }

  try {
    const dir = els.libraryPath.value.trim();
    // Check client-side cache
    const cached = baseResumeCache.get(val);
    const fileMeta = libraryFiles.find(f => f.name === val);
    const cachedModified = cached?.modified;
    const fileModified = fileMeta?.modified;
    if (cached && cachedModified === fileModified) {
      baseResumeContent = cached.content;
    } else {
      baseResumeContent = await api.readFile(dir + '/' + val);
      baseResumeCache.set(val, { content: baseResumeContent, modified: fileModified });
    }
    els.manualResumeRow.style.display = 'none';
  } catch (e) {
    if (e.message === 'PAGES_NOT_SUPPORTED' || e.message.includes('pages')) {
      els.manualResumeRow.style.display = '';
      els.manualResumeInput.placeholder = `.pages 文件无法自动解析，请手动粘贴内容...`;
    } else {
      alert('读取失败: ' + e.message);
    }
  }
  updateGenerateBtn();
}

/* ── Extract JD info for file naming ── */
/**
 * Detect JD language by Chinese vs non-Chinese character ratio.
 */
function detectLanguage(text) {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const total = text.replace(/\s/g, '').length || 1;
  return chinese / total > 0.15 ? 'zh' : 'en';
}

/**
 * Try to extract company/dept/title from JD using regex patterns.
 * Returns { company, department, title, language } or null if insufficient matches.
 */
function tryLocalJdParse(jdText) {
  const lang = detectLanguage(jdText);
  let company = '', department = '', title = '';

  // Company patterns
  const companyPatterns = [
    /(?:Company|公司)[:\s：]+([^\n,，]+)/i,
    /(?:About|关于)\s+([A-Z][\w&.\- ]+)/i,
    /(?:^|\n)([A-Z][\w&.\- ]{2,})\s+(?:is |are |was )/m,
  ];
  for (const p of companyPatterns) {
    const m = jdText.match(p);
    if (m) { company = m[1].trim(); break; }
  }

  // Title patterns
  const titlePatterns = [
    /(?:Position|Title|Role|Job Title|职位|岗位)[:\s：]+([^\n,，]+)/i,
    /(?:^|\n)(?:Senior |Staff |Lead |Principal |Jr\.? |Junior )?(\w[\w\s/&]+(?:Manager|Engineer|Developer|Designer|Analyst|Architect|Scientist|Director|Coordinator|Specialist|Consultant|Administrator|Strategist|Producer|Writer|Editor))/im,
  ];
  for (const p of titlePatterns) {
    const m = jdText.match(p);
    if (m) { title = m[1].trim(); break; }
  }

  // Department patterns
  const deptPatterns = [
    /(?:Department|Team|Division|Group|部门|团队)[:\s：]+([^\n,，]+)/i,
  ];
  for (const p of deptPatterns) {
    const m = jdText.match(p);
    if (m) { department = m[1].trim(); break; }
  }

  // Only succeed if we extracted at least company AND title
  if (!company || !title) return null;
  return { company, department, title, language: lang };
}

async function extractJdInfo() {
  if (jdInfo) return jdInfo;
  const jd = getNormalizedJdText();
  if (!jd) return { company: '', department: '', title: '', language: 'en' };

  // Try local parsing first (saves ~1600 tokens)
  const local = tryLocalJdParse(jd);
  if (local) {
    jdInfo = local;
    return jdInfo;
  }

  try {
    const model = getJdAnalysisModelId();
    if (!model && !els.mockMode.checked) return { company: '', department: '', title: '', language: 'en' };
    const res = await fetch('/api/extract-jd-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, jd, mock: els.mockMode.checked }),
    });
    jdInfo = await res.json();
    return jdInfo;
  } catch {
    return { company: '', department: '', title: '', language: 'en' };
  }
}

function buildFilename(info, type = 'resume') {
  const date = new Date().toISOString().slice(0, 10);
  // Fixed structure: name - type - company - dept - title - date
  // Company always at index 2 for findSameCompanyFiles matching
  const company = info.company || 'unknown';
  const parts = ['wukun', type, company];
  if (info.department) parts.push(info.department);
  if (info.title) parts.push(info.title);
  parts.push(date);
  return parts.join(' - ') + '.txt';
}

/* ── Cross-submission: find same-company files in library ── */
function findSameCompanyFiles(companyName) {
  if (!companyName || !resumeLibraryContents?.length) return [];
  const companyLower = companyName.toLowerCase();
  const baseResumeName = els.baseResumeSelect.value;
  return resumeLibraryContents.filter(item => {
    if (item.name === baseResumeName) return false;
    const parts = item.name.split(' - ');
    if (parts.length < 3) return false;
    const fileCompany = parts[2].trim().toLowerCase();
    return fileCompany === companyLower;
  });
}

function buildPreviouslySubmitted(sameCompanyFiles) {
  if (!sameCompanyFiles.length) return '';
  return sameCompanyFiles.map(f => `--- ${f.name} ---\n${f.content}`).join('\n\n');
}

function showSameCompanyHint(company, count) {
  const el = document.getElementById('sameCompanyHint');
  if (el) {
    el.textContent = `\u26a0\ufe0f 检测到已向 ${company} 投递过 ${count} 份简历/求职信，将自动进行跨投递一致性约束`;
    el.style.display = '';
  }
}

function hideSameCompanyHint() {
  const el = document.getElementById('sameCompanyHint');
  if (el) el.style.display = 'none';
}

/**
 * Heuristic: does this text look like a full resume (not a conversational reply)?
 * Checks for resume structural keywords and minimum length.
 */
function looksLikeResume(text) {
  if (text.length < 300) return false;
  const keywords = ['工作经历', '教育背景', 'Summary', 'Experience', 'Education', '项目经历', '技能'];
  const hits = keywords.filter(k => text.includes(k)).length;
  return hits >= 2;
}

/**
 * Heuristic: does this text look like a review (not a conversational reply)?
 */
function looksLikeReview(text) {
  const keywords = ['评分', '评审', '优点', '改进', '修改建议', '不一致', '建议', 'Score', '评价', '问题'];
  const hits = keywords.filter(k => text.includes(k)).length;
  // Short text needs more keyword hits to avoid false positives
  if (text.length < 100) return hits >= 3;
  return hits >= 2;
}

/* ── Parse AI output: separate resume body from AI notes ── */
function parseGeneratedOutput(fullText) {
  const resumeMarker = /={3,}\s*简历正文\s*={3,}/;
  const notesMarker = /={3,}\s*AI备注\s*={3,}/;

  let resumeBody = '';
  let notes = '';

  const notesMatch = fullText.search(notesMarker);
  if (notesMatch !== -1) {
    const beforeNotes = fullText.slice(0, notesMatch);
    notes = fullText.slice(notesMatch).replace(notesMarker, '').trim();

    // Extract resume body (between resume marker and notes/cover letter marker)
    const resumeMatch = beforeNotes.search(resumeMarker);
    if (resumeMatch !== -1) {
      resumeBody = beforeNotes.slice(resumeMatch).replace(resumeMarker, '').trim();
    } else {
      resumeBody = beforeNotes.trim();
    }
  } else {
    // No markers — AI didn't follow format, use full text as resume
    const resumeMatch = fullText.search(resumeMarker);
    if (resumeMatch !== -1) {
      resumeBody = fullText.slice(resumeMatch).replace(resumeMarker, '').trim();
    } else {
      resumeBody = fullText.trim();
    }
  }

  return { resumeBody, notes };
}

/* ── Generate Resume ── */
async function doGenerate() {
  persistInputs();
  const jd = getNormalizedJdText();
  if (!jd) return alert('请输入JD');

  try {
    const libraryChanged = await refreshLibraryMetadataIfChanged();
    if (libraryChanged) {
      els.resumeStatusAndToken.textContent = '检测到素材库变化，已自动刷新';
      persistDraftState(true);
    }
  } catch (e) {
    return alert('刷新素材库失败: ' + e.message);
  }

  const resume = baseResumeContent || els.manualResumeInput.value.trim();
  if (!resume) return alert('请选择或输入基础简历');

  isStreaming = true;
  els.generateBtn.disabled = true;
  els.resumeOutput.value = '';
  els.resumeStatusAndToken.textContent = '生成中...';
  chatMessages = [];
  els.chatHistory.innerHTML = '';
  els.applyReviewBtn.disabled = true;
  els.genNotesSection.style.display = 'none';
  els.genNotesOutput.value = '';
  els.genChatHistory.innerHTML = '';
  genChatMessages = [];
  persistDraftState(true);

  let rawOutput = '';
  try {
    const model = requireConfiguredConnection(getGeneratorModelId(), 'Generator');
    const mock = els.mockMode.checked;
    let library = [];
    let previouslySubmitted = '';
    if (!mock) {
      await ensureLibraryContents(); // loads file names for company matching
      const info = await extractJdInfo();
      const sameCompanyFiles = findSameCompanyFiles(info.company);
      previouslySubmitted = buildPreviouslySubmitted(sameCompanyFiles);
      if (sameCompanyFiles.length > 0) showSameCompanyHint(info.company, sameCompanyFiles.length);
      else hideSameCompanyHint();
      // Use digest: server-side reading + paragraph dedup + disk cache
      const excludeNames = [els.baseResumeSelect.value, ...sameCompanyFiles.map(f => f.name)].filter(Boolean);
      const dir = els.libraryPath.value.trim();
      if (dir) {
        els.resumeStatusAndToken.textContent = '正在预处理素材库...';
        persistDraftState();
        const { digest } = await api.getLibraryDigest(dir, excludeNames);
        library = digest;
      }
    } else {
      hideSameCompanyHint();
    }
    rawOutput = await api.streamRequest('/api/generate', {
      model, mock,
      jd, baseResume: resume,
      resumeLibrary: library,
      instructions: els.genInstructions.value,
      generateCoverLetter: els.generateCoverLetter.checked,
      previouslySubmitted,
    }, (chunk, full) => {
      // During streaming, show full raw output
      els.resumeOutput.value = full;
      els.resumeOutput.scrollTop = els.resumeOutput.scrollHeight;
      persistDraftState();
    });

    // After streaming done, parse and separate
    const resOutput = rawOutput.text || rawOutput; // backward compat
    const { resumeBody, notes } = parseGeneratedOutput(resOutput);
    els.resumeOutput.value = resumeBody;

    if (notes) {
      els.genNotesOutput.value = notes;
      els.genNotesSection.style.display = '';
      els.genNotesSection.open = true;
    }
    persistDraftState(true);

    // Init generator chat context after generation
    genChatMessages = [
      { role: 'user', content: `请根据JD和简历素材生成简历。\n\nJD:\n${jd}\n\n基础简历:\n${resume}` },
      { role: 'assistant', content: resOutput },
    ];

    // Display token usage
    if (rawOutput.usage && els.resumeStatusAndToken) {
      els.resumeStatusAndToken.textContent = formatUsage(rawOutput.usage, model);
      sessionUsage.totalInput += (rawOutput.usage.input || 0);
      sessionUsage.totalOutput += (rawOutput.usage.output || 0);
      const pricing = PRICING[model] || { input: 0, output: 0 };
      sessionUsage.totalCost += (rawOutput.usage.input || 0) * pricing.input + (rawOutput.usage.output || 0) * pricing.output;
      updateSessionTotal();
    }

    els.resumeStatusAndToken.textContent = '生成完成，正在自动保存...';
    els.saveResumeBtn.disabled = false;
    els.generateHtmlBtn.disabled = false;
    persistDraftState(true);

    // Auto-save to library (save only resume body, not notes)
    await autoSaveToLibrary();
  } catch (e) {
    els.resumeStatusAndToken.textContent = '生成失败: ' + e.message;
    persistDraftState(true);
  }
  isStreaming = false;
  updateGenerateBtn();
}

/* ── Auto-save generated resume to library ── */
async function autoSaveToLibrary() {
  const dir = els.libraryPath.value.trim();
  if (!dir || !els.resumeOutput.value.trim()) return;
  try {
    const info = await extractJdInfo();
    const filename = buildFilename(info, 'resume');
    await api.saveFile(dir + '/' + filename, els.resumeOutput.value);
    els.resumeStatusAndToken.textContent = `已自动保存: ${filename}`;
    persistDraftState(true);
    // Append new file to library contents cache (incremental, no full reset)
    resumeLibraryContents.push({ name: filename, content: els.resumeOutput.value });
    loadLibrary(true);
  } catch (e) {
    els.resumeStatusAndToken.textContent = `生成完成（自动保存失败: ${e.message}）`;
    persistDraftState(true);
  }
}
/* ── Save ── */
async function showSaveDialog() {
  const info = await extractJdInfo();
  let filename = buildFilename(info, 'resume');
  // If company is missing, prompt user
  if (!info.company) {
    const company = prompt('请输入公司名称（用于文件命名）：');
    if (company) {
      info.company = company;
      filename = buildFilename(info, 'resume');
    }
  }
  els.saveFilename.value = filename;
  els.saveFilenameRow.style.display = 'flex';
}

async function doSave() {
  const dir = els.libraryPath.value.trim();
  const name = els.saveFilename.value.trim();
  if (!dir || !name) return alert('请确认文件名和素材库路径');
  const filePath = dir + '/' + name;
  try {
    await api.saveFile(filePath, els.resumeOutput.value);
    els.saveFilenameRow.style.display = 'none';
    els.resumeStatusAndToken.textContent = `已保存到: ${filePath}`;
    persistDraftState(true);
    // Append new file to library contents cache (incremental, no full reset)
    resumeLibraryContents.push({ name, content: els.resumeOutput.value });
    loadLibrary(true);
  } catch (e) {
    alert('保存失败: ' + e.message);
  }
}

/* ── Review ── */
async function doReview() {
  const resume = els.resumeOutput.value.trim();
  if (!resume) return alert('请先生成简历');

  isStreaming = true;
  els.reviewBtn.disabled = true;
  els.applyReviewBtn.disabled = true;
  els.reviewOutput.value = '';
  els.reviewStatusAndToken.textContent = 'Review 中...';
  persistDraftState(true);

  try {
    const reviewerModels = getReviewerModelIds();
    requireConfiguredConnection(reviewerModels[0], 'Reviewer');
    const mock = els.mockMode.checked;
    let library = [];
    let previouslySubmitted = '';
    if (!mock) {
      await ensureLibraryContents(); // loads file names for company matching
      const info = await extractJdInfo();
      const sameCompanyFiles = findSameCompanyFiles(info.company);
      previouslySubmitted = buildPreviouslySubmitted(sameCompanyFiles);
      // Use digest for library
      const dir = els.libraryPath.value.trim();
      if (dir) {
        els.reviewStatusAndToken.textContent = '正在预处理素材库...';
        persistDraftState();
        const { digest } = await api.getLibraryDigest(dir, []);
        library = digest;
      }
    }
    const reviewPayload = {
      mock,
      jd: getNormalizedJdText(),
      baseResume: baseResumeContent || els.manualResumeInput.value,
      updatedResume: resume,
      resumeLibrary: library,
      instructions: els.genInstructions.value,
      reviewInstructions: els.reviewInstructions.value,
      previouslySubmitted,
    };

    let result;
    if (reviewerModels.length > 1) {
      // Multi-reviewer: parallel review + merge
      result = await api.streamRequest('/api/review-multi', {
        ...reviewPayload,
        models: reviewerModels,
        orchestratorModel: requireConfiguredConnection(getReviewCoordinatorModelId(), 'Reviewer'),
      }, (chunk, full) => {
        els.reviewOutput.value = full;
        els.reviewOutput.scrollTop = els.reviewOutput.scrollHeight;
        persistDraftState();
      });
    } else {
      // Single reviewer
      result = await api.streamRequest('/api/review', {
        ...reviewPayload,
        model: reviewerModels[0],
      }, (chunk, full) => {
        els.reviewOutput.value = full;
        els.reviewOutput.scrollTop = els.reviewOutput.scrollHeight;
        persistDraftState();
      });
    }

    chatMessages = [
      { role: 'user', content: `请对以下简历进行评审：\n\nJD:\n${getNormalizedJdText()}\n\n简历:\n${resume}` },
      { role: 'assistant', content: result.text || result },
    ];

    // Display token usage
    if (result.usage && els.reviewStatusAndToken) {
      els.reviewStatusAndToken.textContent = formatUsage(result.usage, result.model);
      sessionUsage.totalInput += (result.usage.input || 0);
      sessionUsage.totalOutput += (result.usage.output || 0);
      const pricing = PRICING[result.model] || { input: 0, output: 0 };
      sessionUsage.totalCost += (result.usage.input || 0) * pricing.input + (result.usage.output || 0) * pricing.output;
      updateSessionTotal();
    }

    els.reviewStatusAndToken.textContent = 'Review 完成';
    els.applyReviewBtn.disabled = false;
    persistDraftState(true);
  } catch (e) {
    els.reviewStatusAndToken.textContent = 'Review 失败: ' + e.message;
    persistDraftState(true);
  }
  isStreaming = false;
  els.reviewBtn.disabled = false;
}

/* ── Apply Review: diff mode with fallback ── */

/**
 * Parse AI's diff output into an array of {old, new} replacement pairs.
 * Tolerates many variations: extra whitespace, newlines, formatting differences.
 */
function parseDiffOutput(text) {
  const diffs = [];

  // Strategy 1: Strict format with newlines
  let strict = /\[REPLACE\]\s*\n<<<\n([\s\S]*?)\n>>>\n([\s\S]*?)\n\[\/REPLACE\]/g;
  let match;
  while ((match = strict.exec(text)) !== null) {
    const old = match[1].trim();
    const newText = match[2].trim();
    if (old) diffs.push({ old, new: newText });
  }
  if (diffs.length > 0) return diffs;

  // Strategy 2: Lenient format (flexible whitespace/newlines)
  let lenient = /\[REPLACE\]\s*<<<\s*([\s\S]*?)\s*>>>\s*([\s\S]*?)\s*\[\/REPLACE\]/g;
  while ((match = lenient.exec(text)) !== null) {
    const old = match[1].trim();
    const newText = match[2].trim();
    if (old) diffs.push({ old, new: newText });
  }
  if (diffs.length > 0) return diffs;

  // Strategy 3: Alternative delimiters (<<<< and >>>>)
  let alt = /\[REPLACE\]\s*<<<<\s*([\s\S]*?)\s*>>>>\s*([\s\S]*?)\s*\[\/REPLACE\]/g;
  while ((match = alt.exec(text)) !== null) {
    const old = match[1].trim();
    const newText = match[2].trim();
    if (old) diffs.push({ old, new: newText });
  }

  return diffs;
}

/**
 * Apply diffs to the resume text. Returns { result, applied, failed }.
 * Tries exact match first, then trimmed, then whitespace-normalized.
 */
function applyDiffs(resume, diffs) {
  let result = resume;
  let applied = 0;
  let failed = 0;
  for (const d of diffs) {
    if (result.includes(d.old)) {
      result = result.replace(d.old, d.new);
      applied++;
    } else {
      // Fuzzy 1: trim whitespace and try again
      const trimOld = d.old.trim();
      if (trimOld && result.includes(trimOld)) {
        result = result.replace(trimOld, d.new.trim());
        applied++;
      } else {
        // Fuzzy 2: normalize internal whitespace (collapse multiple spaces/newlines)
        const normalizeWs = s => s.replace(/\s+/g, ' ').trim();
        const normalizedOld = normalizeWs(d.old);
        // Find a matching region in the resume by normalizing each candidate
        const lines = result.split('\n');
        let found = false;
        for (let i = 0; i < lines.length && !found; i++) {
          for (let j = i + 1; j <= Math.min(i + 10, lines.length) && !found; j++) {
            const candidate = lines.slice(i, j).join('\n');
            if (normalizeWs(candidate) === normalizedOld) {
              result = result.replace(candidate, d.new.trim());
              applied++;
              found = true;
            }
          }
        }
        if (!found) failed++;
      }
    }
  }
  return { result, applied, failed };
}

async function doApplyReview() {
  const reviewComments = els.reviewOutput.value.trim();
  const currentResume = els.resumeOutput.value.trim();
  if (!reviewComments || !currentResume) return alert('请先完成Review');

  isStreaming = true;
  els.applyReviewBtn.disabled = true;
  els.resumeOutput.value = '';
  els.resumeStatusAndToken.textContent = '根据Review意见更新简历中（diff模式）...';
  persistDraftState(true);

  try {
    const model = requireConfiguredConnection(getGeneratorModelId(), 'Generator');
    const mock = els.mockMode.checked;
    let previouslySubmitted = '';
    if (!mock) {
      await ensureLibraryContents();
      const info = await extractJdInfo();
      const sameCompanyFiles = findSameCompanyFiles(info.company);
      previouslySubmitted = buildPreviouslySubmitted(sameCompanyFiles);
    }

    // Step 1: Try diff mode
    const diffOutput = await api.streamRequest('/api/apply-review', {
      model, mock,
      currentResume,
      reviewComments,
      jd: getNormalizedJdText(),
      previouslySubmitted,
      instructions: els.genInstructions.value,
    }, (chunk, full) => {
      els.resumeOutput.value = full;
      els.resumeOutput.scrollTop = els.resumeOutput.scrollHeight;
      persistDraftState();
    });

    // Display token usage
    if (diffOutput.usage && els.resumeStatusAndToken) {
      els.resumeStatusAndToken.textContent = formatUsage(diffOutput.usage, model);
      sessionUsage.totalInput += (diffOutput.usage.input || 0);
      sessionUsage.totalOutput += (diffOutput.usage.output || 0);
      const pricing = PRICING[model] || { input: 0, output: 0 };
      sessionUsage.totalCost += (diffOutput.usage.input || 0) * pricing.input + (diffOutput.usage.output || 0) * pricing.output;
      updateSessionTotal();
    }

    const diffs = parseDiffOutput(diffOutput.text || diffOutput);

    if (diffs.length > 0) {
      // Apply diffs to the original resume
      const { result, applied, failed } = applyDiffs(currentResume, diffs);
      els.resumeOutput.value = result;
      persistDraftState(true);

      if (failed > 0) {
        els.resumeStatusAndToken.textContent = `已应用 ${applied}/${diffs.length} 处修改（${failed} 处无法匹配）`;
      } else {
        els.resumeStatusAndToken.textContent = `已应用 ${applied} 处修改，正在自动保存...`;
      }
      els.saveResumeBtn.disabled = false;
      els.generateHtmlBtn.disabled = false;
      persistDraftState(true);
      await autoSaveToLibrary();
    } else {
      // Fallback: diff parsing failed, use full regeneration
      els.resumeStatusAndToken.textContent = 'Diff模式未生效，回退到全量重生成...';
      els.resumeOutput.value = '';
      persistDraftState(true);

      let library = [];
      if (!mock) {
        const dir = els.libraryPath.value.trim();
        if (dir) {
          const { digest } = await api.getLibraryDigest(dir, []);
          library = digest;
        }
      }
      const instructions = els.genInstructions.value + `\n\n===== 重要提示 =====\n以下是用户手动编辑后的当前简历版本。你必须在此版本基础上，仅根据Review意见进行微调。保留用户已做的所有手动编辑，不要从头重新生成简历。\n\n===== Review 修改意见（仅据此微调，不要重写）=====\n${reviewComments}`;

      const rawOutput = await api.streamRequest('/api/generate', {
        model, mock,
        jd: getNormalizedJdText(),
        baseResume: currentResume,
        resumeLibrary: library,
        instructions,
        generateCoverLetter: els.generateCoverLetter.checked,
        previouslySubmitted,
        generateNotes: false,
      }, (chunk, full) => {
        els.resumeOutput.value = full;
        els.resumeOutput.scrollTop = els.resumeOutput.scrollHeight;
        persistDraftState();
      });

      // Display token usage
      if (rawOutput.usage && els.resumeStatusAndToken) {
        els.resumeStatusAndToken.textContent = formatUsage(rawOutput.usage, model);
        sessionUsage.totalInput += (rawOutput.usage.input || 0);
        sessionUsage.totalOutput += (rawOutput.usage.output || 0);
        const pricing = PRICING[model] || { input: 0, output: 0 };
        sessionUsage.totalCost += (rawOutput.usage.input || 0) * pricing.input + (rawOutput.usage.output || 0) * pricing.output;
        updateSessionTotal();
      }

      const { resumeBody } = parseGeneratedOutput(rawOutput.text || rawOutput);
      els.resumeOutput.value = resumeBody;

      els.resumeStatusAndToken.textContent = '更新完成（全量重生成），正在自动保存...';
      els.saveResumeBtn.disabled = false;
      els.generateHtmlBtn.disabled = false;
      persistDraftState(true);
      await autoSaveToLibrary();
    }

    // Update genChat context with the new resume
    const updatedResume = els.resumeOutput.value;
    genChatMessages = [
      { role: 'user', content: `请根据JD和简历素材生成简历。\n\nJD:\n${getNormalizedJdText()}\n\n基础简历:\n${currentResume}` },
      { role: 'assistant', content: updatedResume },
    ];
  } catch (e) {
    els.resumeStatusAndToken.textContent = '更新失败: ' + e.message;
    persistDraftState(true);
  }
  isStreaming = false;
  els.applyReviewBtn.disabled = false;
  updateGenerateBtn();
}

/* ── Generator Chat ── */
async function doGenChat() {
  const msg = els.genChatInput.value.trim();
  if (!msg || isStreaming) return;

  genChatMessages.push({ role: 'user', content: msg });
  appendGenChatBubble('user', msg);
  els.genChatInput.value = '';

  isStreaming = true;
  els.genChatSendBtn.disabled = true;
  const aiDiv = appendGenChatBubble('ai', '思考中...');
  aiDiv.classList.add('loading');

  try {
    const model = requireConfiguredConnection(getGeneratorModelId(), 'Generator');
    const result = await api.streamRequest('/api/chat', {
      model, mock: els.mockMode.checked,
      messages: truncateHistory(genChatMessages),
      chatType: 'generator',
    }, (chunk, full) => {
      aiDiv.classList.remove('loading');
      aiDiv.textContent = full;
      els.genChatHistory.scrollTop = els.genChatHistory.scrollHeight;
    });
    genChatMessages.push({ role: 'assistant', content: result.text || result });

    // Display token usage
    if (result.usage && els.resumeStatusAndToken) {
      els.resumeStatusAndToken.textContent = formatUsage(result.usage, result.model || model);
      sessionUsage.totalInput += (result.usage.input || 0);
      sessionUsage.totalOutput += (result.usage.output || 0);
      const pricing = PRICING[result.model || model] || { input: 0, output: 0 };
      sessionUsage.totalCost += (result.usage.input || 0) * pricing.input + (result.usage.output || 0) * pricing.output;
      updateSessionTotal();
    }

    // If AI returned updated resume content, sync to resume editing area
    const { resumeBody, notes } = parseGeneratedOutput(result.text || result);
    if ((result.text || result).includes('简历正文') && resumeBody) {
      els.resumeOutput.value = resumeBody;
      if (notes) els.genNotesOutput.value = notes;
      els.resumeStatusAndToken.textContent = '简历已根据对话更新';
      persistDraftState(true);
    } else if (looksLikeResume(result.text || result)) {
      els.resumeOutput.value = result;
      els.resumeStatusAndToken.textContent = '简历已根据对话更新（请检查内容）';
      persistDraftState(true);
    }
  } catch (e) {
    aiDiv.textContent = '错误: ' + e.message;
  }
  isStreaming = false;
  els.genChatSendBtn.disabled = false;
}

function appendGenChatBubble(role, text) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  els.genChatHistory.appendChild(div);
  els.genChatHistory.scrollTop = els.genChatHistory.scrollHeight;
  return div;
}

/* ── Review Chat ── */
async function doChat() {
  const msg = els.chatInput.value.trim();
  if (!msg || isStreaming) return;

  chatMessages.push({ role: 'user', content: msg });
  appendChatBubble('user', msg);
  els.chatInput.value = '';

  isStreaming = true;
  els.chatSendBtn.disabled = true;
  const aiDiv = appendChatBubble('ai', '思考中...');
  aiDiv.classList.add('loading');

  try {
    const model = requireConfiguredConnection(getReviewCoordinatorModelId(), 'Reviewer');
    const result = await api.streamRequest('/api/chat', {
      model, mock: els.mockMode.checked,
      messages: truncateHistory(chatMessages),
      chatType: 'review',
    }, (chunk, full) => {
      aiDiv.classList.remove('loading');
      aiDiv.textContent = full;
      els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    });
    chatMessages.push({ role: 'assistant', content: result.text || result });

    // Display token usage
    if (result.usage && els.reviewStatusAndToken) {
      els.reviewStatusAndToken.textContent = formatUsage(result.usage, result.model || model);
      sessionUsage.totalInput += (result.usage.input || 0);
      sessionUsage.totalOutput += (result.usage.output || 0);
      const pricing = PRICING[result.model || model] || { input: 0, output: 0 };
      sessionUsage.totalCost += (result.usage.input || 0) * pricing.input + (result.usage.output || 0) * pricing.output;
      updateSessionTotal();
    }

    // If AI returned updated review, sync to review output area
    if (looksLikeReview(result.text || result)) {
      els.reviewOutput.value = result.text || result;
      els.reviewStatusAndToken.textContent = '评审已根据对话更新';
      persistDraftState(true);
    }
  } catch (e) {
    aiDiv.textContent = '错误: ' + e.message;
  }
  isStreaming = false;
  els.chatSendBtn.disabled = false;
}

function appendChatBubble(role, text) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  els.chatHistory.appendChild(div);
  els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
  return div;
}

/* ── HTML Generation ── */
async function doGenerateHtml() {
  const resume = els.resumeOutput.value.trim();
  if (!resume) return alert('请先完成简历编辑');

  isStreaming = true;
  els.generateHtmlBtn.disabled = true;
  els.htmlStatus.textContent = '生成 HTML 中...';
  els.htmlStatus.className = 'status-text';
  if (els.htmlTokenInfo) els.htmlTokenInfo.textContent = '';

  let htmlContent = '';
  try {
    const model = requireConfiguredConnection(getHtmlModelId(), 'Format Converter');
    let result = await api.streamRequest('/api/generate-html', {
      model, mock: els.mockMode.checked,
      resumeText: resume,
      htmlInstructions: els.htmlInstructions.value,
    }, (chunk, full) => { htmlContent = full; });

    // Extract and clean body content from result
    let bodyContent = result.text || result;
    bodyContent = bodyContent.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // Display token usage
    if (result.usage && els.htmlTokenInfo) {
      els.htmlTokenInfo.textContent = formatUsage(result.usage, model);
      sessionUsage.totalInput += (result.usage.input || 0);
      sessionUsage.totalOutput += (result.usage.output || 0);
      const pricing = PRICING[model] || { input: 0, output: 0 };
      sessionUsage.totalCost += (result.usage.input || 0) * pricing.input + (result.usage.output || 0) * pricing.output;
      updateSessionTotal();
    }

    // If AI returned full HTML despite instructions, extract just the body
    const bodyMatch = bodyContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      bodyContent = bodyMatch[1].trim();
    }
    // Strip any <html>, <head>, <style> tags AI might have included
    bodyContent = bodyContent.replace(/<\/?html[^>]*>/gi, '').replace(/<head>[\s\S]*?<\/head>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').trim();

    // Inject proper <title> for PDF filename
    const info = await extractJdInfo();
    const suggestedName = buildFilename(info, 'resume').replace(/\.txt$/, '.html');
    const pdfTitle = suggestedName.replace(/\.html$/, '');

    // Assemble full HTML document with pre-built CSS template
    const userCssOverrides = els.htmlInstructions.value.trim() ? `\n/* User CSS overrides */` : '';
    htmlContent = `<!DOCTYPE html>\n<html lang="${info.language || 'en'}">\n<head>\n<meta charset="UTF-8">\n<title>${pdfTitle}</title>\n<style>\n${HTML_CSS_TEMPLATE}${userCssOverrides}\n</style>\n</head>\n<body>\n${bodyContent}\n</body>\n</html>`;

    // Save HTML for chat context
    lastHtmlContent = htmlContent;

    // Pop up native print dialog for direct PDF generation
    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = 'none';
    document.body.appendChild(iframe);
    
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(htmlContent);
    doc.close();

    // Wait for layout/fonts to load and trigger print
    setTimeout(() => {
      // Hijack main document title so native print dialog uses it as PDF filename
      const originalTitle = document.title;
      document.title = pdfTitle;
      
      iframe.contentWindow.focus();
      try {
        // Some browsers prefer execCommand for iframes
        iframe.contentWindow.document.execCommand('print', false, null);
      } catch (e) {
        iframe.contentWindow.print();
      }
      
      // Restore title after print dialog closes (or when event loop frees up)
      setTimeout(() => {
        document.title = originalTitle;
      }, 2000);
      
      setTimeout(() => document.body.removeChild(iframe), 60000); // Cleanup later
    }, 500);

    els.htmlStatus.textContent = '完成，已弹出保存为PDF的窗口';
    els.htmlStatus.className = 'status-text success';

    // Show "Open PDF" button
    console.log('Showing openPdfBtn');
    console.log('Button element exists:', els.openPdfBtn !== null);
    console.log('Button style before:', els.openPdfBtn.style.display);
    els.openPdfBtn.style.display = 'inline-flex';
    console.log('Button style after:', els.openPdfBtn.style.display);

    // Show HTML chat section and init context in case user wants AI fixes
    els.htmlChatSection.style.display = '';
    htmlChatMessages = [
      { role: 'user', content: `请把以下简历生成HTML格式。\n\n简历文本:\n${resume}` },
      { role: 'assistant', content: bodyContent },
    ];
  } catch (e) {
    console.error(e);
    els.htmlStatus.textContent = '生成失败: ' + e.message;
    els.htmlStatus.className = 'status-text error';
  } finally {
    isStreaming = false;
    updateGenerateBtn();
  }
}

/* ── HTML Chat (debug layout issues) ── */
async function handlePdfUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    els.htmlUploadStatus.textContent = '文件过大（限10MB）';
    els.htmlUploadStatus.className = 'status-text error';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    uploadedFileData = { mimeType: file.type, data: base64, name: file.name };
    els.htmlUploadStatus.textContent = `已选择: ${file.name}`;
    els.htmlUploadStatus.className = 'status-text success';
  };
  reader.readAsDataURL(file);
}

async function doHtmlChat() {
  const msg = els.htmlChatInput.value.trim();
  if ((!msg && !uploadedFileData) || isStreaming) return;

  // Build message content
  const displayText = uploadedFileData ? `[附件: ${uploadedFileData.name}] ${msg}` : msg;
  let messageContent;
  if (uploadedFileData) {
    messageContent = [
      { type: 'file', mimeType: uploadedFileData.mimeType, data: uploadedFileData.data },
      { type: 'text', text: msg || '请查看这个PDF，指出排版问题并给出修复后的完整HTML。' },
    ];
  } else {
    messageContent = msg;
  }

  htmlChatMessages.push({ role: 'user', content: messageContent });
  appendHtmlChatBubble('user', displayText);
  els.htmlChatInput.value = '';
  uploadedFileData = null;
  els.htmlUploadStatus.textContent = '';
  els.htmlPdfUpload.value = '';

  isStreaming = true;
  els.htmlChatSendBtn.disabled = true;
  const aiDiv = appendHtmlChatBubble('ai', '思考中...');
  aiDiv.classList.add('loading');

  try {
    const model = requireConfiguredConnection(getHtmlModelId(), 'Format Converter');
    const result = await api.streamRequest('/api/chat', {
      model, mock: els.mockMode.checked,
      messages: truncateHistory(htmlChatMessages),
      chatType: 'html',
    }, (chunk, full) => {
      aiDiv.classList.remove('loading');
      aiDiv.textContent = full;
      els.htmlChatHistory.scrollTop = els.htmlChatHistory.scrollHeight;
    });
    htmlChatMessages.push({ role: 'assistant', content: result.text || result });

    // Display token usage
    if (result.usage && els.htmlTokenInfo) {
      els.htmlTokenInfo.textContent = formatUsage(result.usage, model);
      sessionUsage.totalInput += (result.usage.input || 0);
      sessionUsage.totalOutput += (result.usage.output || 0);
      const pricing = PRICING[model] || { input: 0, output: 0 };
      sessionUsage.totalCost += (result.usage.input || 0) * pricing.input + (result.usage.output || 0) * pricing.output;
      updateSessionTotal();
    }

    // If AI returned HTML, offer to download updated version
    if ((result.text || result).includes('<!DOCTYPE') || (result.text || result).includes('<html')) {
      let newHtml = (result.text || result).replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      // Extract HTML if mixed with text
      const htmlStart = newHtml.indexOf('<!DOCTYPE');
      const htmlStartAlt = newHtml.indexOf('<html');
      const start = htmlStart !== -1 ? htmlStart : htmlStartAlt;
      if (start > 0) newHtml = newHtml.slice(start);
      const htmlEnd = newHtml.lastIndexOf('</html>');
      if (htmlEnd !== -1) newHtml = newHtml.slice(0, htmlEnd + 7);

      // Inject proper title
      const info = await extractJdInfo();
      const pdfTitle = buildFilename(info, 'resume').replace(/\.txt$/, '');
      newHtml = newHtml.replace(/<title>[^<]*<\/title>/i, `<title>${pdfTitle}</title>`);

      lastHtmlContent = newHtml;
      const suggestedName = pdfTitle + '.html';
      const blob = new Blob([newHtml], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = suggestedName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      els.htmlStatus.textContent = `更新版 HTML 已下载: ${suggestedName}`;
      els.htmlStatus.className = 'status-text success';
    }
  } catch (e) {
    aiDiv.classList.remove('loading');
    aiDiv.textContent = '错误: ' + e.message;
  }
  isStreaming = false;
  els.htmlChatSendBtn.disabled = false;
}

function appendHtmlChatBubble(role, text) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  els.htmlChatHistory.appendChild(div);
  els.htmlChatHistory.scrollTop = els.htmlChatHistory.scrollHeight;
  return div;
}

/* ── Open PDF Function ── */
function handleOpenPdf(e) {
  e.preventDefault();
  e.stopPropagation();
  
  const file = e.target.files?.[0];
  if (!file) return;
  
  // Check if file is a PDF
  if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('请选择一个PDF文件');
    return;
  }
  
  // Create object URL for the PDF file
  const url = URL.createObjectURL(file);
  
  console.log('File selected, waiting for file chooser to close...');
  
  // Use setTimeout to ensure file chooser is fully closed before window.open()
  setTimeout(() => {
    console.log('Opening PDF in new tab...');
    // Open the PDF directly in a new tab
    const win = window.open(url, '_blank');
    if (!win) {
      console.warn('window.open() blocked by browser - trying alternative method');
      // Fallback: create a hidden anchor element
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 5000);
    } else {
      // Clean up after 10 seconds (enough time for browser to open the PDF)
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 10000);
    }
  }, 100);
  
  // Reset file input to allow selecting the same file again
  e.target.value = '';
}

/* ── Start ── */
init();
