/**
 * INDEXADOR DE MANUALES
 * Usa pdftotext (poppler) para extracción robusta de PDFs con fonts especiales
 * Guarda contenido completo en disco — se carga en memoria al arrancar
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const TOKEN_PATH = path.join(__dirname, '../data/drive_token.json');
const INDEX_PATH = path.join(__dirname, '../data/manual_index.json');

const BRANDS = [
  { n: 'DAIKIN',              id: '1yA1gZpbZ7phKP5X9ZNfrSWIb4TpplVtw', c: '#378ADD' },
  { n: 'LG',                  id: '1LfTjYZ0Ei8Ye5ijJLCxu84bupL3he8w6', c: '#7F77DD' },
  { n: 'HITACHI',             id: '1rXbXvJVisTScgojZgBhx5sFhRp79_8LT', c: '#EF9F27' },
  { n: 'MITSUBISHI ELECTRIC', id: '1Jw76z5H65MSu2mei-lEKZk89gH3eumgz', c: '#D4537E' },
  { n: 'MITSUBISHI DAYA',     id: '1TdKqNP0Gx5xMquYC-tlfdvx9EvJRNk80', c: '#E24B4A' },
  { n: 'SAMSUNG',             id: '1NQ6BuxqG1Y7XgbOaCIdKLzrt4_HBmnV6', c: '#1D9E75' },
  { n: 'PANASONIC',           id: '1TExCaqRYpnm1kXHrYRj5TQBYrz5Qoa5P', c: '#0F6E56' },
  { n: 'BOSCH',               id: '14kbJxP1xblUfc9kFZStRURqiazIVQiC_', c: '#BA7517' },
  { n: 'HISENSE',             id: '1uH-HFgUhllFhL3Bovznz6HdcBMQogCCE', c: '#185FA5' },
  { n: 'HAIER',               id: '1iD5do39y7ii1t0PrDf4GE3zlIe7btI63', c: '#D85A30' },
  { n: 'ATLANTIC',            id: '1G3Efa9k_CzSSsSiRnX80b01YMKmHH9Ug', c: '#639922' },
  { n: 'MUDOCLIMA',           id: '1kUXWCrIgkIqPK7k0N3HZ5oU6LDPVwzrj', c: '#884FA2' },
  { n: 'ECOFOREST',           id: '1337jtDQ2sFWNKlEPr5tHMjDX07gtuAAT', c: '#3B6D11' },
  { n: 'BLUEBOX',             id: '1aYBPq1JCnnxsDXGU-bGyDkhC2T8axYL0', c: '#185FA5' },
  { n: 'HTW',                 id: '16tQAxsWD1kt8O2FEfXyAkECuCXOUlHwu', c: '#5F5E5A' },
  { n: 'KAYSUN',              id: '1wVjb91OOKtt7O458pmOR2PxBWny8GMtJ', c: '#993C1D' },
  { n: 'DAITSU',              id: '1TUMkY9p4jKQ7fcMaZx1V96nyBVNn-Ev8', c: '#533AB7' },
  { n: 'MIDEA',               id: '1IXDZ3qjhBxWuvs7Cw8hwSm-x7Lz2UhpI', c: '#D4537E' },
];

// ── IN-MEMORY INDEX ───────────────────────────────────────────────────────────
let _index = null;

function loadIndex() {
  if (_index) return _index;
  if (!fs.existsSync(INDEX_PATH)) {
    _index = { manuals: [], indexedAt: null };
    return _index;
  }
  try {
    _index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    console.log('Indice cargado: ' + _index.manuals.length + ' manuales');
    return _index;
  } catch (e) {
    console.error('Error cargando indice:', e.message);
    _index = { manuals: [], indexedAt: null };
    return _index;
  }
}

function saveIndex(idx) {
  _index = idx;
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx));
  var kb = Math.round(fs.statSync(INDEX_PATH).size / 1024);
  console.log('Indice guardado: ' + idx.manuals.length + ' manuales (' + kb + 'KB)');
}

// ── GOOGLE AUTH ───────────────────────────────────────────────────────────────
function getAuth() {
  if (!fs.existsSync(TOKEN_PATH)) throw new Error('No hay token de Drive.');
  var token = JSON.parse(fs.readFileSync(TOKEN_PATH));
  var auth = new google.auth.OAuth2(
    '363962271835-8tgevb8mlab5st0qm4hdu3kmcgljopkq.apps.googleusercontent.com',
    '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',
    'urn:ietf:wg:oauth:2.0:oob'
  );
  auth.setCredentials(token);
  return auth;
}

async function listPDFs(folderId) {
  var drive = google.drive({ version: 'v3', auth: getAuth() });
  var res = await drive.files.list({
    q: "'" + folderId + "' in parents and mimeType='application/pdf' and trashed=false",
    fields: 'files(id,name,size,modifiedTime)',
    pageSize: 100
  });
  return res.data.files || [];
}

async function downloadPDF(fileId) {
  var drive = google.drive({ version: 'v3', auth: getAuth() });
  var res = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ── PDF TEXT EXTRACTION ───────────────────────────────────────────────────────
// Try pdftotext first (better for special fonts), fallback to pdf-parse
function extractWithPdftotext(pdfBuffer) {
  var tmpPdf = path.join(os.tmpdir(), 'davofrio_' + Date.now() + '.pdf');
  var tmpTxt = tmpPdf.replace('.pdf', '.txt');
  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);
    // -layout preserves table structure, -enc UTF-8 for proper encoding
    execSync('pdftotext -layout -enc UTF-8 "' + tmpPdf + '" "' + tmpTxt + '"', { timeout: 30000 });
    var text = fs.readFileSync(tmpTxt, 'utf8');
    return { text: text, method: 'pdftotext' };
  } catch (e) {
    return null;
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch(e) {}
    try { fs.unlinkSync(tmpTxt); } catch(e) {}
  }
}

async function extractWithPdfParse(pdfBuffer) {
  try {
    var pdfParse = require('pdf-parse');
    var parsed = await pdfParse(pdfBuffer, { max: 150 });
    return { text: parsed.text, pages: parsed.numpages, method: 'pdf-parse' };
  } catch (e) {
    return null;
  }
}

// Quality check: detect corrupted/unreadable text
function isReadable(text) {
  if (!text || text.length < 100) return false;
  // Check ratio of readable characters
  var readable = (text.match(/[a-zA-Z0-9áéíóúñüÁÉÍÓÚÑÜ\s.,;:()?!%°\-+\/=]/g) || []).length;
  var ratio = readable / text.length;
  return ratio > 0.5; // at least 50% readable chars
}

async function parsePDF(buffer, fileName) {
  // Try pdftotext first
  var result = extractWithPdftotext(buffer);
  if (result && isReadable(result.text)) {
    console.log('    [pdftotext] ' + Math.round(result.text.length/1000) + 'k chars');
    return result;
  }

  // Fallback to pdf-parse
  result = await extractWithPdfParse(buffer);
  if (result && isReadable(result.text)) {
    console.log('    [pdf-parse] ' + Math.round(result.text.length/1000) + 'k chars');
    return result;
  }

  // Both failed — return whatever we got with a warning
  console.log('    [WARN] texto de baja calidad en ' + fileName);
  return result || { text: '', method: 'failed' };
}

// ── FULL INDEX BUILD ──────────────────────────────────────────────────────────
async function buildIndex(onProgress) {
  var idx = { manuals: [], indexedAt: new Date().toISOString() };

  for (var bi = 0; bi < BRANDS.length; bi++) {
    var brand = BRANDS[bi];
    onProgress && onProgress('Marca: ' + brand.n);
    var files = [];
    try {
      files = await listPDFs(brand.id);
    } catch (e) {
      onProgress && onProgress('  Sin acceso: ' + e.message);
      continue;
    }

    for (var fi = 0; fi < files.length; fi++) {
      var file = files[fi];
      onProgress && onProgress('  PDF: ' + file.name);
      try {
        if (file.size && parseInt(file.size) > 50 * 1024 * 1024) {
          onProgress && onProgress('    Saltado (muy grande)');
          continue;
        }
        var buf = await downloadPDF(file.id);
        var parsed = await parsePDF(buf, file.name);
        idx.manuals.push({
          uid:          brand.id + '_' + file.id,
          brandId:      brand.id,
          brand:        brand.n,
          brandColor:   brand.c,
          fileId:       file.id,
          fileName:     file.name,
          chars:        parsed.text.length,
          modifiedTime: file.modifiedTime,
          method:       parsed.method,
          content:      parsed.text
        });
      } catch (e) {
        onProgress && onProgress('    Error: ' + e.message);
      }
    }
  }

  saveIndex(idx);
  return idx;
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
function searchManuals(query) {
  var idx = loadIndex();
  if (!idx.manuals || !idx.manuals.length) return [];

  var q = query.toLowerCase().trim();
  var codePattern = /\b([a-z]{0,3}\d{1,3}[-_]?\d{0,3})\b/gi;
  var rawCodes = q.match(codePattern) || [];
  var codes = [];
  rawCodes.forEach(function(c) {
    var up = c.toUpperCase();
    codes.push(up);
    codes.push(up.replace(/([A-Z]+)(\d)/, '$1-$2'));
    codes.push(up.replace(/([A-Z]+)(\d)/, '$1 $2'));
  });
  codes = [...new Set(codes)];

  var results = [];
  for (var i = 0; i < idx.manuals.length; i++) {
    var manual = idx.manuals[i];
    if (!manual.content) continue;
    var contentUp = manual.content.toUpperCase();
    var score = 0;

    for (var ci = 0; ci < codes.length; ci++) {
      var code = codes[ci];
      var regex = new RegExp('\\b' + code.replace(/[-]/g, '[-]?') + '\\b', 'g');
      var matches = manual.content.match(regex);
      if (matches) score += matches.length * 10;
    }

    if (q.includes(manual.brand.toLowerCase())) score += 50;

    var words = q.split(/\s+/).filter(function(w) { return w.length > 3; });
    words.forEach(function(word) {
      if (contentUp.includes(word.toUpperCase())) score += 2;
    });

    if (score > 0) results.push({ manual: manual, score: score });
  }

  return results.sort(function(a, b) { return b.score - a.score; });
}

function getBrandManuals(brandId) {
  var idx = loadIndex();
  return idx.manuals.filter(function(m) { return m.brandId === brandId; });
}

function getManualContent(uid) {
  var idx = loadIndex();
  return idx.manuals.find(function(m) { return m.uid === uid; }) || null;
}

module.exports = { buildIndex, searchManuals, getManualContent, getBrandManuals, loadIndex, BRANDS };
