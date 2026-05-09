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

  // Extended thinking (reasoning) support
  const budgetMap = { low: 2048, medium: 8192, high: 32768 };
  if (opts.reasoning && budgetMap[opts.reasoning]) {
    const budget = budgetMap[opts.reasoning];
    params.thinking = { type: 'enabled', budget_tokens: budget };
    // Anthropic requires max_tokens > budget_tokens when thinking is enabled
    if (params.max_tokens <= budget) {
      params.max_tokens = budget + 4096;
    }
  }

  // Tool-calling support
  if (opts.tools && opts.tools.length > 0) {
    params.tools = opts.tools;
  }

  const stream = client.messages.stream(params);
  let fullText = '';
  let usage = { input: 0, output: 0 };
  let stopReason = null;
  // Track tool_use content blocks during streaming
  const toolUseBlocks = {};

  for await (const event of stream) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      toolUseBlocks[event.index] = {
        id: event.content_block.id,
        name: event.content_block.name,
        inputJson: '',
      };
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        fullText += text;
        if (onChunk) onChunk(text);
      } else if (event.delta?.type === 'input_json_delta') {
        const block = toolUseBlocks[event.index];
        if (block) block.inputJson += event.delta.partial_json;
      }
    } else if (event.type === 'message_start' && event.message?.usage) {
      usage.input = event.message.usage.input_tokens || 0;
    } else if (event.type === 'message_delta') {
      if (event.usage) usage.output = event.usage.output_tokens || 0;
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
    }
  }

  // Parse tool calls from accumulated blocks
  const toolCalls = Object.values(toolUseBlocks).map(b => ({
    id: b.id,
    name: b.name,
    input: b.inputJson ? JSON.parse(b.inputJson) : {},
  }));

  const result = { text: fullText, usage };
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  if (stopReason) result.stopReason = stopReason;
  return result;
}
