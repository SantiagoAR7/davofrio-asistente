const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const cleanText = text => (text || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n\n').trim();
function readabilityRatio(text) {
  if (!text || text.length < 50) return 0;
  const sample = text.slice(0, 10000);
  return (sample.match(/[\p{L}\p{N}\p{P}\p{Z}\p{S}\s]/gu) || []).length / [...sample].length;
}
async function extractPDFText(buf) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'davofrio-pdf-'));
  const pdf = path.join(dir, 'input.pdf');
  try {
    await fs.writeFile(pdf, buf);
    let pages;
    try {
      const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', pdf, '-'], { timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
      pages = stdout.split('\f');
      if (!pages.at(-1).trim()) pages.pop();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('No se pudo extraer el PDF completo: ' + error.message);
      const parsed = await require('pdf-parse')(buf); // No page truncation.
      const text = cleanText(parsed.text);
      if (text.length < 300 || readabilityRatio(text) < 0.7) throw new Error('PDF requiere OCR; instala Poppler y Tesseract');
      return { text, method: 'pdf-parse', chars: text.length, readable: Math.round(readabilityRatio(text) * 100), pages: parsed.numpages, complete: true };
    }
    let ocrPages = 0;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].trim().length >= 50 && readabilityRatio(pages[i]) >= 0.7) continue;
      // OCR every low-text page, including pages after the former 15-page cutoff.
      const prefix = path.join(dir, 'page');
      await run('pdftoppm', ['-f', String(i + 1), '-l', String(i + 1), '-singlefile', '-r', '180', '-png', pdf, prefix], { timeout: 90000 });
      const { stdout } = await run('tesseract', [prefix + '.png', 'stdout', '-l', process.env.OCR_LANGUAGES || 'spa+eng', '--oem', '1', '--psm', '3'], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      pages[i] = stdout;
      ocrPages++;
    }
    const text = cleanText(pages.join('\n\n'));
    if (text.length < 300 || readabilityRatio(text) < 0.7) throw new Error('Texto insuficiente o ilegible; PDF no indexado');
    return { text, method: ocrPages ? 'pdftotext+ocr' : 'pdftotext', chars: text.length, readable: Math.round(readabilityRatio(text) * 100), pages: pages.length, ocrPages, complete: true };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
module.exports = { extractPDFText, readabilityRatio };
