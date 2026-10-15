require('dotenv').config();

const { listLimitedPDFs, downloadPDF } = require('./onedrive');
const { extractPDFText } = require('./pdfExtractor');
const { chunkText } = require('./chunker');

const {
  loadManifest,
  saveManifest,
  loadErrors,
  saveErrors,
  fileSignature,
  isIndexed,
  embedTexts,
  removeFileFromStore,
  appendToStore
} = require('./vectorStore');

const { detectDocumentBrand: detectBrandFromPath } = require('./queryAnalyzer');

async function indexPDF(pdf) {
  const manifest = loadManifest();

  if (isIndexed(manifest, pdf)) {
    return { status: 'skipped', pdf };
  }


  const buf = await downloadPDF(pdf.id);
  const extracted = await extractPDFText(buf, pdf.name);

  if (!extracted.text || extracted.text.length < 300) {
    throw new Error(`Texto insuficiente extraído: ${extracted.chars} chars, método ${extracted.method}`);
  }

  const brand = detectBrandFromPath(pdf);

  const chunks = chunkText(extracted.text, {
    fileId: pdf.id,
    fileName: pdf.name,
    folderPath: pdf.folderPath,
    webUrl: pdf.webUrl,
    brand,
    modified: pdf.lastModifiedDateTime,
    method: extracted.method,
    readable: extracted.readable
  });

  if (!chunks.length) {
    throw new Error('No se generaron chunks');
  }

  const batchSize = 64;
  const vectors = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const embeddings = await embedTexts(batch.map(c => c.content));

    for (let j = 0; j < batch.length; j++) {
      vectors.push({
        chunkId: batch[j].id,
        fileId: pdf.id,
        embedding: embeddings[j]
      });
    }
  }

  removeFileFromStore(pdf.id);
  appendToStore(chunks, vectors);

  manifest.files[pdf.id] = {
    signature: fileSignature(pdf),
    status: 'indexed',
    fileName: pdf.name,
    folderPath: pdf.folderPath,
    brand,
    chunks: chunks.length,
    chars: extracted.chars,
    method: extracted.method,
    readable: extracted.readable,
    indexedAt: new Date().toISOString()
  };

  saveManifest(manifest);

  return {
    status: 'indexed',
    pdf,
    chunks: chunks.length,
    chars: extracted.chars,
    method: extracted.method,
    readable: extracted.readable,
    brand
  };
}

async function indexFolderBatch(folderPath, limit = 10, onProgress = console.log) {
  onProgress(`Buscando hasta ${limit} PDFs en: ${folderPath}`);

  const pdfs = await listLimitedPDFs(folderPath, limit, onProgress);

  onProgress(`PDFs seleccionados: ${pdfs.length}`);

  const results = [];

  for (let i = 0; i < pdfs.length; i++) {
    const pdf = pdfs[i];

    try {
      onProgress(`\n[${i + 1}/${pdfs.length}] Indexando: ${pdf.name}`);
      const result = await indexPDF(pdf);

      results.push(result);

      onProgress(
        `OK: ${result.status} | marca=${result.brand || '-'} | chunks=${result.chunks || 0} | method=${result.method || '-'} | readable=${result.readable || '-'}`
      );
    } catch (err) {
      const errors = loadErrors();

      errors.push({
        fileId: pdf.id,
        fileName: pdf.name,
        folderPath: pdf.folderPath,
        error: err.message,
        ts: new Date().toISOString()
      });

      saveErrors(errors);

      results.push({ status: 'error', pdf, error: err.message });

      onProgress(`ERROR: ${err.message}`);
    }
  }

  return results;
}

module.exports = {
  indexPDF,
  indexFolderBatch,
  detectBrandFromPath
};