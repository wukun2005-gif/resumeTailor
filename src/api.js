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
        else if (data.type === 'done') return fullText;
      } catch (e) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }
  }
  return fullText;
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
