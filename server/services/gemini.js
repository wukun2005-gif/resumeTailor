import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let client = null;
let modelId = 'gemini-3.1-flash-lite-preview';
const GEMINI_MAX_RETRIES = 3;
const GEMINI_BASE_RETRY_DELAY_MS = 2000;

// Default fallback configuration (hardcoded as last resort)
const DEFAULT_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite-preview',     // 1. Most recommended (fastest, highest quota)
  'gemini-2.5-flash-lite',              // 2. Most recommended (fastest, highest quota)
  'gemini-2.0-flash-lite',              // 3. Most recommended (fastest, highest quota)
  'gemini-3-flash-preview',             // 4. Best overall capability
  'gemini-2.5-flash',                   // 5. Best overall capability
  'gemini-2.0-flash',                   // 6. Best overall capability
  'gemini-3.1-pro-preview',             // 7. Advanced capability (lower quota)
  'gemini-3-pro-preview',               // 8. Advanced capability (lower quota)
  'gemini-2.5-pro'                      // 9. Advanced capability (lower quota)
];

// Configured fallback models (loaded from env or config file)
let FALLBACK_MODELS = [...DEFAULT_FALLBACK_MODELS];

// Track current model index for fallback
let currentModelIndex = 0;

// ============================================
// Configuration Loading Functions
// ============================================

function getProjectRoot() {
  return path.resolve(__dirname, '../../');
}

function loadFallbackModelsFromEnv() {
  const envValue = process.env.GEMINI_FALLBACK_MODELS;
  if (!envValue) {
    return null;
  }
  const models = envValue.split(',').map(m => m.trim()).filter(Boolean);
  if (models.length === 0) {
    return null;
  }
  return models;
}

function loadFallbackModelsFromConfigFile() {
  const configPath = path.resolve(getProjectRoot(), 'config/models.json');
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const fileContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(fileContent);
    
    if (!config.fallbackModels || !Array.isArray(config.fallbackModels)) {
      return null;
    }
    
    const models = config.fallbackModels.map(m => String(m).trim()).filter(Boolean);
    if (models.length === 0) {
      return null;
    }
    
    return models;
  } catch (err) {
    return null;
  }
}

function validateModels(models) {
  if (!Array.isArray(models)) {
    throw new Error('models 必须是数组');
  }
  const valid = models.filter(m => {
    const s = String(m).trim();
    return s.length > 0 && /^gemini-/i.test(s);
  });
  if (valid.length === 0) {
    throw new Error('没有有效的 gemini 模型');
  }
  return valid;
}

function loadFallbackModelsFromUserConfig() {
  const configPath = path.resolve(getProjectRoot(), 'config/user-models.json');
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const fileContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(fileContent);
    
    if (!config.fallbackModels || !Array.isArray(config.fallbackModels)) {
      return null;
    }
    
    const models = config.fallbackModels.map(m => String(m).trim()).filter(Boolean);
    if (models.length === 0) {
      return null;
    }
    
    return models;
  } catch (err) {
    return null;
  }
}

function saveFallbackModelsToUserConfig(models) {
  const configPath = path.resolve(getProjectRoot(), 'config/user-models.json');
  const configDir = path.dirname(configPath);
  
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    const config = {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      fallbackModels: models,
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    // Also update in-memory FALLBACK_MODELS
    FALLBACK_MODELS = [...models];
    
    return true;
  } catch (err) {
    throw new Error(`保存配置失败: ${err.message}`);
  }
}

function loadFallbackModels() {
  let models = null;
  
  // Priority 1: Environment variable
  models = loadFallbackModelsFromEnv();
  
  // Priority 2: User config file (highest priority local file)
  if (!models) {
    models = loadFallbackModelsFromUserConfig();
  }
  
  // Priority 3: Global config file
  if (!models) {
    models = loadFallbackModelsFromConfigFile();
  }
  
  // Priority 4: Default hardcoded
  if (!models) {
    models = [...DEFAULT_FALLBACK_MODELS];
  }
  
  try {
    const validatedModels = validateModels(models);
    FALLBACK_MODELS = validatedModels;
  } catch (err) {
    FALLBACK_MODELS = [...DEFAULT_FALLBACK_MODELS];
  }
}

export function getFallbackModels() {
  return [...FALLBACK_MODELS];
}

export function setFallbackModels(models) {
  const validatedModels = validateModels(models);
  saveFallbackModelsToUserConfig(validatedModels);
  resetFallbackIndex();
  return validatedModels;
}

const NON_TEXT_MODEL_PATTERNS = [
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
  /\bclip\b/i,
  /\bupscale\b/i,
  /\brecontext\b/i,
  /\btranscrib/i,
  /\bcomputer[- ]?use\b/i,
];

const TEXT_MODEL_PATTERNS = [
  /\bgemini\b/i,
  /\btext\b/i,
  /\bchat\b/i,
  /\bcompletion\b/i,
];

const NOISY_MODEL_PATTERNS = [
  /\bdeep[- ]?research\b/i,
  /\brobotics\b/i,
  /\bcustom\s*tools?\b/i,
  /\blatest\b/i,
  /-001$/i,
];

function getModelIdentifier(model) {
  return (model.name || '').replace('models/', '');
}

function getModelSearchText(model) {
  return [
    getModelIdentifier(model),
    model.displayName,
    model.description,
  ].filter(Boolean).join(' ');
}

function supportsTextGeneration(model) {
  const methods = model.supportedGenerationMethods || model.supportedActions || [];
  return methods.some(method => {
    const normalized = String(method).toLowerCase();
    return normalized === 'generatecontent' || normalized === 'streamgeneratecontent';
  });
}

function isResumeTextModel(model) {
  if (!supportsTextGeneration(model)) return false;

  const identifier = getModelIdentifier(model);
  const searchText = getModelSearchText(model);

  if (NON_TEXT_MODEL_PATTERNS.some(pattern => pattern.test(searchText))) return false;

  const isGeminiTextFamily = /^gemini-/i.test(identifier);
  const hasTextSignal = TEXT_MODEL_PATTERNS.some(pattern => pattern.test(searchText))
    || (model.outputTokenLimit || 0) > 0;
  return isGeminiTextFamily || hasTextSignal;
}

function isFreeResumeTextModel(model) {
  if (!isResumeTextModel(model)) return false;

  const identifier = getModelIdentifier(model);
  const searchText = getModelSearchText(model);

  if (!/^gemini-/i.test(identifier)) return false;
  if (NOISY_MODEL_PATTERNS.some(pattern => pattern.test(identifier) || pattern.test(searchText))) return false;

  return true;
}

function getRecommendation(model) {
  const searchText = getModelSearchText(model).toLowerCase();

  if (searchText.includes('1.5')) return '已下线/受限';
  if (searchText.includes('flash-lite')) return '最推荐 (速度极快、配额最高)';
  if (searchText.includes('flash')) return '综合能力最强';
  if (searchText.includes('pro')) return '高级能力 (配额较低)';
  return '通用模型';
}

function getRateLimits(model) {
  const searchText = getModelSearchText(model).toLowerCase();
  const inputTokenLimit = model.inputTokenLimit || 0;

  if (!inputTokenLimit) return { rpm: 0, rpd: 0, tpm: 0 };

  if (searchText.includes('flash-lite')) {
    return { rpm: 30, rpd: 2000, tpm: inputTokenLimit * 10 };
  }
  if (searchText.includes('pro') && !searchText.includes('1.5')) {
    return { rpm: 2, rpd: 50, tpm: inputTokenLimit * 10 };
  }
  return { rpm: 15, rpd: 1500, tpm: inputTokenLimit * 10 };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(err) {
  return err?.message || String(err);
}

function isRetryableGeminiError(message) {
  const lower = String(message).toLowerCase();
  return lower.includes('429')
    || lower.includes('resource_exhausted')
    || lower.includes('503')
    || lower.includes('unavailable')
    || lower.includes('high demand');
}

function isModelQuotaError(message) {
  const lower = String(message).toLowerCase();
  return lower.includes('429')
    || lower.includes('resource_exhausted')
    || lower.includes('配额不足');
}

function getFallbackModel() {
  if (currentModelIndex >= FALLBACK_MODELS.length - 1) {
    throw new Error(`所有模型都已尝试失败，无法继续 fallback`);
  }
  currentModelIndex++;
  const fallbackModel = FALLBACK_MODELS[currentModelIndex];
  return fallbackModel;
}

function resetFallbackIndex() {
  currentModelIndex = 0;
}

function mapGeminiError(message, retriesUsed) {
  if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
    return new Error(`Gemini API 配额不足（${modelId}），已自动重试 ${retriesUsed} 次后仍失败。免费额度可能已用完，请稍后重试或检查 Google AI Studio 配额设置。`);
  }
  if (message.includes('503') || message.includes('UNAVAILABLE') || message.toLowerCase().includes('high demand')) {
    return new Error(`Gemini API 服务繁忙（${modelId}），已自动重试 ${retriesUsed} 次后仍失败，请稍后重试。`);
  }
  if (message.includes('401') || message.includes('403') || message.includes('PERMISSION_DENIED')) {
    return new Error('Gemini API Key 无效或权限不足，请检查设置。');
  }
  if (message.includes('fetch failed') || message.includes('ENOTFOUND') || message.includes('ECONNREFUSED')) {
    return new Error('无法连接 Gemini API（网络问题），请检查 VPN 或网络连接。');
  }
  return new Error(`Gemini 调用失败: ${message.slice(0, 200)}`);
}

export function initGemini(apiKey, model) {
  // Load configuration first
  loadFallbackModels();
  
  client = new GoogleGenAI({ apiKey });
  resetFallbackIndex();
  
  if (model) {
    modelId = model;
    // Try to find the model in FALLBACK_MODELS array to set correct initial index
    const modelIndex = FALLBACK_MODELS.indexOf(model);
    if (modelIndex !== -1) {
      currentModelIndex = modelIndex;
    }
  } else {
    modelId = FALLBACK_MODELS[0];
  }
}

export function isGeminiReady() { return client !== null; }

export async function listGeminiModels(apiKey) {
  if (!apiKey) throw new Error('需要提供 API Key');

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `API 返回错误: ${response.status}`);
    }

    const models = [];
    for (const model of data.models || []) {
      if (!isFreeResumeTextModel(model)) continue;

      const recommendation = getRecommendation(model);
      const rateLimits = getRateLimits(model);

      models.push({
        id: getModelIdentifier(model),
        displayName: model.displayName || model.name,
        inputTokenLimit: model.inputTokenLimit || 0,
        outputTokenLimit: model.outputTokenLimit || 0,
        rateLimits,
        recommendation,
      });
    }

    return models.sort((a, b) => {
      // Sort by recommendation priority
      const priority = {
        '最推荐 (速度极快、配额最高)': 0,
        '综合能力最强': 1,
        '高级能力 (配额较低)': 2,
        '通用模型': 3,
        '已下线/受限': 4,
      };
      return (priority[a.recommendation] || 99) - (priority[b.recommendation] || 99);
    });
  } catch (err) {
    throw new Error(`列出 Gemini 模型失败: ${err.message}`);
  }
}

export async function callGemini(prompt, onChunk, opts = {}) {
  if (!client) throw new Error('Gemini API 未配置');

  let contents;
  if (opts.messages) {
    contents = opts.messages.map(m => {
      const parts = [];
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text') parts.push({ text: part.text });
          else if (part.type === 'file') parts.push({ inlineData: { mimeType: part.mimeType, data: part.data } });
        }
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });
  } else {
    contents = prompt;
  }

  // Try all models in fallback list until one works or all fail
  let lastError = null;
  let response = null;
  let usedModel = modelId;

  // Start from current model index and try all models
  for (let modelTry = currentModelIndex; modelTry < FALLBACK_MODELS.length; modelTry++) {
    const currentModel = FALLBACK_MODELS[modelTry];
    usedModel = currentModel;

    const config = { maxOutputTokens: opts.maxTokens || 16384, temperature: 0.7 };
    if (opts.jsonMode) {
      config.responseMimeType = 'application/json';
    }
    // Extended thinking (reasoning) support
    const reasoningBudgetMap = { low: 2048, medium: 8192, high: 24576 };
    if (opts.reasoning && reasoningBudgetMap[opts.reasoning]) {
      const budget = reasoningBudgetMap[opts.reasoning];
      config.thinkingConfig = { thinkingBudget: budget };
      // Ensure maxOutputTokens is sufficient for thinking + output
      if (config.maxOutputTokens <= budget) {
        config.maxOutputTokens = budget + 4096;
      }
    }
    const reqParams = { model: currentModel, contents, config };
    if (opts.system) {
      reqParams.config.systemInstruction = opts.system;
    }

    // Retry same model up to GEMINI_MAX_RETRIES times
    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
      try {
        response = await client.models.generateContentStream(reqParams);
        // Success! Reset fallback index for next time
        currentModelIndex = modelTry;
        modelId = currentModel;
        break;
      } catch (err) {
        const message = getErrorMessage(err);
        lastError = message;
        const retriesUsed = attempt;

        if (attempt < GEMINI_MAX_RETRIES && isRetryableGeminiError(message)) {
          // If it's a quota error, don't retry same model - go to next model immediately
          if (isModelQuotaError(message)) {
            break;
          }
          // Other retryable errors - retry same model
          const delayMs = GEMINI_BASE_RETRY_DELAY_MS * (2 ** attempt);
          await sleep(delayMs);
          continue;
        }

        // Non-retryable error or out of retries for this model
        // If it's the last model, throw error
        if (modelTry === FALLBACK_MODELS.length - 1) {
          throw mapGeminiError(message, retriesUsed);
        }
        // Otherwise, try next model
        break;
      }
    }

    if (response) {
      break; // Got a successful response, exit model loop
    }
  }

  if (!response) {
    throw new Error(`所有 Gemini 模型都已尝试失败，最后一个错误: ${lastError}`);
  }

  let fullText = '';
  let usage = { input: 0, output: 0 };
  for await (const chunk of response) {
    const text = chunk.text || '';
    fullText += text;
    if (onChunk) onChunk(text);
    // Capture usage metadata from the last chunk
    if (chunk.usageMetadata) {
      usage.input = chunk.usageMetadata.promptTokenCount || 0;
      usage.output = chunk.usageMetadata.candidatesTokenCount || 0;
    }
  }
  return { text: fullText, usage, model: usedModel };
}
