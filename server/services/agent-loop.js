/**
 * Agent Loop — orchestrates multi-round LLM + tool-call cycles.
 *
 * Flow: LLM call → (tool calls? → execute → feed back → repeat) → final text
 * Max iterations: 10 to prevent infinite loops.
 */

const MAX_ITERATIONS = 10;

/**
 * Convert MCP tools to Anthropic format.
 * @param {Array} mcpTools - Tools from MCP client.listTools()
 */
export function toolsToAnthropicFormat(mcpTools) {
  return mcpTools.map(t => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

/**
 * Convert MCP tools to OpenAI format.
 */
export function toolsToOpenAIFormat(mcpTools) {
  return mcpTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * Convert MCP tools to Gemini format (functionDeclarations array).
 */
export function toolsToGeminiFormat(mcpTools) {
  return mcpTools.map(t => ({
    name: t.name,
    description: t.description || '',
    parameters: t.inputSchema || { type: 'object', properties: {} },
  }));
}

/**
 * Convert MCP tools to the format expected by the given SDK type.
 */
export function formatToolsForSDK(mcpTools, sdkType) {
  switch (sdkType) {
    case 'anthropic': return toolsToAnthropicFormat(mcpTools);
    case 'openai-compat': return toolsToOpenAIFormat(mcpTools);
    case 'google': return toolsToGeminiFormat(mcpTools);
    default: throw new Error(`Unknown SDK type: ${sdkType}`);
  }
}

/**
 * Run an agent loop: call LLM with tools, execute tool calls, repeat.
 *
 * @param {object} params
 * @param {Function} params.caller - LLM caller (prompt, onChunk, opts) => {text, usage, toolCalls?, stopReason?}
 * @param {string} params.sdkType - 'anthropic' | 'openai-compat' | 'google'
 * @param {string} params.system - System prompt
 * @param {string} params.userMessage - Initial user message
 * @param {Array} params.mcpTools - MCP tools from client.listTools()
 * @param {Function} params.executeTool - async (toolName, args) => string (tool result text)
 * @param {Function} [params.onChunk] - Streaming callback for text output
 * @param {number} [params.maxIterations] - Max tool-call rounds (default 10)
 * @returns {{ text: string, usage: {input, output}, toolCallHistory: Array, iterations: number }}
 */
export async function runAgentLoop({
  caller,
  sdkType,
  system,
  userMessage,
  mcpTools,
  executeTool,
  onChunk,
  maxIterations = MAX_ITERATIONS,
}) {
  const formattedTools = formatToolsForSDK(mcpTools, sdkType);
  const messages = [{ role: 'user', content: userMessage }];
  let totalUsage = { input: 0, output: 0 };
  const toolCallHistory = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Call LLM with tools
    const result = await caller(null, onChunk, {
      system,
      messages,
      tools: formattedTools,
      maxTokens: 4096,
    });

    totalUsage.input += result.usage?.input || 0;
    totalUsage.output += result.usage?.output || 0;

    // If no tool calls, we're done
    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        text: result.text,
        usage: totalUsage,
        toolCallHistory,
        iterations: iteration + 1,
      };
    }

    // Build assistant message with tool calls
    if (sdkType === 'anthropic') {
      const assistantContent = [];
      if (result.text) assistantContent.push({ type: 'text', text: result.text });
      for (const tc of result.toolCalls) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      // Execute tools and build tool_result message
      const toolResults = [];
      for (const tc of result.toolCalls) {
        const toolResultText = await executeTool(tc.name, tc.input);
        toolCallHistory.push({ name: tc.name, args: tc.input, result: toolResultText });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: toolResultText,
        });
      }
      messages.push({ role: 'user', content: toolResults });

    } else if (sdkType === 'openai-compat') {
      // OpenAI format: assistant message with tool_calls
      const assistantMsg = { role: 'assistant', content: result.text || null, tool_calls: [] };
      for (const tc of result.toolCalls) {
        assistantMsg.tool_calls.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        });
      }
      messages.push(assistantMsg);

      // Execute tools and add tool role messages
      for (const tc of result.toolCalls) {
        const toolResultText = await executeTool(tc.name, tc.input);
        toolCallHistory.push({ name: tc.name, args: tc.input, result: toolResultText });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResultText,
        });
      }

    } else if (sdkType === 'google') {
      // Gemini format: model message with functionCall, then function response
      const modelParts = [];
      if (result.text) modelParts.push({ text: result.text });
      for (const tc of result.toolCalls) {
        modelParts.push({ functionCall: { name: tc.name, args: tc.input } });
      }
      messages.push({ role: 'assistant', content: modelParts });

      // Execute tools and add function responses
      const responseParts = [];
      for (const tc of result.toolCalls) {
        const toolResultText = await executeTool(tc.name, tc.input);
        toolCallHistory.push({ name: tc.name, args: tc.input, result: toolResultText });
        responseParts.push({
          functionResponse: {
            name: tc.name,
            response: { result: toolResultText },
          },
        });
      }
      messages.push({ role: 'user', content: responseParts });
    }
  }

  // Max iterations reached — make one final call without tools
  const finalResult = await caller(null, onChunk, {
    system,
    messages,
    maxTokens: 4096,
  });

  totalUsage.input += finalResult.usage?.input || 0;
  totalUsage.output += finalResult.usage?.output || 0;

  return {
    text: finalResult.text || '',
    usage: totalUsage,
    toolCallHistory,
    iterations: maxIterations,
  };
}
