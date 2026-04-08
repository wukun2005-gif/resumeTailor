import { GoogleGenAI } from '@google/genai';

let client = null;
let modelId = 'gemini-3.1-flash-lite-preview';

export function initGemini(apiKey, model) {
  client = new GoogleGenAI({ apiKey });
  if (model) modelId = model;
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
      // Filter for generateContent support
      if (!model.supportedGenerationMethods?.includes('generateContent')) continue;

      // Extract model info
      const rateLimits = model.inputTokenLimit ? {
        rpm: model.displayName?.includes('flash-lite') ? 30 : (model.displayName?.includes('pro') ? 2 : 15),
        rpd: model.displayName?.includes('flash-lite') ? 2000 : (model.displayName?.includes('pro') ? 50 : 1500),
        tpm: model.inputTokenLimit * 10, // rough estimate
      } : { rpm: 0, rpd: 0, tpm: 0 };

      // Auto-tag recommendation
      let recommendation = '通用模型';
      if (model.displayName?.includes('flash-lite')) {
        recommendation = '最推荐 (速度极快、配额最高)';
      } else if (model.displayName?.includes('3.1-flash')) {
        recommendation = '综合能力最强';
      } else if (model.displayName?.includes('pro')) {
        recommendation = '高级能力 (需付费)';
      } else if (model.displayName?.includes('1.5')) {
        recommendation = '已下线/受限';
      }

      models.push({
        id: model.name.replace('models/', ''),
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
        '通用模型': 2,
        '高级能力 (需付费)': 3,
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

  let response;
  try {
    const config = { maxOutputTokens: opts.maxTokens || 16384, temperature: 0.7 };
    if (opts.jsonMode) {
      config.responseMimeType = 'application/json';
    }
    const reqParams = { model: modelId, contents, config };
    if (opts.system) {
      reqParams.config.systemInstruction = opts.system;
    }
    response = await client.models.generateContentStream(reqParams);
  } catch (err) {
    // Extract readable message from Gemini SDK errors
    const msg = err?.message || String(err);
    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      throw new Error(`Gemini API 配额不足（${modelId}）。免费额度可能已用完，请稍后重试或检查 Google AI Studio 配额设置。`);
    }
    if (msg.includes('401') || msg.includes('403') || msg.includes('PERMISSION_DENIED')) {
      throw new Error('Gemini API Key 无效或权限不足，请检查设置。');
    }
    if (msg.includes('fetch failed') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
      throw new Error('无法连接 Gemini API（网络问题），请检查 VPN 或网络连接。');
    }
    throw new Error(`Gemini 调用失败: ${msg.slice(0, 200)}`);
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
  return { text: fullText, usage };
}
