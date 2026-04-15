import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { readFileContent, listResumeFiles } from './fileReader.js';

const CACHE_DIR = '.resume-tailor-cache';
const CACHE_FILE = 'digest.json';

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
 * - Splits each file into paragraphs (by blank lines)
 * - Removes likely irrelevant JD/recruitment paragraphs
 * - Deduplicates exact + near-duplicate paragraphs across files
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

  // Build cache key from file names + modification times
  const cacheKey = buildCacheKey(targetFiles);

  // Try to load from disk cache
  const cachePath = path.join(dirPath, CACHE_DIR, CACHE_FILE);
  const cached = await loadCache(cachePath);
  if (cached && cached.key === cacheKey) {
    return { digest: cached.digest, fromCache: true };
  }

  // Read all files and build deduplicated digest
  const seenHashes = new Set();
  const seenFingerprints = [];
  const digest = [];

  for (const f of targetFiles) {
    try {
      const content = await readFileContent(path.join(dirPath, f.name));
      const paragraphs = splitParagraphs(content);
      const uniqueParagraphs = [];

      for (const para of paragraphs) {
        if (isLikelyIrrelevantParagraph(para)) continue;
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

  // Save to disk cache
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
  if (!cached) return; // No cache to update

  const seenHashes = new Set();
  const seenFingerprints = [];
  for (const item of cached.digest) {
    for (const para of splitParagraphs(item.content)) {
      seenHashes.add(hashParagraph(para));
      seenFingerprints.push(fingerprintParagraph(para));
    }
  }

  const paragraphs = splitParagraphs(fileContent);
  const uniqueParagraphs = paragraphs.filter(para => {
    if (isLikelyIrrelevantParagraph(para)) return false;
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
  const data = files.map(f => `${f.name}:${new Date(f.modified).getTime()}`).join('|');
  return crypto.createHash('md5').update(data).digest('hex');
}

function splitParagraphs(text) {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

function hashParagraph(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return crypto.createHash('md5').update(normalized).digest('hex');
}

function isLikelyIrrelevantParagraph(text) {
  const t = String(text || '').trim();
  if (!t) return true;

  const cleaned = t.replace(/\s+/g, ' ');
  if (cleaned.length < 8) return true;

  const lower = cleaned.toLowerCase();
  const jdPatterns = [
    /岗位职责|任职要求|职位描述|职位要求|岗位要求|工作职责|招聘|我们正在寻找|薪资|福利|加分项|投递/,
    /\b(job description|job responsibilities|responsibilities|requirements|qualifications|preferred|what you'll do|what we offer|about the role|hiring)\b/,
  ];
  const resumePatterns = [
    /工作经历|项目经历|教育背景|个人简介|技能|成果|经历|resume|cv|experience|education|summary|achievements?/i,
  ];
  const jdHit = jdPatterns.some(p => p.test(lower));
  const resumeHit = resumePatterns.some(p => p.test(cleaned));
  if (jdHit && !resumeHit) return true;

  return false;
}

function fingerprintParagraph(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}\p{N}\s#]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNovelFingerprint(candidate, seenFingerprints) {
  if (!candidate) return false;
  for (const existing of seenFingerprints) {
    if (!existing) continue;
    if (candidate === existing) return false;
    if (similarity(candidate, existing) >= 0.92) return false;
  }
  return true;
}

function similarity(a, b) {
  const aTokens = new Set(a.split(' ').filter(Boolean));
  const bTokens = new Set(b.split(' ').filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
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
