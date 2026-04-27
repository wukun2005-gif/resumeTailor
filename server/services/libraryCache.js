import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { readFileContent, listResumeFiles } from './fileReader.js';

/**
 * 估算文本的token数量（本地计算，不需要调用AI API）
 * 基于tiktoken的通用经验：
 * - 中文：1个汉字 ≈ 1 token
 * - 英文/数字/标点：平均约4字符 ≈ 1 token
 */
function calculateEstimatedTokens(text) {
  const content = String(text || '');
  
  // 统计中文字符（基本汉字区）
  const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
  
  // 统计CJK扩展字符
  const cjkExtChars = (content.match(/[\u3400-\u4dbf]/g) || []).length;
  
  // 统计日文/韩文字符
  const japaneseChars = (content.match(/[\u3040-\u309f]/g) || []).length;
  const koreanChars = (content.match(/[\uac00-\ud7af]/g) || []).length;
  
  // 统计其他字符（英文、数字、标点等）
  const otherChars = content.length - chineseChars - cjkExtChars - japaneseChars - koreanChars;
  
  // Token估算：中文≈1 token/字符，其他≈4字符/1 token
  return Math.ceil(
    chineseChars * 1.0 +
    cjkExtChars * 1.0 +
    japaneseChars * 1.0 +
    koreanChars * 1.0 +
    otherChars / 4
  );
}

const CACHE_DIR = '.resume-tailor-cache';
const CACHE_FILE = 'digest.json';
const CACHE_SCHEMA_VERSION = 'digest-v8';
const POSITIVE_FILE_NAME_PATTERNS = [
  /resume/i,
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
const FULL_PRESERVE_EXACT_NAMES = new Set([
  'Written Essay.txt',
  '项目经历.txt',
  'Resume Tailor APP - PRD.md',
]);
export { FULL_PRESERVE_EXACT_NAMES, CACHE_SCHEMA_VERSION };
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
  /(?:preferred|nice to have|bonus|加分|优先考虑)/i,
  /(?:you will|you'll|you are|we are looking)/i,
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
/**
 * Matches a full date (year + month) embedded in a filename, e.g. "2026-04-15" or "2026.04".
 * Used to identify delivery-version files (Layer 2).
 */
const DATED_DELIVERY_FILE_PATTERN = /(?:19|20)\d{2}[-.](?:0?[1-9]|1[0-2])(?:[-.]\d{1,2})?/;
/**
 * Matches 4-digit month-day suffixes used in older resume versions, e.g. "_0102", "_0808".
 */
const MMDD_SUFFIX_PATTERN = /_(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?=[._\s]|$)/;
/**
 * Matches resume/cover-letter files that target a specific company or role,
 * indicating a delivery version rather than a canonical base resume.
 * Looks for "_xxx" or "- Company/Role" qualifiers after the base name.
 */
const TARGETED_RESUME_PATTERN = /(?:resume|cv|cover[_\s-]?letter|cover_letter|求职信|简历|cv).*[-_](\w{3,})/i;
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
 * @returns {Promise<{digest: Array<{name: string, content: string}>, fromCache: boolean, sourceTokens: number, digestTokens: number}>}
 */
export async function getLibraryDigest(dirPath, excludeNames = []) {
  const files = await listResumeFiles(dirPath);
  const excludeSet = new Set(excludeNames);
  const targetFiles = files.filter(
    f => f.readable && !excludeSet.has(f.name) && !isExportedDigestArtifactFileName(f.name),
  );

  if (targetFiles.length === 0) return { digest: [], fromCache: false, sourceTokens: 0, digestTokens: 0 };

  const cacheKey = buildCacheKey(targetFiles);
  const cachePath = path.join(dirPath, CACHE_DIR, CACHE_FILE);
  const cached = await loadCache(cachePath);
  if (cached && cached.key === cacheKey) {
    const digestTokens = cached.digest.reduce((sum, item) => sum + calculateEstimatedTokens(item.content), 0);
    // Recalculate sourceTokens for backward compatibility with old caches that don't have it
    let recalculatedSourceTokens = 0;
    // Use targetFiles (same files as sortedFiles, just different order - doesn't affect token count)
    for (const f of targetFiles) {
      try {
        const content = await readFileContent(path.join(dirPath, f.name));
        recalculatedSourceTokens += calculateEstimatedTokens(content);
      } catch {
        // Skip files that fail to read
      }
    }
    return { digest: cached.digest, fromCache: true, sourceTokens: recalculatedSourceTokens, digestTokens };
  }

  // Layer ordering: 0 = full-preserve originals first, 1 = base resumes, 2 = dated delivery versions last.
  // Layer 2 files are processed after layer 0+1 content is registered, so their blocks are aggressively
  // deduplicated against earlier content — only genuinely novel blocks from delivery versions survive.
  const sortedFiles = [...targetFiles].sort((a, b) => classifyFileLayer(a.name) - classifyFileLayer(b.name));

  const seenHashes = new Set();
  const seenFingerprints = [];
  const digest = [];

  for (const f of sortedFiles) {
    try {
      const content = await readFileContent(path.join(dirPath, f.name));
      const paragraphs = extractRelevantParagraphs(f.name, content);
      const layer = classifyFileLayer(f.name);
      const uniqueParagraphs = [];

      for (const para of paragraphs) {
        const hash = hashParagraph(para);
        if (seenHashes.has(hash)) continue;

        const fingerprint = fingerprintParagraph(para);
        // Layer 2 files use a stricter (lower) similarity threshold: blocks that are >65% similar
        // to already-seen content are suppressed. Layer 0/1 use the standard threshold.
        const novel = layer === 2
          ? isNovelFingerprintStrict(fingerprint, seenFingerprints)
          : isNovelFingerprint(fingerprint, seenFingerprints);
        if (!novel) continue;

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

  // Calculate sourceTokens: total tokens of all original file contents
  let sourceTokens = 0;
  for (const f of sortedFiles) {
    try {
      const content = await readFileContent(path.join(dirPath, f.name));
      sourceTokens += calculateEstimatedTokens(content);
    } catch {
      // Skip files that fail to read
    }
  }

  // Calculate digestTokens: total tokens of digest content
  const digestTokens = digest.reduce((sum, item) => sum + calculateEstimatedTokens(item.content), 0);

  await saveCache(cachePath, { key: cacheKey, digest, sourceTokens });

  return { digest, fromCache: false, sourceTokens, digestTokens };
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

    if (kind === 'bullet') {
      flush();
      current = [cleaned];
      currentKind = kind;
      continue;
    }

    // Bug fix: timeline lines (e.g. "Microsoft | Sr PM | 2022-2025") are emitted as standalone
    // paragraphs — like headings — so that the achievement lines that follow them in
    // no-blank-line formatted files become independent blocks and can be deduplicated
    // across different resume versions that share the same employer/date header.
    if (kind === 'timeline') {
      flush();
      paragraphs.push(cleaned);
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

    // Flush when the accumulated text is already a self-contained sentence (>=80 chars).
    // This keeps shared career facts as standalone blocks so they can be deduplicated
    // even when adjacent lines differ between resume versions (e.g. PDF-extracted content
    // with no blank-line separators).
    const currentText = current.join(' ');
    if (currentText.length >= 80 || shouldStartNewBlock(cleaned, current)) {
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

/**
 * Stricter variant used for Layer 2 (dated delivery-version) files.
 * Suppresses blocks that are >=65% similar to already-seen content, catching
 * rephrased versions of the same career fact across multiple tailored resumes.
 */
function isNovelFingerprintStrict(candidate, seenFingerprints) {
  if (!candidate.value) return false;
  if (candidate.tokens.length < 4) {
    return !seenFingerprints.some(existing => existing.value === candidate.value);
  }
  for (const existing of seenFingerprints) {
    if (!existing.value) continue;
    if (candidate.value === existing.value) return false;
    const maxTokens = Math.max(candidate.tokens.length, existing.tokens.length);
    if (maxTokens === 0) return false;
    // Wider gap tolerance (0.55) and lower similarity threshold (0.65) vs standard (0.45 / 0.82).
    const tokenGap = Math.abs(candidate.tokens.length - existing.tokens.length) / maxTokens;
    if (tokenGap > 0.55) continue;
    const threshold = maxTokens >= 12 ? 0.65 : maxTokens >= 8 ? 0.72 : 0.82;
    if (similarity(candidate.tokens, existing.tokens) >= threshold) return false;
  }
  return true;
}

/**
 * Classify a file into a processing layer:
 *  0 — full-preserve original materials (Essay / PRD / Spec / 项目经历)
 *      → always processed first; never suppressed by strict dedup
 *  1 — base resumes / cover letters without a dated-delivery suffix
 *      → processed second with standard dedup threshold
 *  2 — dated delivery versions (filename contains YYYY-MM, YYYY-MM-DD, MMDD suffix,
 *      or a company/role qualifier appended to a base resume/cover-letter name)
 *      → processed last with strict dedup; only genuinely novel blocks survive
 *
 * @param {string} fileName
 * @returns {0|1|2}
 */
function classifyFileLayer(fileName) {
  const name = String(fileName || '').trim();
  if (FULL_PRESERVE_EXACT_NAMES.has(name)) return 0;
  if (FULL_PRESERVE_FILE_NAME_PATTERNS.some(p => p.test(name))) return 0;
  // Full YYYY-MM or YYYY-MM-DD date in filename → always a dated delivery version.
  if (DATED_DELIVERY_FILE_PATTERN.test(name)) return 2;
  // 4-digit MMDD suffix (e.g. WuKun_SWPM_CV_0102.docx) → dated delivery version.
  if (MMDD_SUFFIX_PATTERN.test(name)) return 2;
  // resume/cv/cover-letter file with a company/role qualifier → targeted delivery version.
  // E.g. resume_wukun_deepseek_agent.txt, cover_letter_wukun_kairos.txt
  const nameLower = name.toLowerCase().replace(/\.[^.]+$/, '');
  const isCoverLetter = /^cover[_\s-]?letter|^求职信/.test(nameLower);
  const isResumeFamily = isCoverLetter
    || /^(?:resume|cv|简历)/.test(nameLower)
    || /(?:resume|cv)$/.test(nameLower);
  if (isResumeFamily) {
    const tokens = nameLower.split(/[-_\s]+/).filter(Boolean);
    const nonAuthorTokens = tokens.filter(t => !/^(?:wukun|wu|kun|resume|cv|cover|letter|简历|求职信|s|short|cn|zh|en)$/.test(t));
    // Cover letters with 1+ qualifier are targeted; resumes need 2+ to avoid false positives.
    const required = isCoverLetter ? 1 : 2;
    if (nonAuthorTokens.length >= required) return 2;
  }
  return 1;
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
  if (POSITIVE_FILE_NAME_PATTERNS.some(pattern => pattern.test(name))) return true;
  if (jdScore >= 2 && careerScore < 2) return false;
  return careerScore >= 2;
}

function shouldPreserveFullFile(fileName, content) {
  const name = String(fileName || '').trim();
  const normalized = normalizeLooseText(content);
  if (!name || !normalized) return false;
  if (FULL_PRESERVE_EXACT_NAMES.has(name)) return true;
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
  
  const jdScore = getJdSignalScore(cleaned);
  const careerScore = getCareerSignalScore(cleaned);
  
  // 原有：jdScore > 0 且无 career 信号则过滤
  if (jdScore > 0 && careerScore === 0) return false;
  // 新增：JD 信号显著（>=2）且压过 career 信号时也过滤
  if (jdScore >= 2 && jdScore >= careerScore) return false;
  
  return careerScore > 0;
}

function isLikelyBoilerplateParagraph(text) {
  const lower = text.toLowerCase();
  if (SECTION_HEADING_PATTERN.test(text)) return true;
  if (/^[-_=|•◇◆▪▸►·\s]+$/.test(text)) return true;
  if (PAGE_ARTIFACT_PATTERN.test(text) && getCareerSignalScore(text) === 0) return true;
  if (CONTACT_PATTERN.test(text) && getCareerSignalScore(text) === 0 && text.length < 140) return true;
  if (/^(?:wu kun|kun wu|吴坤)$/.test(lower)) return true;
  // 新增：纯日期行
  if (/^\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?$/.test(text.trim())) return true;
  // 新增：PDF 页脚/水印
  if (/confidential|机密|draft|草稿/i.test(text) && text.length < 60) return true;
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
  // Standalone boilerplate words (e.g. PDF watermarks) — treat as noise
  // to prevent them from merging with adjacent career content.
  if (/^(?:confidential|机密|draft|草稿)$/i.test(line.trim())) return 'noise';
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
  // 新增：当前行以动词开头且已有内容时拆分
  if (currentLength >= 60 && ACTION_VERB_PATTERN.test(line)) return true;
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

// ============================================================================
// AI Preprocessing Cache Functions
// ============================================================================

/**
 * Build cache key for AI preprocessing (includes prompt, model, and piiEnabled).
 * AI cache invalidates when: files change OR prompt changes OR model changes OR piiEnabled changes.
 */
function buildAiCacheKey(files, preprocessInstructions, preprocessorModel, piiEnabled) {
  const instructionsHash = crypto.createHash('md5').update(String(preprocessInstructions || '').trim()).digest('hex').slice(0, 8);
  const data = [
    CACHE_SCHEMA_VERSION,
    'ai-mode',
    preprocessorModel || 'default',
    instructionsHash,
    `pii:${piiEnabled ? '1' : '0'}`,
    ...files.map(f => `${f.name}:${new Date(f.modified).getTime()}`)
  ].join('|');
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Get AI preprocessed library from cache.
 * Returns null if cache doesn't exist or doesn't match (mode !== 'ai' or piiEnabled mismatch).
 * 
 * @param {string} dirPath - Library directory path
 * @param {string} preprocessInstructions - User's preprocessing instructions
 * @param {string} preprocessorModel - Model ID used for preprocessing
 * @param {boolean} piiEnabled - Whether PII sanitization was enabled during preprocessing
 * @returns {Promise<{exportText: string, sourceTokens: number, digestTokens: number, fromCache: true} | null>}
 */
export async function getAiPreprocessedLibrary(dirPath, preprocessInstructions, preprocessorModel, piiEnabled) {
  const files = await listResumeFiles(dirPath);
  const targetFiles = files.filter(
    f => f.readable && !isExportedDigestArtifactFileName(f.name)
  );

  if (targetFiles.length === 0) return null;

  const cacheKey = buildAiCacheKey(targetFiles, preprocessInstructions, preprocessorModel, piiEnabled);
  const cachePath = path.join(dirPath, CACHE_DIR, CACHE_FILE);
  const cached = await loadCache(cachePath);

  // Validate cache: must be AI mode with matching key and piiEnabled
  if (!cached || cached.mode !== 'ai' || cached.key !== cacheKey) {
    return null;
  }

  // Additional piiEnabled validation for backward compatibility with old caches
  if (cached.piiEnabled !== undefined && cached.piiEnabled !== piiEnabled) {
    return null;
  }

  return {
    exportText: cached.exportText || '',
    sourceTokens: cached.sourceTokens || 0,
    digestTokens: cached.digestTokens || 0,
    fromCache: true
  };
}

/**
 * Save AI preprocessing result to cache.
 * 
 * @param {string} dirPath - Library directory path
 * @param {string} exportText - The preprocessed text output
 * @param {number} sourceTokens - Token count of source files
 * @param {number} digestTokens - Token count of preprocessed output
 * @param {string} preprocessInstructions - User's preprocessing instructions
 * @param {string} preprocessorModel - Model ID used for preprocessing
 * @param {boolean} piiEnabled - Whether PII sanitization was enabled during preprocessing
 */
export async function saveAiDigestCache(dirPath, exportText, sourceTokens, digestTokens, preprocessInstructions, preprocessorModel, piiEnabled) {
  const files = await listResumeFiles(dirPath);
  const targetFiles = files.filter(
    f => f.readable && !isExportedDigestArtifactFileName(f.name)
  );

  const cacheKey = buildAiCacheKey(targetFiles, preprocessInstructions, preprocessorModel, piiEnabled);
  const cachePath = path.join(dirPath, CACHE_DIR, CACHE_FILE);

  const cacheData = {
    mode: 'ai',
    key: cacheKey,
    digest: [{ name: '__ai_preprocessed__', content: exportText }],
    exportText,
    sourceTokens,
    digestTokens,
    preprocessInstructions: String(preprocessInstructions || '').trim().slice(0, 200),
    preprocessorModel: preprocessorModel || 'default',
    piiEnabled: !!piiEnabled,
    updatedAt: new Date().toISOString()
  };

  await saveCache(cachePath, cacheData);
}

/**
 * Read raw library files for AI preprocessing.
 * Unlike getLibraryDigest, this does NOT apply local dedup - returns raw content.
 * Still excludes prompt/template files and exported digest artifacts.
 * 
 * @param {string} dirPath - Library directory path
 * @param {string[]} excludeNames - File names to exclude
 * @returns {Promise<{files: Array<{name: string, content: string}>, sourceTokens: number}>}
 */
export async function readRawLibraryFiles(dirPath, excludeNames = []) {
  const files = await listResumeFiles(dirPath);
  const excludeSet = new Set(excludeNames);
  const targetFiles = files.filter(
    f => f.readable && !excludeSet.has(f.name) && !isExportedDigestArtifactFileName(f.name)
  );

  const result = [];
  let sourceTokens = 0;

  for (const f of targetFiles) {
    // Skip negative pattern files (prompts, reviews, etc.)
    if (NEGATIVE_FILE_NAME_PATTERNS.some(pattern => pattern.test(f.name))) continue;
    
    try {
      const content = await readFileContent(path.join(dirPath, f.name));
      if (content && content.trim()) {
        result.push({ name: f.name, content });
        sourceTokens += calculateEstimatedTokens(content);
      }
    } catch {
      // Skip files that fail to read
    }
  }

  return { files: result, sourceTokens };
}
