require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { downloadPDF } = require('./onedrive');
const { extractPDFText } = require('./pdfExtractor');
const { chunkText } = require('./chunker');
const { embedTexts } = require('./vectorStore');
const { supabase } = require('./supabaseVectorStore');
const { detectDocumentBrand } = require('./queryAnalyzer');
const { readJson, writeJson } = require('./jsonStore');
const STATE_PATH = path.join(__dirname, '../data/supabase_index_state.json');

const DATA_DIR = path.join(__dirname, '../data');
const INVENTORY_PATH = path.join(DATA_DIR, 'rag_inventory_filtered.json');

const LIMIT = Number(process.env.RAG_BATCH_LIMIT || 25);
const START_FROM = Number(process.env.RAG_START_FROM || 0);
const MAX_PDF_SIZE = 30 * 1024 * 1024;
const UPSERT_BATCH_SIZE = 12;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadInventory() {
  if (!fs.existsSync(INVENTORY_PATH)) {
    throw new Error('No existe data/rag_inventory_filtered.json. Primero ejecuta filter-rag-inventory.js.');
  }

  const data = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));

  if (!data.pdfs || !data.pdfs.length) {
    throw new Error('rag_inventory_filtered.json no contiene PDFs.');
  }

  return data.pdfs;
}

const detectBrandFromPath = detectDocumentBrand;

async function indexOnePDF(pdf, indexNumber, total) {
  console.log(`\n[${indexNumber}/${total}] PDF: ${pdf.name}`);
  console.log(`Ruta: ${pdf.folderPath}`);
  console.log(`Tamaño MB: ${(pdf.size / 1024 / 1024).toFixed(2)}`);
  console.log(`Tipo documento: ${pdf.documentType || 'otro_tecnico'} | Prioridad: ${pdf.ragPriority || 0}`);

  if (pdf.size > MAX_PDF_SIZE) {
    throw new Error('PDF demasiado grande para indexación automática (>30MB)');
  }


  const buf = await downloadPDF(pdf.id);
  const extracted = await extractPDFText(buf, pdf.name);

  if (!extracted.text || extracted.text.length < 300) {
    throw new Error(`Texto insuficiente: ${extracted.chars} chars, método=${extracted.method}`);
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
    readable: extracted.readable,
    documentType: pdf.documentType || 'otro_tecnico',
    ragPriority: pdf.ragPriority || 0,
    ragReasons: pdf.ragReasons || []
  });

  if (!chunks.length) {
    throw new Error('No se generaron chunks');
  }

  const allRows = [];

  for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
    const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);
    const embeddings = await embedTexts(batch.map(c => c.content));

    const rows = batch.map((chunk, j) => {
      const m = chunk.metadata || {};

      return {
        id: chunk.id,
        file_id: m.fileId,
        file_name: m.fileName,
        folder_path: m.folderPath || null,
        brand: m.brand || null,
        web_url: m.webUrl || null,
        chunk_index: m.chunkIndex || 0,
        content: chunk.content,
        tokens: chunk.tokens || null,
        embedding: '[' + embeddings[j].join(',') + ']',
        method: m.method || null,
        readable: m.readable || null,
        modified: m.modified || null,
        document_type: m.documentType || 'otro_tecnico',
        rag_priority: m.ragPriority || 0
      };
    });

    allRows.push(...rows);
    console.log(`  Embeddings preparados: ${allRows.length}/${chunks.length}`);

    await sleep(300);
  }

  const {error} = await supabase.rpc('replace_rag_file', {p_file_id:pdf.id,p_rows:allRows});
  if (error) throw new Error('No se pudo reemplazar el manual atómicamente: ' + error.message);

  console.log(
    `OK: marca=${brand} chunks=${chunks.length} chars=${extracted.chars} method=${extracted.method} readable=${extracted.readable}`
  );

  return {
    status: 'indexed',
    chunks: chunks.length,
    brand,
    documentType: pdf.documentType || 'otro_tecnico',
    ragPriority: pdf.ragPriority || 0
  };
}

async function main(onProgress = () => {}) {
  console.log('BUILD RAG SUPABASE');
  console.log('Inventario:', INVENTORY_PATH);
  console.log('Límite tanda:', LIMIT);
  console.log('Empezar desde índice:', START_FROM);

  const pdfs = loadInventory();
  const state = readJson(STATE_PATH,{nextStartFrom:0});
  const startFrom = process.env.RAG_START_FROM === undefined ? state.nextStartFrom : START_FROM;
  if (!Number.isInteger(startFrom) || startFrom < 0 || !Number.isInteger(LIMIT) || LIMIT < 1) throw new Error('Límites de indexación inválidos');
  // Check the atomic RPC before downloading PDFs or spending on embeddings. This probe cannot mutate any file.
  const probe = await supabase.rpc('replace_rag_file',{p_file_id:null,p_rows:[]});
  if (!probe.error || !probe.error.message.includes('A nonempty file replacement is required')) {
    throw new Error('Instala migrations/001_rag_atomic.sql antes de indexar');
  }

  let processed = 0;
  let indexed = 0;
  let errors = 0;

  for (let i = startFrom; i < pdfs.length; i++) {
    if (processed >= LIMIT) break;

    const pdf = pdfs[i];

    try {
      await indexOnePDF(pdf, i + 1, pdfs.length);
      indexed++;
      writeJson(STATE_PATH,{nextStartFrom:i+1,updatedAt:new Date().toISOString()});
    } catch (err) {
      errors++;
      console.error(`ERROR en ${pdf.name}: ${err.message}`);
      onProgress({processed:processed+1,indexed,errors,error:err.message});
      return {processed:processed+1,indexed,errors,nextStartFrom:i,error:err.message};
    }

    processed++;
    onProgress({processed,indexed,errors});
    await sleep(500);
  }

  console.log('\nRESUMEN TANDA SUPABASE');
  console.log({
    processed,
    indexed,
    errors,
    nextStartFrom: startFrom + processed
  });

  console.log('\nPara continuar:');
  console.log(`RAG_START_FROM=${startFrom + processed} RAG_BATCH_LIMIT=${LIMIT} node server/build-rag-supabase.js`);
  return {processed,indexed,errors,nextStartFrom:startFrom+processed};
}

if (require.main === module) main().then(r=>{if(r.errors)process.exitCode=1;}).catch(err => {
  console.error('ERROR GENERAL:', err.message); process.exitCode=1;
});
module.exports = {main,indexOnePDF,loadInventory,detectBrandFromPath};
