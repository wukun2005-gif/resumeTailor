import Anthropic from '@anthropic-ai/sdk';

let client = null;
let modelId = 'claude-opus-4-6';

export function initAnthropic(baseURL, apiKey, model) {
  client = new Anthropic({
    baseURL: baseURL || 'https://api.jiekou.ai/anthropic',
    apiKey,
  });
  if (model) modelId = model;
}

export function isAnthropicReady() { return client !== null; }

export async function callAnthropic(prompt, onChunk, opts = {}) {
  if (!client) throw new Error('Anthropic API 未配置');

  let messages = opts.messages || [{ role: 'user', content: prompt }];

  // If userBlocks provided (for cache optimization), convert first user message to content blocks
  if (!opts.messages && opts.userBlocks) {
    messages = [{
      role: 'user',
      content: opts.userBlocks.map(block => {
        const part = { type: 'text', text: block.text };
        if (block.cache) part.cache_control = { type: 'ephemeral' };
        return part;
      }),
    }];
  }

  // Convert multimodal content to Anthropic format
  messages = messages.map(m => {
    if (typeof m.content === 'string') return m;
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: m.content.map(part => {
          if (part.type === 'text') return part; // preserve existing text blocks (including cache_control)
          if (part.type === 'file') {
            if (part.mimeType === 'application/pdf') {
              return { type: 'document', source: { type: 'base64', media_type: part.mimeType, data: part.data } };
            }
            return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } };
          }
          return part;
        }),
      };
    }
    return m;
  });
  const params = {
    model: modelId,
    max_tokens: opts.maxTokens || 16384,
    messages,
  };

  // Use Anthropic prompt caching: system message with cache_control
  if (opts.system) {
    params.system = [
      { type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } },
    ];
  }

  const stream = client.messages.stream(params);
  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const text = event.delta.text;
      fullText += text;
      if (onChunk) onChunk(text);
    }
  }
  return fullText;
}
