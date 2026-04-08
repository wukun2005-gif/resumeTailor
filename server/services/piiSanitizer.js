/**
 * PII Sanitizer — 在发送 AI API 前脱敏个人身份信息，返回后自动恢复。
 *
 * 架构：服务端拦截层，PII 映射表仅存在于服务端内存，不离开本地。
 */

// ── Module state ──
let piiEntries = []; // Array<{ real: string, placeholder: string, caseInsensitive?: boolean }>

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 接收前端传来的 PII 配置，构建 entries 数组（按 real 值长度降序排列）。
 */
export function setPiiConfig(config) {
  if (!config || !config.enabled) {
    piiEntries = [];
    return;
  }

  const raw = []; // { real, placeholder, caseInsensitive }

  // 邮箱（最长，优先替换）
  if (config.email) {
    raw.push({ real: config.email, placeholder: '<<EMAIL>>', caseInsensitive: true });
  }

  // LinkedIn URL
  if (config.linkedin) {
    raw.push({ real: config.linkedin, placeholder: '<<LINKEDIN>>', caseInsensitive: true });
  }

  // GitHub URL
  if (config.github) {
    raw.push({ real: config.github, placeholder: '<<GITHUB>>', caseInsensitive: true });
  }

  // 个人网站
  if (config.website) {
    raw.push({ real: config.website, placeholder: '<<WEBSITE>>', caseInsensitive: true });
  }

  // 电话号码（支持多个）
  const phones = config.phones || [];
  phones.forEach((phone, i) => {
    if (phone) {
      const suffix = i === 0 ? '' : `_${i + 1}`;
      raw.push({ real: phone, placeholder: `<<PHONE${suffix}>>` });
    }
  });

  // 住址/其他 PII
  const others = config.other || [];
  others.forEach((item, i) => {
    if (item) {
      const suffix = i === 0 ? '' : `_${i + 1}`;
      raw.push({ real: item, placeholder: `<<OTHER${suffix}>>` });
    }
  });

  // 英文姓名（大小写不敏感）
  if (config.nameEn) {
    raw.push({ real: config.nameEn, placeholder: '<<NAME>>', caseInsensitive: true });
  }

  // 中文姓名（精确匹配）
  if (config.nameZh) {
    raw.push({ real: config.nameZh, placeholder: '<<NAME_ZH>>' });
  }

  // 姓名变体（如用户名 wukun, KunWu 等）
  const variants = config.nameVariants || [];
  variants.forEach(v => {
    if (v) raw.push({ real: v, placeholder: '<<NAME>>', caseInsensitive: true });
  });

  // 按 real 长度降序排列，确保长匹配优先（避免短子串在长字符串中导致双重替换）
  raw.sort((a, b) => b.real.length - a.real.length);

  piiEntries = raw;
}

/**
 * 返回当前 PII entries 数组（未配置或未启用时为空数组）。
 */
export function getPiiEntries() {
  return piiEntries;
}

/**
 * 将文本中的 PII 替换为占位符。
 */
export function sanitize(text, entries) {
  if (!text || typeof text !== 'string' || !entries || entries.length === 0) return text;
  let result = text;
  for (const entry of entries) {
    if (entry.caseInsensitive) {
      const regex = new RegExp(escapeRegex(entry.real), 'gi');
      result = result.replace(regex, entry.placeholder);
    } else {
      result = result.split(entry.real).join(entry.placeholder);
    }
  }
  return result;
}

/**
 * 将文本中的占位符还原为真实 PII。
 * 对同一占位符映射多个 real 值的情况，使用第一个（primary）。
 */
export function restore(text, entries) {
  if (!text || typeof text !== 'string' || !entries || entries.length === 0) return text;
  let result = text;
  // 去重：每个 placeholder 只用第一个 real 值
  const seen = new Set();
  for (const { real, placeholder } of entries) {
    if (seen.has(placeholder)) continue;
    seen.add(placeholder);
    result = result.split(placeholder).join(real);
  }
  return result;
}

/**
 * 批量 sanitize request body 中的指定字符串字段（原地修改 body）。
 */
export function sanitizeRequestBody(body, fields, entries) {
  if (!entries || entries.length === 0) return;
  for (const field of fields) {
    if (typeof body[field] === 'string') {
      body[field] = sanitize(body[field], entries);
    }
  }
}

/**
 * sanitize resumeLibrary 数组（原地修改）。
 * 每项格式 { name: string, content: string }。
 */
export function sanitizeLibrary(library, entries) {
  if (!Array.isArray(library) || !entries || entries.length === 0) return;
  for (const item of library) {
    if (typeof item.name === 'string') item.name = sanitize(item.name, entries);
    if (typeof item.content === 'string') item.content = sanitize(item.content, entries);
  }
}

/**
 * sanitize chat messages 数组（原地修改）。
 * 支持 string content 和 array content（多模态 content blocks）。
 */
export function sanitizeMessages(messages, entries) {
  if (!Array.isArray(messages) || !entries || entries.length === 0) return;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      msg.content = sanitize(msg.content, entries);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          part.text = sanitize(part.text, entries);
        }
        // 不处理 file/image 类型（base64 数据不做脱敏）
      }
    }
  }
}

/**
 * 创建带缓冲的 SSE 流式恢复器。
 * 处理占位符可能跨 chunk 分割的情况。
 *
 * @param {Array} entries - PII entries
 * @param {function(string)} onFlushed - 恢复后的文本回调
 * @returns {{ push(chunk: string): void, end(): void }}
 */
export function createStreamRestorer(entries, onFlushed) {
  let buffer = '';
  const placeholderPrefixes = new Set(['<', '<<']);
  for (const { placeholder } of entries) {
    for (let i = 1; i < placeholder.length; i++) {
      placeholderPrefixes.add(placeholder.slice(0, i));
    }
  }

  function flush(final) {
    if (!buffer) return;

    // 替换 buffer 中所有完整占位符
    let processed = restore(buffer, entries);

    if (final) {
      // 流结束，发送全部剩余内容
      if (processed) onFlushed(processed);
      buffer = '';
      return;
    }

    // 保留末尾可能被切断的占位符前缀，例如 "<"、"<<"、"<<EMAIL"
    for (let keep = Math.min(processed.length, 32); keep > 0; keep--) {
      const suffix = processed.slice(-keep);
      if (!placeholderPrefixes.has(suffix)) continue;
      const safe = processed.slice(0, -keep);
      if (safe) onFlushed(safe);
      buffer = suffix;
      return;
    }

    // 无未闭合占位符，全部发送
    if (processed) onFlushed(processed);
    buffer = '';
  }

  return {
    push(chunk) {
      buffer += chunk;
      flush(false);
    },
    end() {
      flush(true);
    },
  };
}
