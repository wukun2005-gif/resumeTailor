import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { readFileContent, listResumeFiles } from './fileReader.js';

const CACHE_DIR = '.resume-tailor-cache';
const CACHE_FILE = 'digest.json';
const CACHE_SCHEMA_VERSION = 'digest-v5';
const POSITIVE_FILE_NAME_PATTERNS = [
  /\bresume\b/i,
  /\bcv\b/i,
  /简历/,
  /求职信/,
  /cover[_ -]?letter/i,
  /项目经历/,
  /project[_ -]?experience/i,
];
const FULL_PRESERVE_FILE_NAME_PATTERNS = [
  /\b(?:prd|spec|specification|architecture|design|model)\b/i,
  /\b(?:essay|agent|finance)\b/i,
  /项目经历|需求文档|架构设计|规格书/,
  /project[_ -]?experience/i,
];
const FULL_PRESERVE_CONTENT_PATTERNS = [
  /\b(?:mvp\s+specification|product requirements? document|functional spec|technical spec|design spec|specification|prd)\b/i,
  /产品需求文档|需求文档|规格说明|规格书/,
];
const NEGATIVE_FILE_NAME_PATTERNS = [
  /\bprompt\b/i,
  /提示词/,
  /\barena\b/i,
  /评审|评分|打分|得分/,
  /\breview\b/i,
  /\bscore\b/i,
  /^AGENTS\.md$/i,
  /^README(?:\.[^.]+)?$/i,
  /^DESIGN(?:\.[^.]+)?$/i,
];
const JD_PATTERNS = [
  /(?:岗位职责|职位描述|工作职责|工作内容|what you'll do|responsibilities)/i,
  /(?:任职要求|职位要求|岗位要求|最低资格|优先资格|教育背景要求|qualifications|requirements)/i,
  /(?:加分项|福利|我们正在寻找|薪资|about the role|what we offer)/i,
  /(?:招聘|投递|role number|posted|hiring|job description)/i,
];
const PROMPT_PATTERNS = [
  /下面是职位jd|下面是面向这个jd|给每个版本打分|哪个版本最好|请根据.*jd|请改写|请润色|请重写|请你评审|通过.*筛选/,
  /\b(job description below|score each version|rate each version|which version is best|please rewrite|please tailor|please improve|evaluate the following|rewrite the resume)\b/i,
];
const DATE_RANGE_PATTERN = /(?:19|20)\d{2}(?:[./-](?:0?[1-9]|1[0-2]))?\s*[–—~-]\s*(?:present|now|至今|(?:19|20)\d{2}(?:[./-](?:0?[1-9]|1[0-2]))?)/i;
const YEARS_EXPERIENCE_PATTERN = /\b\d{1,2}\+?\s*years?\b|\d+\+?\s*年(?:工作)?经验/i;
const TITLE_PATTERN = /\b(?:program|project|product|technical|software|ai|ml|senior|staff|principal|lead|head)\b.{0,30}\b(?:manager|engineer|developer|scientist|architect|director|analyst|consultant|designer|owner)\b|产品经理|项目经理|程序经理|工程师|研发负责人|负责人|总监|顾问|架构师/i;
const ACTION_VERB_PATTERN = /\b(?:led|built|drove|delivered|managed|designed|defined|improved|launched|created|developed|evaluated|optimized|standardized|established|implemented|coordinated|partnered|planned|executed|invented|organized|shipped|ported|governed)\b|主导|推动|负责|设计|交付|管理|优化|提升|建立|实现|开发|协调|规划|推进|构建|评估|发明|落地|组织|制定/i;
const METRIC_PATTERN = /%|\b(?:ndcg|wer|cer|dau|mau|roi|sla|latency|revenue|accuracy|precision|recall)\b|增长|提升|降低|减少|准确率|满意度|效率|收入|营收/i;
const EDUCATION_CERT_PATTERN = /\b(?:education|certifications?|certificate|credentials?|master(?:'s)?|bachelor(?:'s)?|patents?)\b|教育背景|学历|硕士|本科|专利|认证/i;
const COMPANY_HINT_PATTERN = /\b(?:inc|corp|ltd|co\.|university|microsoft|apple|amazon|google|nokia|motorola|siemens|panasonic|tesla|samsung|nike|nestl[eé]|bosch|meituan|bytedance)\b|微软|苹果|亚马逊|谷歌|美团|字节|诺基亚|摩托罗拉|西门子|松下|博世|耐克|雀巢/i;
const COVER_LETTER_PATTERN = /\b(?:dear hiring manager|sincerely|i am applying|look forward to contributing|attached please check the latest resume)\b|尊敬的招聘经理|希望申请|详细简历请见附件|此致|敬礼/i;
const CONTACT_PATTERN = /\b(?:email|e-mail|phone|mobile|linkedin|github)\b|https?:\/\/|@\w+/i;
const PAGE_ARTIFACT_PATTERN = /\bpage\s+\d+\s*(?:of|\/)\s*\d+\b|\bpage of \d+\s+\d+\b/i;
const SECTION_HEADING_PATTERN = /^(?:\[?\s*)?(?:executive summary|summary|professional experience|work experience|experience|core skills|core competencies|skills?|education|certifications?|credentials|patents?|career objective|cover letter|project experience|key project experience|responsibility|achievement(?:s)?(?:\s*&\s*contribution)?|个人简介|工作经历|项目经历|项目经验|教育背景|技能|核心竞争力|求职信|工作经验|证书|认证|专利|职责|成果)(?:\s*\]?)?(?:\s*[:：])?$/i;
const FINGERPRINT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'of', 'on', 'or', 'that', 'the', 'their', 'these', 'this', 'those', 'to',
  'through', 'use', 'used', 'using', 'via', 'was', 'were', 'will', 'with', 'within',
]);

/**
 * Names produced by「导出预处理文本素材库」——若参与 digest 会形成导出套导出，需默认排除。
 * 与前端 `exportDigest` 下载名 `素材库预处理文本-${date}.txt` 一致。
 */
export function isExportedDigestArtifactFileName(name) {
  return /^素材库预处理文本-.*\.txt$/i.test(String(name || '').trim());
}

/**
 * Build a cleaned + deduplicated digest of library files.
 * - Reads all readable files in the directory
 * - Excludes obvious prompt / review / non-career artifact files
 * - Splits resume-like content into smaller semantic blocks
 * - Removes likely irrelevant JD / recruitment / boilerplate blocks
 * - Deduplicates exact + near-duplicate blocks across files
 * - Caches the result to disk, keyed by file names + modification times
 * - Returns array of { name, content } with deduplicated content
 *
 * @param {string} dirPath - Library directory path
 * @param {string[]} excludeNames - File names to exclude from digest
 * @returns {Promise<{digest: Array<{name: string, content: string}>, fromCache: boolean}>}
 */
export async function getLibraryDigest(dirPath, excludeNames = []) {
  const files = await listResumeFiles(dirPath);
  const excludeSet = new Set(excludeNames);
  const targetFiles = files.filter(
    f => f.readable && !excludeSet.has(f.name) && !isExportedDigestArtifactFileName(f.name),
  );

  if (targetFiles.length === 0) return { digest: [], fromCache: false };

  const cacheKey = buildCacheKey(targetFiles);
  const cachePath = path.join(dirPath, CACHE_DIR, CACHE_FILE);
  const cached = await loadCache(cachePath);
  if (cached && cached.key === cacheKey) {
    return { digest: cached.digest, fromCache: true };
  }

  const seenHashes = new Set();
  const seenFingerprints = [];
  const digest = [];

  for (const f of targetFiles) {
    try {
      const content = await readFileContent(path.join(dirPath, f.name));
      const paragraphs = extractRelevantParagraphs(f.name, content);
      const uniqueParagraphs = [];

      for (const para of paragraphs) {
        const hash = hashParagraph(para);
        if (seenHashes.has(hash)) continue;

        const fingerprint = fingerprintParagraph(para);
        if (!isNovelFingerprint(fingerprint, seenFingerprints)) continue;

        seenHashes.add(hash);
        seenFingerprints.push(fingerprint);
        uniqueParagraphs.push(para);
      }

      if (uniqueParagraphs.length > 0) {
        digest.push({ name: f.name, content: uniqueParagraphs.join('\n\n') });
      }
    } catch {
      // Skip files that fail to read
    }
  }

  await saveCache(cachePath, { key: cacheKey, digest });

  return { digest, fromCache: false };
}

/**
 * Append a new file to the digest cache without full rebuild.
 */
export async function appendToDigestCache(dirPath, fileName, fileContent) {
  if (isExportedDigestArtifactFileName(fileName)) return;

  const cachePath = path.join(dirPath, CACHE_DIR, CACHE_FILE);
  const cached = await loadCache(cachePath);
  if (!cached) return;

  const seenHashes = new Set();
  const seenFingerprints = [];
  for (const item of cached.digest) {
    for (const para of splitStoredDigestContent(item.content)) {
      seenHashes.add(hashParagraph(para));
      seenFingerprints.push(fingerprintParagraph(para));
    }
  }

  const paragraphs = extractRelevantParagraphs(fileName, fileContent);
  const uniqueParagraphs = paragraphs.filter(para => {
    const hash = hashParagraph(para);
    if (seenHashes.has(hash)) return false;
    const fingerprint = fingerprintParagraph(para);
    if (!isNovelFingerprint(fingerprint, seenFingerprints)) return false;
    seenHashes.add(hash);
    seenFingerprints.push(fingerprint);
    return true;
  });

  if (uniqueParagraphs.length > 0) {
    cached.digest.push({ name: fileName, content: uniqueParagraphs.join('\n\n') });
  }

  cached.key = '__incremental__';
  await saveCache(cachePath, cached);
}

function buildCacheKey(files) {
  const data = [CACHE_SCHEMA_VERSION, ...files.map(f => `${f.name}:${new Date(f.modified).getTime()}`)].join('|');
  return crypto.createHash('md5').update(data).digest('hex');
}

function splitStoredDigestContent(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean);
}

function extractRelevantParagraphs(fileName, content) {
  const name = String(fileName || '').trim();
  if (NEGATIVE_FILE_NAME_PATTERNS.some(pattern => pattern.test(name))) return [];
  if (shouldPreserveFullFile(fileName, content)) return splitPreservedBlocks(content);
  if (!shouldKeepFile(fileName, content)) return [];
  return splitParagraphs(content).filter(isRelevantCareerParagraph);
}

function splitPreservedBlocks(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .replace(/\f/g, '\n')
    .split('\n');
  const blocks = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    const block = current.join('\n').trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    if (isPreservedStandaloneLine(trimmed)) {
      flush();
      blocks.push(line);
      continue;
    }

    if (shouldStartNewPreservedBlock(trimmed, current)) {
      flush();
    }
    current.push(line);
  }

  flush();
  return blocks;
}

function splitParagraphs(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .replace(/\f/g, '\n')
    .split('\n');
  const paragraphs = [];
  let current = [];
  let currentKind = 'text';

  const flush = () => {
    if (current.length === 0) return;
    const block = normalizeBlock(current);
    if (block) paragraphs.push(block);
    current = [];
    currentKind = 'text';
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }

    const kind = classifyLine(line);
    if (kind === 'noise') {
      flush();
      continue;
    }

    const cleaned = stripLineDecoration(line);
    if (!cleaned) continue;

    if (kind === 'heading') {
      flush();
      paragraphs.push(cleaned);
      continue;
    }

    if (kind === 'bullet' || kind === 'timeline') {
      flush();
      current = [cleaned];
      currentKind = kind;
      continue;
    }

    if (current.length === 0) {
      current = [cleaned];
      currentKind = 'text';
      continue;
    }

    if (currentKind === 'bullet') {
      current.push(cleaned);
      continue;
    }

    if (shouldStartNewBlock(cleaned, current)) {
      flush();
    }
    current.push(cleaned);
  }

  flush();
  return paragraphs;
}

function hashParagraph(text) {
  const normalized = normalizeLooseText(text);
  return crypto.createHash('md5').update(normalized).digest('hex');
}

function fingerprintParagraph(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}\p{N}\s#]/gu, ' ')
    .split(/\s+/)
    .filter(token => token && token.length > 1 && !FINGERPRINT_STOPWORDS.has(token))
    .sort();
  return { value: tokens.join(' '), tokens };
}

function isNovelFingerprint(candidate, seenFingerprints) {
  if (!candidate.value) return false;
  if (candidate.tokens.length < 4) {
    return !seenFingerprints.some(existing => existing.value === candidate.value);
  }
  for (const existing of seenFingerprints) {
    if (!existing.value) continue;
    if (candidate.value === existing.value) return false;
    const maxTokens = Math.max(candidate.tokens.length, existing.tokens.length);
    if (maxTokens === 0) return false;
    const tokenGap = Math.abs(candidate.tokens.length - existing.tokens.length) / maxTokens;
    if (tokenGap > 0.45) continue;
    const threshold = maxTokens >= 12 ? 0.82 : maxTokens >= 8 ? 0.88 : 0.94;
    if (similarity(candidate.tokens, existing.tokens) >= threshold) return false;
  }
  return true;
}

function similarity(aTokens, bTokens) {
  const aSet = new Set(aTokens.filter(Boolean));
  const bSet = new Set(bTokens.filter(Boolean));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  const union = aSet.size + bSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function shouldKeepFile(fileName, content) {
  const name = String(fileName || '').trim();
  const normalized = normalizeLooseText(content);
  if (!name || !normalized) return false;
  if (NEGATIVE_FILE_NAME_PATTERNS.some(pattern => pattern.test(name))) return false;
  if (shouldPreserveFullFile(name, normalized)) return true;

  const promptScore = getPromptSignalScore(normalized);
  const jdScore = getJdSignalScore(normalized);
  const careerScore = getCareerSignalScore(normalized);

  if (promptScore >= 2) return false;
  if (jdScore >= 2) return false;
  if (POSITIVE_FILE_NAME_PATTERNS.some(pattern => pattern.test(name))) return true;
  return careerScore >= 2;
}

function shouldPreserveFullFile(fileName, content) {
  const name = String(fileName || '').trim();
  const normalized = normalizeLooseText(content);
  if (!name || !normalized) return false;
  if (FULL_PRESERVE_FILE_NAME_PATTERNS.some(pattern => pattern.test(name))) return true;
  if (FULL_PRESERVE_CONTENT_PATTERNS.some(pattern => pattern.test(normalized))) {
    return getJdSignalScore(normalized) === 0 || getCareerSignalScore(normalized) >= 2;
  }
  return false;
}

function isRelevantCareerParagraph(text) {
  const cleaned = normalizeLooseText(text);
  if (!cleaned || cleaned.length < 18) return false;
  if (isLikelyBoilerplateParagraph(cleaned)) return false;
  if (getPromptSignalScore(cleaned) > 0) return false;
  if (getJdSignalScore(cleaned) > 0 && getCareerSignalScore(cleaned) === 0) return false;
  return getCareerSignalScore(cleaned) > 0;
}

function isLikelyBoilerplateParagraph(text) {
  const lower = text.toLowerCase();
  if (SECTION_HEADING_PATTERN.test(text)) return true;
  if (/^[-_=|•◇◆▪▸►·\s]+$/.test(text)) return true;
  if (PAGE_ARTIFACT_PATTERN.test(text) && getCareerSignalScore(text) === 0) return true;
  if (CONTACT_PATTERN.test(text) && getCareerSignalScore(text) === 0 && text.length < 140) return true;
  if (/^(?:wu kun|kun wu|吴坤)$/.test(lower)) return true;
  return false;
}

function getCareerSignalScore(text) {
  let score = 0;
  if (YEARS_EXPERIENCE_PATTERN.test(text) || TITLE_PATTERN.test(text)) score += 1;
  if (DATE_RANGE_PATTERN.test(text)) score += 1;
  if (ACTION_VERB_PATTERN.test(text) && (text.length > 40 || METRIC_PATTERN.test(text) || COMPANY_HINT_PATTERN.test(text))) score += 1;
  if (EDUCATION_CERT_PATTERN.test(text)) score += 1;
  if (COVER_LETTER_PATTERN.test(text)) score += 1;
  if (COMPANY_HINT_PATTERN.test(text) && (DATE_RANGE_PATTERN.test(text) || METRIC_PATTERN.test(text) || text.length > 60)) score += 1;
  return score;
}

function getPromptSignalScore(text) {
  let score = PROMPT_PATTERNS.filter(pattern => pattern.test(text)).length;
  const numberedItems = text.match(/(?:^|\s)\d{1,2}[.)](?=\s)/g) || [];
  if (numberedItems.length >= 3) score += 1;
  if (/\b(score|rate|compare|evaluate)\b/i.test(text) || /打分|评审|哪个版本/.test(text)) score += 1;
  return score;
}

function getJdSignalScore(text) {
  let score = JD_PATTERNS.filter(pattern => pattern.test(text)).length;
  if (/description\b/i.test(text) && /qualifications?\b/i.test(text)) score += 1;
  return score;
}

function classifyLine(line) {
  if (!line || /^[-_=]{3,}$/.test(line)) return 'noise';
  if (PAGE_ARTIFACT_PATTERN.test(line) && !DATE_RANGE_PATTERN.test(line)) return 'noise';
  const stripped = stripLineDecoration(line);
  if (!stripped) return 'noise';
  if (SECTION_HEADING_PATTERN.test(stripped)) return 'heading';
  if (/^(?:[-*•◇◆▪▸►·]+|\d{1,2}[.)]|[A-Z][.)])\s+/.test(line)) return 'bullet';
  if (isTimelineLine(stripped)) return 'timeline';
  return 'text';
}

function isTimelineLine(line) {
  return DATE_RANGE_PATTERN.test(line) && (/[|丨｜]/.test(line) || TITLE_PATTERN.test(line) || COMPANY_HINT_PATTERN.test(line));
}

function shouldStartNewBlock(line, currentLines) {
  const currentLength = currentLines.join(' ').length;
  if (currentLength >= 240) return true;
  if (isTimelineLine(line)) return true;
  if (CONTACT_PATTERN.test(line) && currentLength > 0) return true;
  return false;
}

function isPreservedStandaloneLine(line) {
  return SECTION_HEADING_PATTERN.test(line)
    || /^(?:[-*•◇◆▪▸►·]+|\d{1,2}[.)]|[A-Z][.)])\s+/.test(line)
    || isTimelineLine(line)
    || /^#+\s+/.test(line)
    || PAGE_ARTIFACT_PATTERN.test(line);
}

function shouldStartNewPreservedBlock(line, currentLines) {
  if (isPreservedStandaloneLine(line)) return true;
  const currentLength = currentLines.join('\n').length;
  if (currentLength >= 600) return true;
  return false;
}

function normalizeBlock(lines) {
  return lines
    .map(line => stripLineDecoration(line))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLineDecoration(line) {
  return String(line || '')
    .replace(PAGE_ARTIFACT_PATTERN, ' ')
    .replace(/^(?:[-*•◇◆▪▸►·]+|\d{1,2}[.)]|[A-Z][.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLooseText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function loadCache(cachePath) {
  try {
    const data = await fs.readFile(cachePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveCache(cachePath, data) {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(data), 'utf-8');
  } catch {
    // Cache write failure is non-fatal
  }
}
