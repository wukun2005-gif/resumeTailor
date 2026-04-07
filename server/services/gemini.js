import { GoogleGenAI } from '@google/genai';

let client = null;
let modelId = 'gemini-3.1-flash-lite-preview';

export function initGemini(apiKey, model) {
  client = new GoogleGenAI({ apiKey });
  if (model) modelId = model;
}

export function isGeminiReady() { return client !== null; }

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
  for await (const chunk of response) {
    const text = chunk.text || '';
    fullText += text;
    if (onChunk) onChunk(text);
  }
  return fullText;
}
