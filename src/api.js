export async function streamRequest(endpoint, body, onChunk, onProgress, onTimeout, onStreamResumed) {
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
  let firstChunkReceived = false;
  const TIMEOUT_MS = body._testTimeoutMs || 15000;
  let streamStartTime = Date.now();
  let lastChunkTime = Date.now();
  let resolved = false;
  let timeoutWarningShown = false;

  const showTimeoutWarning = () => {
    if (!resolved && onTimeout && !timeoutWarningShown) {
      timeoutWarningShown = true;
      console.log('[Timeout] Showing timeout warning');
      onTimeout('AI 响应较慢，请稍候...');
    }
  };

  try {
    while (true) {
      // 记录 read() 前的超时状态，用于判断本周期内是否需要隐藏警告
      const warningWasShownBeforeRead = timeoutWarningShown;

      const { done, value } = await reader.read();
      if (done) break;

      // read() 完成，检查等待间隔是否超时
      const now = Date.now();
      if (!firstChunkReceived) {
        // 等待首 chunk：检查从请求发出到现在的耗时
        const elapsed = now - streamStartTime;
        if (elapsed > TIMEOUT_MS) {
          console.log('[Timeout] First chunk took', elapsed, 'ms');
          showTimeoutWarning();
        }
      } else {
        // 等待后续 chunk：检查距上次 chunk 的间隔
        const gap = now - lastChunkTime;
        if (gap > TIMEOUT_MS) {
          console.log('[Timeout] Gap between chunks:', gap, 'ms');
          showTimeoutWarning();
        }
      }
      lastChunkTime = now;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'chunk') {
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              const elapsed = Date.now() - streamStartTime;
              console.log('[Timeout] First chunk received! elapsed:', elapsed, 'ms');
            }
            fullText += data.text;
            onChunk(data.text, fullText);
          }
          else if (data.type === 'progress' && onProgress) { onProgress(data.text); }
          else if (data.type === 'error') throw new Error(data.message);
          else if (data.type === 'done') {
            usage = data.usage || { input: 0, output: 0 };
            model = data.model || '';
            resolved = true;
            return { text: fullText, usage, model };
          }
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
      // chunk 到达后，若在本次 read 之前已触发过超时警告，通知调用方数据已恢复
      // （本次 read 内刚触发的警告不立即隐藏，让用户至少看到一个 chunk 周期）
      if (warningWasShownBeforeRead && onStreamResumed) {
        timeoutWarningShown = false;
        onStreamResumed();
      }
    }
    return { text: fullText, usage, model };
  } finally {
    resolved = true;
  }
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
export async function preprocessLibrary(dir, model, instructions, messages, excludeNames, mock, onChunk, onSystem, onTimeout, onStreamResumed) {
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
  let firstChunkReceived = false;
  const TIMEOUT_MS = 15000;
  let streamStartTime = Date.now();
  let lastChunkTime = Date.now();
  let resolved = false;
  let timeoutWarningShown = false;

  const showTimeoutWarning = () => {
    if (!resolved && onTimeout && !timeoutWarningShown) {
      timeoutWarningShown = true;
      console.log('[Timeout preprocess] Showing timeout warning');
      onTimeout('AI 响应较慢，请稍候...');
    }
  };

  try {
    while (true) {
      const warningWasShownBeforeRead = timeoutWarningShown;

      const { done, value } = await reader.read();
      if (done) break;

      // read() 完成，检查等待间隔是否超时
      const now = Date.now();
      if (!firstChunkReceived) {
        const elapsed = now - streamStartTime;
        if (elapsed > TIMEOUT_MS) {
          console.log('[Timeout preprocess] First chunk took', elapsed, 'ms');
          showTimeoutWarning();
        }
      } else {
        const gap = now - lastChunkTime;
        if (gap > TIMEOUT_MS) {
          console.log('[Timeout preprocess] Gap between chunks:', gap, 'ms');
          showTimeoutWarning();
        }
      }
      lastChunkTime = now;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'chunk') {
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              const elapsed = Date.now() - streamStartTime;
              console.log('[Timeout preprocess] First chunk received! elapsed:', elapsed, 'ms');
            }
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
      // chunk 到达后，若在本次 read 之前已触发过超时警告，通知调用方数据已恢复
      if (warningWasShownBeforeRead && onStreamResumed) {
        timeoutWarningShown = false;
        onStreamResumed();
      }
    }
    return result;
  } finally {
    resolved = true;
  }
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

/**
 * 判断错误是否为网络断连（可重试），区分于服务端/API 错误。
 * fetch() 和 reader.read() 网络失败抛 TypeError，服务端错误抛普通 Error。
 */
export function isNetworkError(err) {
  if (err instanceof TypeError) return true;
  const msg = err.message || '';
  return msg.includes('Failed to fetch') ||
         msg.includes('NetworkError') ||
         msg.includes('Network request failed') ||
         msg.includes('Load failed');
}
