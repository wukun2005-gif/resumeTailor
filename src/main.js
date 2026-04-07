import * as state from './state.js';
import * as api from './api.js';

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
  jdInput: $('jdInput'), libraryPath: $('libraryPath'), browseLibraryBtn: $('browseLibraryBtn'), loadLibraryBtn: $('loadLibraryBtn'), baseResumeSelect: $('baseResumeSelect'),
  manualResumeRow: $('manualResumeRow'), manualResumeInput: $('manualResumeInput'),
  genInstructions: $('genInstructions'), htmlInstructions: $('htmlInstructions'), generateCoverLetter: $('generateCoverLetter'),
  generateBtn: $('generateBtn'), outputSection: $('outputSection'),
  resumeOutput: $('resumeOutput'), resumeStatus: $('resumeStatus'),
  saveResumeBtn: $('saveResumeBtn'), regenerateBtn: $('regenerateBtn'),
  saveFilenameRow: $('saveFilenameRow'), saveFilename: $('saveFilename'), confirmSaveBtn: $('confirmSaveBtn'), cancelSaveBtn: $('cancelSaveBtn'),
  reviewBtn: $('reviewBtn'), reviewOutput: $('reviewOutput'), reviewStatus: $('reviewStatus'),
  applyReviewBtn: $('applyReviewBtn'),
  chatHistory: $('chatHistory'), chatInput: $('chatInput'), chatSendBtn: $('chatSendBtn'),
  genNotesSection: $('genNotesSection'), genNotesOutput: $('genNotesOutput'),
  genChatSection: $('genChatSection'), genChatHistory: $('genChatHistory'), genChatInput: $('genChatInput'), genChatSendBtn: $('genChatSendBtn'),
  generateHtmlBtn: $('generateHtmlBtn'), htmlStatus: $('htmlStatus'),
  htmlChatSection: $('htmlChatSection'), htmlChatHistory: $('htmlChatHistory'), htmlChatInput: $('htmlChatInput'), htmlChatSendBtn: $('htmlChatSendBtn'),
  htmlPdfUpload: $('htmlPdfUpload'), htmlUploadStatus: $('htmlUploadStatus'),
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

function populateAgentDropdowns() {
  const configured = getConfiguredConnections();
  const options = configured.map(c =>
    `<option value="${c.id}">${c.label} (${getConnInput(c.id, 'model')?.value || c.defaultModel || c.family})</option>`
  ).join('');
  const emptyOption = '<option value="">— 未配置 —</option>';

  // Dropdowns (orchestrator, generator, html)
  for (const sel of [els.cfgAgentOrchestrator, els.cfgAgentGenerator, els.cfgAgentHtml]) {
    const prev = sel.value;
    sel.innerHTML = emptyOption + options;
    if (prev && configured.some(c => c.id === prev)) sel.value = prev;
  }

  // Reviewer checkboxes (multi-select)
  const prevReviewers = getSelectedReviewers();
  els.cfgAgentReviewers.innerHTML = configured.map(c =>
    `<label class="checkbox-label"><input type="checkbox" value="${c.id}" ${prevReviewers.includes(c.id) ? 'checked' : ''}> ${c.label}</label>`
  ).join('');
}

function getSelectedReviewers() {
  return [...els.cfgAgentReviewers.querySelectorAll('input:checked')].map(cb => cb.value);
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

async function autoInitAPI() {
  const connections = buildModelConnections();
  if (connections.length === 0) return;
  try {
    const allowedPaths = ['/Users/wukun/Documents/tmp/resumeTailor/vscCCOpus'];
    const libPath = els.libraryPath.value.trim();
    if (libPath) allowedPaths.push(libPath);
    await api.initAPI({ modelConnections: connections, allowedPaths });
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
  els.htmlInstructions.value = state.get('htmlInstructions');
  els.mockMode.checked = state.get('mockMode', false);
}

function restoreAgentAssignments() {
  // Migrate old model IDs to new connection IDs
  const migrateId = id => {
    if (id === 'opus') return 'jiekou-anthropic';
    if (id === 'gemini') return 'google-studio-google';
    return id;
  };

  const orch = migrateId(state.get('orchestratorModel', 'jiekou-anthropic'));
  const gen = migrateId(state.get('generatorModel', 'jiekou-anthropic'));
  const html = migrateId(state.get('htmlModel', 'google-studio-google'));
  const reviewers = (state.get('reviewerModels', ['google-studio-google']) || []).map(migrateId);

  els.cfgAgentOrchestrator.value = orch;
  els.cfgAgentGenerator.value = gen;
  els.cfgAgentHtml.value = html;

  // Restore reviewer checkboxes
  for (const cb of els.cfgAgentReviewers.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = reviewers.includes(cb.value);
  }
}

function persistInputs() {
  state.set('libraryPath', els.libraryPath.value);
  state.set('genInstructions', els.genInstructions.value);
  state.set('htmlInstructions', els.htmlInstructions.value);
}

/* ── Events ── */
function bindEvents() {
  els.settingsBtn.addEventListener('click', () => els.settingsModal.classList.add('open'));
  els.settingsClose.addEventListener('click', () => els.settingsModal.classList.remove('open'));
  els.settingsModal.addEventListener('click', e => { if (e.target === els.settingsModal) els.settingsModal.classList.remove('open'); });
  els.settingsSave.addEventListener('click', saveSettings);
  els.browseLibraryBtn.addEventListener('click', browseLibrary);
  els.loadLibraryBtn.addEventListener('click', () => loadLibrary());
  els.baseResumeSelect.addEventListener('change', onBaseResumeChange);
  els.generateBtn.addEventListener('click', doGenerate);
  els.regenerateBtn.addEventListener('click', doGenerate);
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
  els.mockMode.addEventListener('change', () => state.set('mockMode', els.mockMode.checked));
  // Update agent dropdowns when connection keys change
  for (const def of MODEL_CONNECTIONS) {
    const keyInput = getConnInput(def.id, 'key');
    if (keyInput) keyInput.addEventListener('input', populateAgentDropdowns);
    const modelInput = getConnInput(def.id, 'model');
    if (modelInput) modelInput.addEventListener('input', populateAgentDropdowns);
  }
  els.jdInput.addEventListener('input', () => { jdInfo = null; updateGenerateBtn(); });
  els.resumeOutput.addEventListener('input', onResumeEdited);
  els.genInstructions.addEventListener('change', persistInputs);
  els.htmlInstructions.addEventListener('change', persistInputs);
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
  const hasJD = els.jdInput.value.trim().length > 0;
  els.generateBtn.disabled = !hasJD || isStreaming;
  els.generateHtmlBtn.disabled = !els.resumeOutput.value.trim() || isStreaming;
  els.reviewBtn.disabled = !els.resumeOutput.value.trim() || isStreaming;
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

  // Save agent assignments
  state.set('orchestratorModel', els.cfgAgentOrchestrator.value);
  state.set('generatorModel', els.cfgAgentGenerator.value);
  const reviewerModels = getSelectedReviewers();
  if (reviewerModels.length === 0 && getConfiguredConnections().length > 0) {
    reviewerModels.push(getConfiguredConnections()[0].id);
  }
  state.set('reviewerModels', reviewerModels);
  state.set('htmlModel', els.cfgAgentHtml.value);

  // Update agent dropdowns with latest connections
  populateAgentDropdowns();
  restoreAgentAssignments();

  els.settingsStatus.textContent = '连接中...';
  els.settingsStatus.className = 'status-text';
  try {
    const allowedPaths = ['/Users/wukun/Documents/tmp/resumeTailor/vscCCOpus'];
    const libPath = els.libraryPath.value.trim();
    if (libPath) allowedPaths.push(libPath);
    const connections = buildModelConnections();

    const result = await api.initAPI({ modelConnections: connections, allowedPaths });
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

/* ── Library ── */
async function loadLibrary(silent = false) {
  const dir = els.libraryPath.value.trim();
  if (!dir) { if (!silent) alert('请输入素材库路径'); return; }
  state.set('libraryPath', dir);
  try {
    libraryFiles = await api.listFiles(dir);
    populateBaseResumeSelect();
    resumeLibraryContents = [];
    const readableCount = libraryFiles.filter(f => f.readable).length;
    if (!silent) {
      els.resumeStatus.textContent = `已加载 ${libraryFiles.length} 个文件（${readableCount} 个可读取）`;
    }
  } catch (e) {
    if (!silent) alert('加载失败: ' + e.message);
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
  onBaseResumeChange();
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
  const jd = els.jdInput.value.trim();
  if (!jd) return { company: '', department: '', title: '', language: 'en' };

  // Try local parsing first (saves ~1600 tokens)
  const local = tryLocalJdParse(jd);
  if (local) {
    jdInfo = local;
    return jdInfo;
  }

  try {
    const model = state.get('orchestratorModel', 'jiekou-anthropic');
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
  const jd = els.jdInput.value.trim();
  const resume = baseResumeContent || els.manualResumeInput.value.trim();
  if (!jd) return alert('请输入JD');
  if (!resume) return alert('请选择或输入基础简历');

  isStreaming = true;
  els.generateBtn.disabled = true;
  els.resumeOutput.value = '';
  els.resumeStatus.textContent = '生成中...';
  els.resumeStatus.className = 'status-bar loading';
  chatMessages = [];
  els.chatHistory.innerHTML = '';
  els.applyReviewBtn.disabled = true;
  els.genNotesSection.style.display = 'none';
  els.genNotesOutput.value = '';
  els.genChatHistory.innerHTML = '';
  genChatMessages = [];

  let rawOutput = '';
  try {
    const model = state.get('generatorModel', 'jiekou-anthropic');
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
        els.resumeStatus.textContent = '正在预处理素材库...';
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
    });

    // After streaming done, parse and separate
    const { resumeBody, notes } = parseGeneratedOutput(rawOutput);
    els.resumeOutput.value = resumeBody;

    if (notes) {
      els.genNotesOutput.value = notes;
      els.genNotesSection.style.display = '';
      els.genNotesSection.open = true;
    }

    // Init generator chat context after generation
    genChatMessages = [
      { role: 'user', content: `请根据JD和简历素材生成简历。\n\nJD:\n${jd}\n\n基础简历:\n${resume}` },
      { role: 'assistant', content: rawOutput },
    ];

    els.resumeStatus.textContent = '生成完成，正在自动保存...';
    els.resumeStatus.className = 'status-bar';
    els.saveResumeBtn.disabled = false;
    els.generateHtmlBtn.disabled = false;

    // Auto-save to library (save only resume body, not notes)
    await autoSaveToLibrary();
  } catch (e) {
    els.resumeStatus.textContent = '生成失败: ' + e.message;
    els.resumeStatus.className = 'status-bar';
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
    els.resumeStatus.textContent = `已自动保存: ${filename}`;
    els.resumeStatus.className = 'status-bar';
    // Append new file to library contents cache (incremental, no full reset)
    resumeLibraryContents.push({ name: filename, content: els.resumeOutput.value });
    loadLibrary(true);
  } catch (e) {
    els.resumeStatus.textContent = `生成完成（自动保存失败: ${e.message}）`;
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
    els.resumeStatus.textContent = `已保存到: ${filePath}`;
    els.resumeStatus.className = 'status-bar';
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
  els.reviewStatus.textContent = 'Review 中...';
  els.reviewStatus.className = 'status-bar loading';

  try {
    const reviewerModels = state.get('reviewerModels', ['google-studio-google']);
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
        els.reviewStatus.textContent = '正在预处理素材库...';
        const { digest } = await api.getLibraryDigest(dir, []);
        library = digest;
      }
    }
    const reviewPayload = {
      mock,
      jd: els.jdInput.value,
      baseResume: baseResumeContent || els.manualResumeInput.value,
      updatedResume: resume,
      resumeLibrary: library,
      instructions: els.genInstructions.value,
      previouslySubmitted,
    };

    let result;
    if (reviewerModels.length > 1) {
      // Multi-reviewer: parallel review + merge
      result = await api.streamRequest('/api/review-multi', {
        ...reviewPayload,
        models: reviewerModels,
        orchestratorModel: state.get('orchestratorModel', 'jiekou-anthropic'),
      }, (chunk, full) => {
        els.reviewOutput.value = full;
        els.reviewOutput.scrollTop = els.reviewOutput.scrollHeight;
      });
    } else {
      // Single reviewer
      result = await api.streamRequest('/api/review', {
        ...reviewPayload,
        model: reviewerModels[0],
      }, (chunk, full) => {
        els.reviewOutput.value = full;
        els.reviewOutput.scrollTop = els.reviewOutput.scrollHeight;
      });
    }

    chatMessages = [
      { role: 'user', content: `请对以下简历进行评审：\n\nJD:\n${els.jdInput.value}\n\n简历:\n${resume}` },
      { role: 'assistant', content: result },
    ];
    els.reviewStatus.textContent = 'Review 完成';
    els.reviewStatus.className = 'status-bar';
    els.applyReviewBtn.disabled = false;
  } catch (e) {
    els.reviewStatus.textContent = 'Review 失败: ' + e.message;
    els.reviewStatus.className = 'status-bar';
  }
  isStreaming = false;
  els.reviewBtn.disabled = false;
}

/* ── Apply Review: diff mode with fallback ── */

/**
 * Parse AI's diff output into an array of {old, new} replacement pairs.
 * Format: [REPLACE]<<<old text>>>new text[/REPLACE]
 */
function parseDiffOutput(text) {
  const diffs = [];
  const regex = /\[REPLACE\]\s*\n<<<\n([\s\S]*?)\n>>>\n([\s\S]*?)\n\[\/REPLACE\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    diffs.push({ old: match[1], new: match[2] });
  }
  return diffs;
}

/**
 * Apply diffs to the resume text. Returns { result, applied, failed }.
 * Tries exact match first, then trimmed match.
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
      // Fuzzy: trim whitespace and try again
      const trimOld = d.old.trim();
      if (trimOld && result.includes(trimOld)) {
        result = result.replace(trimOld, d.new.trim());
        applied++;
      } else {
        failed++;
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
  els.resumeStatus.textContent = '根据Review意见更新简历中（diff模式）...';
  els.resumeStatus.className = 'status-bar loading';

  try {
    const model = state.get('generatorModel', 'jiekou-anthropic');
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
      jd: els.jdInput.value,
      previouslySubmitted,
    }, (chunk, full) => {
      els.resumeOutput.value = full;
      els.resumeOutput.scrollTop = els.resumeOutput.scrollHeight;
    });

    const diffs = parseDiffOutput(diffOutput);

    if (diffs.length > 0) {
      // Apply diffs to the original resume
      const { result, applied, failed } = applyDiffs(currentResume, diffs);
      els.resumeOutput.value = result;

      if (failed > 0) {
        els.resumeStatus.textContent = `已应用 ${applied}/${diffs.length} 处修改（${failed} 处无法匹配）`;
      } else {
        els.resumeStatus.textContent = `已应用 ${applied} 处修改，正在自动保存...`;
      }
      els.resumeStatus.className = 'status-bar';
      els.saveResumeBtn.disabled = false;
      els.generateHtmlBtn.disabled = false;
      await autoSaveToLibrary();
    } else {
      // Fallback: diff parsing failed, use full regeneration
      els.resumeStatus.textContent = 'Diff模式未生效，回退到全量重生成...';
      els.resumeOutput.value = '';

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
        jd: els.jdInput.value,
        baseResume: currentResume,
        resumeLibrary: library,
        instructions,
        generateCoverLetter: els.generateCoverLetter.checked,
        previouslySubmitted,
        generateNotes: false,
      }, (chunk, full) => {
        els.resumeOutput.value = full;
        els.resumeOutput.scrollTop = els.resumeOutput.scrollHeight;
      });

      const { resumeBody } = parseGeneratedOutput(rawOutput);
      els.resumeOutput.value = resumeBody;

      els.resumeStatus.textContent = '更新完成（全量重生成），正在自动保存...';
      els.resumeStatus.className = 'status-bar';
      els.saveResumeBtn.disabled = false;
      els.generateHtmlBtn.disabled = false;
      await autoSaveToLibrary();
    }

    // Update genChat context with the new resume
    const updatedResume = els.resumeOutput.value;
    genChatMessages = [
      { role: 'user', content: `请根据JD和简历素材生成简历。\n\nJD:\n${els.jdInput.value}\n\n基础简历:\n${currentResume}` },
      { role: 'assistant', content: updatedResume },
    ];
  } catch (e) {
    els.resumeStatus.textContent = '更新失败: ' + e.message;
    els.resumeStatus.className = 'status-bar';
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
    const model = state.get('generatorModel', 'jiekou-anthropic');
    const result = await api.streamRequest('/api/chat', {
      model, mock: els.mockMode.checked,
      messages: truncateHistory(genChatMessages),
      chatType: 'generator',
    }, (chunk, full) => {
      aiDiv.classList.remove('loading');
      aiDiv.textContent = full;
      els.genChatHistory.scrollTop = els.genChatHistory.scrollHeight;
    });
    genChatMessages.push({ role: 'assistant', content: result });

    // If AI returned updated resume content, sync to resume editing area
    const { resumeBody, notes } = parseGeneratedOutput(result);
    if (result.includes('简历正文') && resumeBody) {
      els.resumeOutput.value = resumeBody;
      if (notes) els.genNotesOutput.value = notes;
      els.resumeStatus.textContent = '简历已根据对话更新';
    } else if (looksLikeResume(result)) {
      els.resumeOutput.value = result;
      els.resumeStatus.textContent = '简历已根据对话更新（请检查内容）';
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
    const model = state.get('orchestratorModel', 'jiekou-anthropic');
    const result = await api.streamRequest('/api/chat', {
      model, mock: els.mockMode.checked,
      messages: truncateHistory(chatMessages),
      chatType: 'review',
    }, (chunk, full) => {
      aiDiv.classList.remove('loading');
      aiDiv.textContent = full;
      els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    });
    chatMessages.push({ role: 'assistant', content: result });

    // If AI returned updated review, sync to review output area
    if (looksLikeReview(result)) {
      els.reviewOutput.value = result;
      els.reviewStatus.textContent = '评审已根据对话更新';
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

  let htmlContent = '';
  try {
    const model = state.get('htmlModel', 'google-studio-google');
    let bodyContent = await api.streamRequest('/api/generate-html', {
      model, mock: els.mockMode.checked,
      resumeText: resume,
      htmlInstructions: els.htmlInstructions.value,
    }, (chunk, full) => { htmlContent = full; });

    // Clean: extract body content from possible markdown code fences or full HTML
    bodyContent = bodyContent.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

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

    // Browser native download
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    els.htmlStatus.textContent = `HTML 已下载: ${suggestedName}（点击Chrome下载栏中的文件即可预览）`;
    els.htmlStatus.className = 'status-text success';

    // Show HTML chat section and init context
    els.htmlChatSection.style.display = '';
    htmlChatMessages = [
      { role: 'user', content: `请把以下简历生成HTML格式。\n\n简历文本:\n${resume}` },
      { role: 'assistant', content: htmlContent },
    ];
  } catch (e) {
    els.htmlStatus.textContent = '生成失败: ' + e.message;
    els.htmlStatus.className = 'status-text error';
  }
  isStreaming = false;
  els.generateHtmlBtn.disabled = false;
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
    const model = state.get('htmlModel', 'google-studio-google');
    const result = await api.streamRequest('/api/chat', {
      model, mock: els.mockMode.checked,
      messages: truncateHistory(htmlChatMessages),
      chatType: 'html',
    }, (chunk, full) => {
      aiDiv.classList.remove('loading');
      aiDiv.textContent = full;
      els.htmlChatHistory.scrollTop = els.htmlChatHistory.scrollHeight;
    });
    htmlChatMessages.push({ role: 'assistant', content: result });

    // If AI returned HTML, offer to download updated version
    if (result.includes('<!DOCTYPE') || result.includes('<html')) {
      let newHtml = result.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
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

/* ── Start ── */
init();
