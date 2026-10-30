/**
 * INDEXADOR DE MANUALES — con OCR via tesseract
 * Nivel 1: pdftotext (mejor calidad, rápido)
 * Nivel 2: pdf-parse (fallback)
 * Nivel 3: tesseract OCR (para PDFs escaneados o con fonts corruptas)
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
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

function toolExists(cmd) {
  try { execSync('which ' + cmd, { timeout: 5000, stdio: 'ignore' }); return true; } catch(e) { return false; }
}
var HAS_PDFTOTEXT = toolExists('pdftotext');
var HAS_PDFTOPPM  = toolExists('pdftoppm');
var HAS_TESSERACT = toolExists('tesseract');
console.log('Herramientas: pdftotext=' + HAS_PDFTOTEXT + ' pdftoppm=' + HAS_PDFTOPPM + ' tesseract=' + HAS_TESSERACT);

function readabilityRatio(text) {
  if (!text || text.length < 50) return 0;
  var sample = text.substring(0, Math.min(text.length, 2000));
  var readable = (sample.match(/[a-zA-Z0-9áéíóúñüÁÉÍÓÚÑÜ\s.,;:()?!\-]/g) || []).length;
  return readable / sample.length;
}
function isGoodQuality(text) { return readabilityRatio(text) >= 0.55; }

function extractPdftotext(buf) {
  if (!HAS_PDFTOTEXT) return null;
  var tmp = path.join(os.tmpdir(), 'davo_' + Date.now());
  var pdf = tmp + '.pdf'; var txt = tmp + '.txt';
  try {
    fs.writeFileSync(pdf, buf);
    execSync('pdftotext -layout -enc UTF-8 "' + pdf + '" "' + txt + '"', { timeout: 60000 });
    if (!fs.existsSync(txt)) return null;
    return fs.readFileSync(txt, 'utf8');
  } catch(e) { return null; }
  finally {
    try { fs.unlinkSync(pdf); } catch(e) {}
    try { fs.unlinkSync(txt); } catch(e) {}
  }
}

async function extractPdfParse(buf) {
  try {
    var pp = require('pdf-parse');
    var r = await pp(buf, { max: 100 });
    return r.text;
  } catch(e) { return null; }
}

function extractOCR(buf, fileName) {
  if (!HAS_PDFTOPPM || !HAS_TESSERACT) return null;
  var tmp = path.join(os.tmpdir(), 'davo_ocr_' + Date.now());
  var pdf = tmp + '.pdf';
  try {
    fs.mkdirSync(tmp + '_pages', { recursive: true });
    fs.writeFileSync(pdf, buf);
    execSync('pdftoppm -r 200 -l 30 "' + pdf + '" "' + tmp + '_pages/page"', { timeout: 120000 });
    var pages = fs.readdirSync(tmp + '_pages').filter(function(f) { return f.endsWith('.ppm'); }).sort();
    console.log('    [OCR] procesando ' + pages.length + ' paginas...');
    var allText = '';
    var limit = Math.min(pages.length, 20);
    for (var i = 0; i < limit; i++) {
      var imgPath = path.join(tmp + '_pages', pages[i]);
      var outBase = path.join(tmp + '_pages', 'out_' + i);
      try {
        execSync('tesseract "' + imgPath + '" "' + outBase + '" -l spa+eng --oem 1 --psm 3 quiet', { timeout: 30000 });
        if (fs.existsSync(outBase + '.txt')) allText += fs.readFileSync(outBase + '.txt', 'utf8') + '\n';
      } catch(e) {
        try {
          execSync('tesseract "' + imgPath + '" "' + outBase + '" -l eng --oem 1 --psm 3 quiet', { timeout: 30000 });
          if (fs.existsSync(outBase + '.txt')) allText += fs.readFileSync(outBase + '.txt', 'utf8') + '\n';
        } catch(e2) {}
      }
    }
    return allText.length > 100 ? allText : null;
  } catch(e) {
    console.log('    [OCR] error: ' + e.message);
    return null;
  } finally {
    try { fs.unlinkSync(pdf); } catch(e) {}
    try {
      var pagesDir = tmp + '_pages';
      if (fs.existsSync(pagesDir)) {
        fs.readdirSync(pagesDir).forEach(function(f) { try { fs.unlinkSync(path.join(pagesDir, f)); } catch(e) {} });
        fs.rmdirSync(pagesDir);
      }
    } catch(e) {}
  }
}

async function parsePDF(buf, fileName) {
  var text = extractPdftotext(buf);
  if (text && isGoodQuality(text)) {
    console.log('    [pdftotext] ' + Math.round(text.length/1000) + 'k chars (' + Math.round(readabilityRatio(text)*100) + '% legible)');
    return { text: text, method: 'pdftotext' };
  }
  var text2 = await extractPdfParse(buf);
  if (text2 && isGoodQuality(text2)) {
    console.log('    [pdf-parse] ' + Math.round(text2.length/1000) + 'k chars (' + Math.round(readabilityRatio(text2)*100) + '% legible)');
    return { text: text2, method: 'pdf-parse' };
  }
  console.log('    [OCR] iniciando para ' + fileName + '...');
  var text3 = extractOCR(buf, fileName);
  if (text3 && text3.length > 200) {
    console.log('    [OCR] ' + Math.round(text3.length/1000) + 'k chars (' + Math.round(readabilityRatio(text3)*100) + '% legible)');
    return { text: text3, method: 'ocr' };
  }
  var best = text || text2 || text3 || '';
  console.log('    [WARN] extraccion limitada: ' + Math.round(readabilityRatio(best)*100) + '% legible');
  return { text: best, method: 'limited' };
}

function getAuth() {
  var token;
  if (process.env.DRIVE_TOKEN_B64) {
    token = JSON.parse(Buffer.from(process.env.DRIVE_TOKEN_B64, 'base64').toString('utf8'));
  } else if (process.env.DRIVE_TOKEN) {
    token = JSON.parse(process.env.DRIVE_TOKEN.trim());
  } else if (fs.existsSync(TOKEN_PATH)) {
    token = JSON.parse(fs.readFileSync(TOKEN_PATH));
  } else {
    throw new Error('No hay token de Drive.');
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Configura GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET para usar Google Drive');
  }
  var auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
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

async function buildIndex(onProgress) {
  var idx = { manuals: [], indexedAt: new Date().toISOString() };
  for (var bi = 0; bi < BRANDS.length; bi++) {
    var brand = BRANDS[bi];
    onProgress && onProgress('Marca: ' + brand.n);
    var files = [];
    try { files = await listPDFs(brand.id); }
    catch (e) { onProgress && onProgress('  Sin acceso: ' + e.message); continue; }
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
          uid: brand.id + '_' + file.id, brandId: brand.id, brand: brand.n,
          brandColor: brand.c, fileId: file.id, fileName: file.name,
          chars: parsed.text.length, modifiedTime: file.modifiedTime,
          method: parsed.method, readable: Math.round(readabilityRatio(parsed.text) * 100),
          content: parsed.text
        });
      } catch (e) { onProgress && onProgress('    Error: ' + e.message); }
    }
  }
  saveIndex(idx);
  return idx;
}

function searchManuals(query) {
  var idx = loadIndex();
  if (!idx.manuals || !idx.manuals.length) return [];
  var q = query.toLowerCase().trim();
  var rawCodes = q.match(/\b([a-z]{0,3}\d{1,3}[-_]?\d{0,3})\b/gi) || [];
  var codes = [];
  rawCodes.forEach(function(c) {
    var up = c.toUpperCase();
    codes.push(up);
    codes.push(up.replace(/([A-Z]+)(\d)/, '$1-$2'));
    codes.push(up.replace(/([A-Z]+)(\d)/, '$1 $2'));
    var numOnly = up.replace(/^[A-Z]+/, '');
    if (numOnly && numOnly !== up) codes.push(numOnly);
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
      var relaxed = new RegExp('[^A-Z0-9]' + code.replace(/[-]/g, '[-]?') + '[^A-Z0-9]', 'gi');
      var relaxedMatches = manual.content.match(relaxed);
      if (relaxedMatches) score += relaxedMatches.length * 5;
    }
    if (q.includes(manual.brand.toLowerCase())) score += 50;
    q.split(/\s+/).filter(function(w) { return w.length > 3; }).forEach(function(w) {
      if (contentUp.includes(w.toUpperCase())) score += 2;
    });
    if (score > 0) {
      results.push({ manual: manual, score: score });
    } else if (codes.length > 0) {
      var hasCode = codes.some(function(code) { return contentUp.indexOf(code) !== -1; });
      if (hasCode) results.push({ manual: manual, score: 2 });
    }
  }
  return results.sort(function(a, b) { return b.score - a.score; });
}

function scoreSnippet(text, searchCode) {
  var score = 0;
  var t = text.toUpperCase();
  var diagKeywords = ['CAUSA','AVERIA','FALLO','VERIFICAR','COMPROBAR','MEDIR','SUSTITUIR',
    'PRESION','VOLTAJE','RESISTENCIA','CONTINUIDAD','OHM','VDC','VAC','BAR',
    'DIAGNOSIS','FAULT','MALFUNCTION','CAUSED','CHECK','REPLACE','ABNORMAL',
    'ERROR','ALARM','PROTECCION','PROTECTION','CIRCUITO'];
  diagKeywords.forEach(function(k) { if (t.includes(k)) score += 3; });
  if (searchCode) {
    var codeIdx = t.indexOf(searchCode);
    if (codeIdx !== -1) {
      var win = t.substring(Math.max(0, codeIdx-100), codeIdx+200);
      diagKeywords.forEach(function(k) { if (win.includes(k)) score += 8; });
      if (win.match(/ERROR|AVERIA|FALLO|ALARM|FAULT|CODE|CODIGO/)) score += 15;
    }
  }
  var dots = (text.match(/\.{3,}/g) || []).length;
  score -= dots * 3;
  var nonAlpha = (text.match(/[^a-zA-Z0-9\s.,;:()?!%°\-+\/=<>áéíóúñüÁÉÍÓÚÑÜ]/g) || []).length;
  if (nonAlpha / Math.max(text.length, 1) > 0.3) score -= 25;
  var spanishWords = (t.match(/\b(VERIFICAR|COMPROBAR|FALLO|AVERIA|PRESION|CIRCUITO|UNIDAD|INTERIOR|EXTERIOR)\b/g) || []).length;
  var englishOnly = (t.match(/\b(MALFUNCTION|CAUSED|FAULTY|ABNORMALITY|DURING|STARTUP)\b/g) || []).length;
  if (englishOnly > 3 && spanishWords === 0) score -= 5;
  return score;
}

function extractRelevantContext(manuals, query) {
  var rawCodes = query.toUpperCase().match(/\b([A-Z]{0,3}\d{1,3}[-_]?\d{0,3})\b/g) || [];
  var codes = [];
  rawCodes.forEach(function(code) {
    codes.push(code);
    codes.push(code.replace(/([A-Z]+)(\d)/, '$1-$2'));
    codes.push(code.replace(/([A-Z]+)(\d)/, '$1 $2'));
  });
  codes = [...new Set(codes)];
  var allSnippets = [];
  var maxTotal = 16000;

  for (var i = 0; i < manuals.length; i++) {
    var m = manuals[i];
    if (!m.content) continue;
    var contentUp = m.content.toUpperCase();
    var fn = m.fileName.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    var isRepair = fn.match(/REPARAC|AVERIA|ERROR|CODIGO|FAULT|TROUBLE|DIAGNOS/) ? true : false;
    var isCatalog = fn.match(/CATALOG|DATABOOK|INSTALAC|INSTALL|CONFIGURAC|CONFIG|TRAINING|FORMAC/) ? true : false;
    for (var ci = 0; ci < codes.length; ci++) {
      var code = codes[ci];
      var searchPos = 0; var found = 0;
      while (found < 10) {
        var pos = contentUp.indexOf(code, searchPos);
        if (pos === -1) break;
        var start = Math.max(0, pos - 100);
        var end = Math.min(m.content.length, pos + 3500);
        var snippet = m.content.substring(start, end);
        var score = scoreSnippet(snippet, code);
        if (m.readable >= 90) score += 10;
        if (isRepair) score += 20;
        if (isCatalog) score -= 10;
        if (pos < 50000) score += 10;
        allSnippets.push({ fileName: m.fileName, snippet: snippet, score: score, pos: pos });
        searchPos = pos + code.length; found++;
      }
    }
  }

  for (var i = 0; i < manuals.length; i++) {
    var m = manuals[i];
    if (!m.content) continue;
    var contentUp = m.content.toUpperCase();
    var fn2 = m.fileName.toUpperCase().split('').map(function(ch) {
      return {'Á':'A','É':'E','Í':'I','Ó':'O','Ú':'U','Ñ':'N'}[ch] || ch;
    }).join('');
    var isRepair2 = fn2.match(/REPARAC|AVERIA|ERROR|CODIGO|FAULT|TROUBLE|DIAGNOS/) ? true : false;
    for (var ci = 0; ci < codes.length; ci++) {
      var code = codes[ci];
      var sectionRegex = /\d+\.\d+\./g; var sMatch;
      while ((sMatch = sectionRegex.exec(contentUp)) !== null) {
        var sPos = sMatch.index;
        var sectionTitle = contentUp.substring(sPos, sPos + 100);
        var titleHasCode = new RegExp('\\b' + code + '\\b').test(sectionTitle);
        if (titleHasCode) {
          var start = sPos; var end = Math.min(m.content.length, sPos + 4000);
          var snippet = m.content.substring(start, end);
          var score = scoreSnippet(snippet, code);
          if (m.readable >= 90) score += 10;
          if (isRepair2) score += 30;
          score += 50;
          allSnippets.push({ fileName: m.fileName, snippet: snippet, score: score, pos: sPos });
        }
      }
    }
  }

  allSnippets.sort(function(a, b) { return b.score - a.score; });
  var sections = [], totalChars = 0, seenFiles = {};
  for (var si = 0; si < allSnippets.length; si++) {
    var s = allSnippets[si];
    if (s.score < -5) continue;
    if (totalChars >= maxTotal) break;
    if (!seenFiles[s.fileName]) { seenFiles[s.fileName] = true; sections.push('=== ' + s.fileName + ' ==='); }
    sections.push(s.snippet);
    totalChars += s.snippet.length;
  }

  if (totalChars < 500 && codes.length > 0) {
    for (var fi = 0; fi < manuals.length; fi++) {
      var fm = manuals[fi];
      if (!fm.content) continue;
      var fup = fm.content.toUpperCase();
      for (var fci = 0; fci < codes.length; fci++) {
        var fpos = fup.indexOf(codes[fci]);
        if (fpos !== -1) {
          var fstart = Math.max(0, fpos - 200);
          var fend = Math.min(fm.content.length, fpos + 3000);
          var fsnippet = fm.content.substring(fstart, fend);
          if (!seenFiles[fm.fileName]) { seenFiles[fm.fileName] = true; sections.push('=== ' + fm.fileName + ' ==='); }
          sections.push(fsnippet);
          totalChars += fsnippet.length;
          if (totalChars >= maxTotal) break;
        }
      }
      if (totalChars >= 500) break;
    }
  }
  return sections.join('\n\n');
}

function getBrandManuals(brandId) {
  var idx = loadIndex();
  return idx.manuals.filter(function(m) { return m.brandId === brandId; });
}

function getManualContent(uid) {
  var idx = loadIndex();
  return idx.manuals.find(function(m) { return m.uid === uid; }) || null;
}

module.exports = { buildIndex, searchManuals, getManualContent, getBrandManuals, loadIndex, BRANDS, extractRelevantContext };
