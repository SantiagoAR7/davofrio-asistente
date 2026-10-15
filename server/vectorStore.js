const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const DATA_DIR = path.join(__dirname, '../data');
const CHUNKS_PATH = path.join(DATA_DIR, 'rag_chunks.json');
const VECTORS_PATH = path.join(DATA_DIR, 'rag_vectors.json');
const MANIFEST_PATH = path.join(DATA_DIR, 'rag_manifest.json');
const ERRORS_PATH = path.join(DATA_DIR, 'rag_errors.json');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDataDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadChunks() {
  return readJson(CHUNKS_PATH, []);
}

function saveChunks(chunks) {
  writeJson(CHUNKS_PATH, chunks);
}

function loadVectors() {
  return readJson(VECTORS_PATH, []);
}

function saveVectors(vectors) {
  writeJson(VECTORS_PATH, vectors);
}

function loadManifest() {
  return readJson(MANIFEST_PATH, { files: {} });
}

function saveManifest(manifest) {
  writeJson(MANIFEST_PATH, manifest);
}

function loadErrors() {
  return readJson(ERRORS_PATH, []);
}

function saveErrors(errors) {
  writeJson(ERRORS_PATH, errors);
}

function fileSignature(pdf) {
  return `${pdf.id}|${pdf.size}|${pdf.lastModifiedDateTime}`;
}

function isIndexed(manifest, pdf) {
  const current = manifest.files[pdf.id];
  return current && current.signature === fileSignature(pdf) && current.status === 'indexed';
}

async function embedTexts(texts) {
  if (!texts.length) return [];

  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts
  });

  const ordered = [...res.data].sort((a,b)=>a.index-b.index);
  if (ordered.length !== texts.length || ordered.some((x,i)=>x.index!==i || x.embedding.length!==1536 || x.embedding.some(n=>!Number.isFinite(n)))) throw new Error('Embeddings incompletos o inválidos');
  return ordered.map(x=>x.embedding);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function searchVectorStore(query, options = {}) {
  const topK = options.topK || 8;
  const brand = options.brand || null;

  const chunks = loadChunks();
  const vectors = loadVectors();

  if (!chunks.length || !vectors.length) return [];

  const [queryEmbedding] = await embedTexts([query]);

  const chunkById = new Map(chunks.map(c => [c.id, c]));

  const scored = [];

  for (const v of vectors) {
    const chunk = chunkById.get(v.chunkId);
    if (!chunk) continue;

    if (brand && chunk.metadata.brand && chunk.metadata.brand !== brand) continue;

    const score = cosineSimilarity(queryEmbedding, v.embedding);

    scored.push({
      score,
      chunk
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function removeFileFromStore(fileId) {
  const chunks = loadChunks();
  const vectors = loadVectors();

  const remainingChunks = chunks.filter(c => c.metadata.fileId !== fileId);
  const removedChunkIds = new Set(
    chunks
      .filter(c => c.metadata.fileId === fileId)
      .map(c => c.id)
  );

  const remainingVectors = vectors.filter(v => !removedChunkIds.has(v.chunkId));

  saveChunks(remainingChunks);
  saveVectors(remainingVectors);
}

function appendToStore(newChunks, newVectors) {
  const chunks = loadChunks();
  const vectors = loadVectors();

  saveChunks([...chunks, ...newChunks]);
  saveVectors([...vectors, ...newVectors]);
}

module.exports = {
  CHUNKS_PATH,
  VECTORS_PATH,
  MANIFEST_PATH,
  ERRORS_PATH,
  loadChunks,
  saveChunks,
  loadVectors,
  saveVectors,
  loadManifest,
  saveManifest,
  loadErrors,
  saveErrors,
  fileSignature,
  isIndexed,
  embedTexts,
  searchVectorStore,
  removeFileFromStore,
  appendToStore
};