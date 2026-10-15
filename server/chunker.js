const { encoding_for_model } = require('@dqbd/tiktoken');
const enc = encoding_for_model('text-embedding-3-small');
const decoder = new TextDecoder('utf-8', { fatal: true });
const CHUNKER_VERSION = '2';
function tokenCount(text) { return enc.encode(text || '').length; }

// Token slices must end at a Unicode boundary: a token may contain half a character.
function chunkText(text, metadata = {}, options = {}) {
  const maxTokens = options.maxTokens ?? 350;
  const overlapTokens = options.overlapTokens ?? 50;
  if (!Number.isInteger(maxTokens) || maxTokens < 8 || !Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new RangeError('Se requiere maxTokens >= 8 y 0 <= overlapTokens < maxTokens');
  }
  const clean = (text || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!clean) return [];
  const tokens = enc.encode(clean);
  const chunks = [];
  let start = 0;
  while (start < tokens.length) {
    let end = Math.min(start + maxTokens, tokens.length);
    let content;
    while (end > start) {
      try { content = decoder.decode(enc.decode(tokens.slice(start, end))); break; }
      catch { end--; }
    }
    if (end === start) throw new Error('No se pudo dividir texto UTF-8');
    chunks.push({ id: `${metadata.fileId || 'file'}_${chunks.length}`, content, tokens: tokenCount(content),
      metadata: { ...metadata, chunkIndex: chunks.length, chunkerVersion: CHUNKER_VERSION, tokenStart: start, tokenEnd: end } });
    if (end === tokens.length) break;
    let next = Math.max(start + 1, end - overlapTokens);
    // Advance to the next complete code point before starting the overlap.
    while (next < end) {
      try { decoder.decode(enc.decode(tokens.slice(next, end))); break; } catch { next++; }
    }
    start = next;
  }
  return chunks;
}
module.exports = { chunkText, tokenCount, CHUNKER_VERSION };
