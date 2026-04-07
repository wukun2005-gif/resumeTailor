import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function readFileContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.txt': case '.md': return await fs.readFile(filePath, 'utf-8');
    case '.html': return await readHtml(filePath);
    case '.pdf': return await readPdf(filePath);
    case '.docx': return await readDocx(filePath);
    case '.pages': throw new Error('PAGES_NOT_SUPPORTED');
    default: throw new Error(`不支持的文件格式: ${ext}`);
  }
}

async function readHtml(filePath) {
  const html = await fs.readFile(filePath, 'utf-8');
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&\w+;/g, '').replace(/\s+/g, ' ').trim();
}

async function readPdf(filePath) {
  // 使用 Poppler pdftotext，-raw 紧凑输出（省 token），`-` 输出到 stdout
  const { stdout } = await execFileAsync('pdftotext', ['-raw', filePath, '-']);
  return stdout;
}

async function readDocx(filePath) {
  const mammoth = (await import('mammoth')).default;
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function listResumeFiles(dirPath) {
  const supportedExts = ['.pages', '.pdf', '.html', '.txt', '.md', '.docx'];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('~$') || entry.name.startsWith('.')) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!supportedExts.includes(ext)) continue;
    const stat = await fs.stat(path.join(dirPath, entry.name));
    files.push({ name: entry.name, ext, size: stat.size, modified: stat.mtime, readable: ext !== '.pages' });
  }
  const order = { '.txt': 0, '.md': 1, '.html': 2, '.docx': 3, '.pdf': 4, '.pages': 5 };
  files.sort((a, b) => (order[a.ext] ?? 99) - (order[b.ext] ?? 99) || a.name.localeCompare(b.name));
  return files;
}
