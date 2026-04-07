import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { readFileContent, listResumeFiles } from './fileReader.js';

const CACHE_DIR = '.resume-tailor-cache';
const CACHE_FILE = 'digest.json';

/**
 * Build a deduplicated digest of library files.
 * - Reads all readable files in the directory
 * - Splits each file into paragraphs (by blank lines)
 * - Deduplicates paragraphs across files using content hash
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
  const targetFiles = files.filter(f => f.readable && !excludeSet.has(f.name));

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
  const digest = [];

  for (const f of targetFiles) {
    try {
      const content = await readFileContent(path.join(dirPath, f.name));
      const paragraphs = splitParagraphs(content);
      const uniqueParagraphs = [];

      for (const para of paragraphs) {
        const hash = hashParagraph(para);
        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          uniqueParagraphs.push(para);
        }
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
  const cachePath = path.join(dirPath, CACHE_DIR, CACHE_FILE);
  const cached = await loadCache(cachePath);
  if (!cached) return; // No cache to update

  // Collect existing paragraph hashes
  const seenHashes = new Set();
  for (const item of cached.digest) {
    for (const para of splitParagraphs(item.content)) {
      seenHashes.add(hashParagraph(para));
    }
  }

  // Deduplicate new file's paragraphs
  const paragraphs = splitParagraphs(fileContent);
  const uniqueParagraphs = paragraphs.filter(para => {
    const hash = hashParagraph(para);
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });

  if (uniqueParagraphs.length > 0) {
    cached.digest.push({ name: fileName, content: uniqueParagraphs.join('\n\n') });
  }

  // Invalidate the cache key so it will be rebuilt on next full request
  // (the file list has changed)
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
  // Normalize whitespace before hashing for better dedup
  const normalized = text.replace(/\s+/g, ' ').trim();
  return crypto.createHash('md5').update(normalized).digest('hex');
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
