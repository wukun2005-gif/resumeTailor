/**
 * OpenAI-compatible API caller using raw fetch (no npm dependency).
 * Supports streaming via SSE for endpoints like Jiekou.ai and OpenRouter.ai.
 */

/** @type {Map<string, {baseURL: string, apiKey: string, model: string}>} */
const connections = new Map();

export function initOpenAICompat(connectionId, baseURL, apiKey, model) {
  connections.set(connectionId, { baseURL: baseURL.replace(/\/+$/, ''), apiKey, model });
}

export function isOpenAICompatReady(connectionId) {
  return connections.has(connectionId);
}

export function getOpenAICompatConnection(connectionId) {
  return connections.get(connectionId);
}

/**
 * Call an OpenAI-compatible chat completions endpoint with streaming.
 * @param {string} connectionId - The connection identifier
 * @param {string|null} prompt - Simple text prompt (used if opts.messages not provided)
 * @param {Function} onChunk - Callback for each text chunk
 * @param {object} opts - Options: { messages, maxTokens, temperature }
 */
export async function callOpenAICompat(connectionId, prompt, onChunk, opts = {}) {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error(`OpenAI-compatible connection "${connectionId}" 未配置`);

  const messages = opts.messages
    ? opts.messages.map(convertMessage)
    : [{ role: 'user', content: prompt }];

  // Prepend system message if provided and not already present
  if (opts.system && messages[0]?.role !== 'system') {
    messages.unshift({ role: 'system', content: opts.system });
  }

  const url = `${conn.baseURL}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${conn.apiKey}`,
    },
    body: JSON.stringify({
      model: conn.model,
      messages,
      max_tokens: opts.maxTokens || 16384,
      temperature: opts.temperature ?? 0.7,
      stream: true,
      ...(opts.jsonMode && { response_format: { type: 'json_object' } }),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const status = response.status;
    if (status === 429) {
      throw new Error(`API 配额不足（${conn.model}），请稍后重试。`);
    }
    if (status === 401 || status === 403) {
      throw new Error(`API Key 无效或权限不足（${connectionId}），请检查设置。`);
    }
    throw new Error(`API 调用失败 (${status}): ${body.slice(0, 200)}`);
  }

  let fullText = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = { input: 0, output: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue; // skip empty lines and comments
      if (!trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const text = parsed.choices?.[0]?.delta?.content || '';
        if (text) {
          fullText += text;
          if (onChunk) onChunk(text);
        }
        // Capture usage from the chunk (may appear in final chunks)
        if (parsed.usage) {
          usage.input = parsed.usage.prompt_tokens || usage.input;
          usage.output = parsed.usage.completion_tokens || usage.output;
        }
      } catch {
        // skip malformed JSON chunks
      }
    }
  }

  return { text: fullText, usage };
}

/** Convert our internal message format to OpenAI format */
function convertMessage(msg) {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }
  if (Array.isArray(msg.content)) {
    return {
      role: msg.role,
      content: msg.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'file') {
          // Images → image_url with base64 data URI
          if (part.mimeType?.startsWith('image/')) {
            return {
              type: 'image_url',
              image_url: { url: `data:${part.mimeType};base64,${part.data}` },
            };
          }
          // PDFs and other files → include as text description (limited OpenAI support)
          return { type: 'text', text: `[Attached file: ${part.mimeType}]` };
        }
        return part;
      }),
    };
  }
  return msg;
}
