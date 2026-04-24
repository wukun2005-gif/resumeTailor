export async function streamRequest(endpoint, body, onChunk) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let usage = { input: 0, output: 0 };
  let model = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'chunk') { fullText += data.text; onChunk(data.text, fullText); }
        else if (data.type === 'error') throw new Error(data.message);
        else if (data.type === 'done') {
          usage = data.usage || { input: 0, output: 0 };
          model = data.model || '';
          return { text: fullText, usage, model };
        }
      } catch (e) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }
  }
  return { text: fullText, usage, model };
}

export async function listFiles(dir) {
  const res = await fetch(`/api/list-files?dir=${encodeURIComponent(dir)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.files;
}

export async function readFile(filePath) {
  const res = await fetch(`/api/read-file?path=${encodeURIComponent(filePath)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message);
  return data.content;
}

export async function saveFile(filePath, content) {
  const res = await fetch('/api/save-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, content }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function initAPI(config) {
  const res = await fetch('/api/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function listModels(connectionId, apiKey = '') {
  let res;
  try {
    res = await fetch('/api/list-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId, apiKey }),
    });
  } catch (err) {
    throw new Error('无法连接后端服务器，请确认 npm run dev 正在运行');
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('后端服务器未响应（可能已崩溃），请重启 npm run dev');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '获取模型列表失败');
  return data;
}

export async function getLibraryDigest(dir, excludeNames = []) {
  const res = await fetch('/api/library-digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, excludeNames }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function ocrJdImages(model, images, mock = false) {
  const res = await fetch('/api/ocr-jd-images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, images, mock }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'JD 图片 OCR 失败');
  return data;
}

/**
 * Get default preprocessing prompt from hardcoded path.
 */
export async function getDefaultPreprocessPrompt() {
  const res = await fetch('/api/default-preprocess-prompt');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.content;
}

/**
 * Stream AI preprocessing request.
 * @param {string} dir - Library directory path
 * @param {string} model - Model connection ID
 * @param {string} instructions - User's preprocessing instructions
 * @param {Array} messages - Chat messages for multi-turn conversation
 * @param {string[]} excludeNames - File names to exclude
 * @param {boolean} mock - Mock mode
 * @param {Function} onChunk - Callback for each chunk
 * @param {Function} onSystem - Callback for system messages
 * @returns {Promise<{exportText: string, sourceTokens: number, digestTokens: number, fromCache: boolean, fallbackUsed: boolean}>}
 */
export async function preprocessLibrary(dir, model, instructions, messages, excludeNames, mock, onChunk, onSystem) {
  const response = await fetch('/api/preprocess-library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, model, instructions, messages, excludeNames, mock }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let result = {
    exportText: '',
    sourceTokens: 0,
    digestTokens: 0,
    fromCache: false,
    fallbackUsed: false
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'chunk') {
          fullText += data.text;
          if (onChunk) onChunk(data.text, fullText);
        } else if (data.type === 'system') {
          if (onSystem) onSystem(data.message);
        } else if (data.type === 'error') {
          throw new Error(data.message);
        } else if (data.type === 'done') {
          result = {
            exportText: data.exportText || fullText,
            sourceTokens: data.sourceTokens || 0,
            digestTokens: data.digestTokens || 0,
            fromCache: data.fromCache || false,
            fallbackUsed: data.fallbackUsed || false,
            usage: data.usage || { input: 0, output: 0 },
            model: data.model || ''
          };
        }
      } catch (e) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }
  }
  return result;
}

/**
 * Get current Gemini fallback model list
 */
export async function getGeminiFallbackModels() {
  const res = await fetch('/api/gemini/fallback-models');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '获取 Gemini fallback 模型列表失败');
  return data.models;
}

/**
 * Save Gemini fallback model list
 */
export async function setGeminiFallbackModels(models) {
  const res = await fetch('/api/gemini/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '保存 Gemini fallback 模型列表失败');
  return data;
}
