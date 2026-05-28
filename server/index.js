require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const { load, save } = require('./db');
const { buildIndex, searchManuals, getBrandManuals, loadIndex, BRANDS } = require('./indexer');
const { addSolution, getSolutions, voteHelpful, getAllSolutions } = require('./solutions');
const { addResource, getResources, deleteResource, getAllResources } = require('./resources');

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'davofrio-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function admin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  next();
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const db = load();
  const user = db.users.find(u => u.username === username && u.active);
  if (!user) return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
  req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role };
  const db2 = load();
  db2.history.push({ type: 'login', userId: user.id, username: user.username, name: user.name, ts: new Date().toISOString() });
  save(db2);
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: req.session.user }));

// ── INDEX ─────────────────────────────────────────────────────────────────────
app.get('/api/index/status', auth, (req, res) => {
  const idx = loadIndex();
  res.json({
    total: idx.manuals ? idx.manuals.length : 0,
    indexedAt: idx.indexedAt,
    brands: BRANDS.map(b => ({
      ...b,
      count: idx.manuals ? idx.manuals.filter(m => m.brandId === b.id).length : 0
    }))
  });
});

app.post('/api/index/build', admin, async (req, res) => {
  res.json({ ok: true, message: 'Indexacion iniciada' });
  buildIndex(msg => console.log(msg)).catch(e => console.error('Error indexando:', e));
});

// ── SEARCH ────────────────────────────────────────────────────────────────────
app.post('/api/search', auth, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query requerida' });

  const results = searchManuals(query);
  const byBrand = {};

  for (const r of results.slice(0, 30)) {
    const key = r.manual.brand;
    if (!byBrand[key]) byBrand[key] = [];
    byBrand[key].push({
      uid: r.manual.uid,
      brandId: r.manual.brandId,
      brand: r.manual.brand,
      brandColor: r.manual.brandColor,
      fileName: r.manual.fileName,
      score: r.score
    });
  }

  const brands = Object.values(byBrand);
  res.json({
    results: brands,
    total: results.length,
    multiMatch: brands.length > 1,
    singleBrandId: brands.length === 1 ? brands[0][0].brandId : null,
    singleBrand: brands.length === 1 ? brands[0][0].brand : null
  });
});

// ── EXTRACT RELEVANT SNIPPETS ─────────────────────────────────────────────────
// Instead of sending the first N chars of each manual, extract the sections
// where the error code actually appears — much more useful context for the model
// Score a snippet: higher = more useful diagnostic content
function scoreSnippet(text) {
  var score = 0;
  var t = text.toUpperCase();
  // Diagnostic keywords
  var keywords = ['CAUSA', 'AVERIA', 'FALLO', 'ERROR', 'VERIFICAR', 'COMPROBAR', 'MEDIR',
    'SUSTITUIR', 'REEMPLAZAR', 'PRESION', 'VOLTAJE', 'RESISTENCIA', 'TENSION',
    'CONTINUIDAD', 'CORTOCIRCUITO', 'SI', 'NO', 'OHM', 'VDC', 'VAC', 'BAR',
    'CAUSE', 'CHECK', 'MEASURE', 'REPLACE', 'VERIFY', 'PRESSURE', 'VOLTAGE',
    'RESISTANCE', 'DIAGNOSIS', 'MALFUNCTION', 'FAULT'];
  keywords.forEach(function(k) {
    if (t.includes(k)) score += 3;
  });
  // Penalize index-like content (lots of dots = table of contents)
  var dots = (text.match(/\.{3,}/g) || []).length;
  score -= dots * 2;
  // Penalize corrupt content (high ratio of non-alphanumeric)
  var nonAlpha = (text.match(/[^a-zA-Z0-9\s.,;:()?!%°\-+/=<>áéíóúñüÁÉÍÓÚÑÜ]/g) || []).length;
  var ratio = nonAlpha / Math.max(text.length, 1);
  if (ratio > 0.3) score -= 20; // heavily corrupted
  return score;
}

function extractRelevantContext(manuals, query) {
  var codeMatches = query.toUpperCase().match(/\b([A-Z]{0,3}\d{1,3}[-_]?\d{0,3})\b/g) || [];
  var codes = [...new Set(codeMatches)];

  // Add variants: CH05 -> CH-05, CH 05; U77 -> U-77
  var extraCodes = [];
  codes.forEach(function(code) {
    extraCodes.push(code.replace(/([A-Z]+)(\d)/, '$1-$2'));
    extraCodes.push(code.replace(/([A-Z]+)(\d)/, '$1 $2'));
    var numOnly = code.replace(/^[A-Z]+/, '');
    if (numOnly && numOnly !== code) extraCodes.push(numOnly);
  });
  codes = [...new Set([...codes, ...extraCodes])];

  var allSnippets = []; // { fileName, snippet, score }
  var maxTotal = 16000;

  for (var m of manuals) {
    if (!m.content) continue;
    var content = m.content;
    var contentUp = content.toUpperCase();

    for (var code of codes) {
      var searchPos = 0;
      var occurrences = [];

      // Collect ALL occurrences of this code in this manual
      while (occurrences.length < 10) {
        var pos = contentUp.indexOf(code, searchPos);
        if (pos === -1) break;
        occurrences.push(pos);
        searchPos = pos + code.length;
      }

      // For each occurrence, extract snippet and score it
      occurrences.forEach(function(pos) {
        var start = Math.max(0, pos - 300);
        var end = Math.min(content.length, pos + 2500);
        var snippet = content.substring(start, end);
        var score = scoreSnippet(snippet);
        allSnippets.push({ fileName: m.fileName, brand: m.brand, snippet: snippet, score: score, code: code });
      });
    }
  }

  // Sort by score descending — best diagnostic content first
  allSnippets.sort(function(a, b) { return b.score - a.score; });

  // Build context from top snippets up to maxTotal chars
  var sections = [];
  var totalChars = 0;
  var seenFiles = {};

  for (var s of allSnippets) {
    if (s.score < -5) continue; // skip heavily corrupted
    if (totalChars >= maxTotal) break;
    var header = '=== ' + s.fileName + ' ===';
    if (!seenFiles[s.fileName]) {
      seenFiles[s.fileName] = true;
      sections.push(header);
    }
    sections.push(s.snippet);
    totalChars += s.snippet.length;
  }

  return sections.join('\n\n');
}

// ── QUERY ─────────────────────────────────────────────────────────────────────
app.post('/api/query', auth, async (req, res) => {
  const { query, brandId, history = [], sessionId } = req.body;
  const user = req.session.user;
  if (!query) return res.status(400).json({ error: 'Query requerida' });

  var brandName = null;
  var contextContent = '';
  var manualNames = [];

  if (brandId) {
    var brandManuals = getBrandManuals(brandId);
    if (brandManuals.length > 0) {
      brandName = brandManuals[0].brand;
      // Extract only the relevant sections where the error code appears
      contextContent = extractRelevantContext(brandManuals, query);
      manualNames = brandManuals.map(function(m) { return m.fileName; });
      console.log('Contexto extraido para ' + brandName + ': ' + contextContent.length + ' chars de ' + brandManuals.length + ' manuales');
    }
  }

  var codeMatch = query.match(/\b([A-Za-z]{0,3}\d{1,3}[-_]?\d{0,3})\b/);
  var errorCode = codeMatch ? codeMatch[1].toUpperCase() : null;
  var pastSolutions = errorCode ? getSolutions(errorCode, brandName) : [];

  var systemPrompt = buildSystemPrompt(brandName, contextContent, pastSolutions);

  var messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-12),
    { role: 'user', content: query }
  ];

  try {
    var completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      max_tokens: 2500,
      temperature: 0.1
    });

    var answer = completion.choices[0].message.content;

    var db = load();
    db.history.push({
      type: 'query',
      sessionId: sessionId || null,
      userId: user.id,
      username: user.username,
      name: user.name,
      brand: brandName || 'desconocida',
      brandId: brandId || null,
      errorCode: errorCode,
      query: query,
      answer: answer,
      ts: new Date().toISOString(),
      tokens: completion.usage ? completion.usage.total_tokens : 0
    });
    save(db);

    var resources = errorCode ? getResources(errorCode, brandName) : [];
    res.json({ answer: answer, brand: brandName, brandId: brandId || null, errorCode: errorCode, resources: resources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── SOLUTIONS ─────────────────────────────────────────────────────────────────
app.post('/api/solutions', auth, (req, res) => {
  var data = req.body;
  if (!data.solution) return res.status(400).json({ error: 'La solucion no puede estar vacia' });
  addSolution({
    code: data.code, brand: data.brand, manualUid: data.manualUid,
    manualName: data.manualName, problem: data.problem, solution: data.solution,
    techName: req.session.user.name, techId: req.session.user.id
  });
  res.json({ ok: true });
});

app.post('/api/solutions/:id/helpful', auth, (req, res) => {
  voteHelpful(req.params.id);
  res.json({ ok: true });
});

app.get('/api/solutions', auth, (req, res) => {
  res.json(getSolutions(req.query.code, req.query.brand));
});

app.get('/api/admin/solutions', admin, (req, res) => {
  res.json(getAllSolutions(req.query));
});

// ── RESOURCES ─────────────────────────────────────────────────────────────────
app.get('/api/resources', auth, (req, res) => {
  res.json(getResources(req.query.code, req.query.brand));
});

app.post('/api/resources', admin, (req, res) => {
  var d = req.body;
  if (!d.title || !d.url) return res.status(400).json({ error: 'Titulo y URL requeridos' });
  res.json(addResource({ code: d.code, brand: d.brand, manualUid: d.manualUid, title: d.title, url: d.url, type: d.type, uploadedBy: req.session.user.name }));
});

app.delete('/api/resources/:id', admin, (req, res) => {
  deleteResource(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/resources', admin, (req, res) => res.json(getAllResources()));

// ── ADMIN HISTORY ─────────────────────────────────────────────────────────────
app.get('/api/admin/history', admin, (req, res) => {
  var db = load();
  var q = req.query;
  var hist = db.history.filter(function(h) { return h.type === 'query'; });
  if (q.userId) hist = hist.filter(function(h) { return h.userId == q.userId; });
  if (q.brand) hist = hist.filter(function(h) { return h.brand && h.brand.toLowerCase().includes(q.brand.toLowerCase()); });
  if (q.code) hist = hist.filter(function(h) { return h.errorCode && h.errorCode.toLowerCase().includes(q.code.toLowerCase()); });
  if (q.from) hist = hist.filter(function(h) { return h.ts >= q.from; });
  if (q.to) hist = hist.filter(function(h) { return h.ts <= q.to + 'T23:59:59'; });
  res.json(hist.reverse().slice(0, 500));
});

app.get('/api/admin/stats', admin, (req, res) => {
  var db = load();
  var queries = db.history.filter(function(h) { return h.type === 'query'; });
  var byUser = {}, byBrand = {}, byCode = {};
  queries.forEach(function(q) {
    var u = q.name || q.username;
    byUser[u] = (byUser[u] || 0) + 1;
    if (q.brand) byBrand[q.brand] = (byBrand[q.brand] || 0) + 1;
    if (q.errorCode) byCode[q.errorCode] = (byCode[q.errorCode] || 0) + 1;
  });
  var topCodes = Object.entries(byCode).sort(function(a,b) { return b[1]-a[1]; }).slice(0, 10);
  res.json({
    totalQueries: queries.length,
    totalUsers: db.users.length,
    byUser: byUser,
    byBrand: byBrand,
    topCodes: topCodes,
    last7days: queries.filter(function(q) { return new Date(q.ts) > new Date(Date.now() - 7*86400000); }).length
  });
});

// ── ADMIN USERS ───────────────────────────────────────────────────────────────
app.get('/api/admin/users', admin, (req, res) => {
  var db = load();
  res.json(db.users.map(function(u) { return Object.assign({}, u, {password: undefined}); }));
});

app.post('/api/admin/users', admin, async (req, res) => {
  var d = req.body;
  var db = load();
  if (db.users.find(function(u) { return u.username === d.username; })) return res.status(400).json({ error: 'Usuario ya existe' });
  var hash = await bcrypt.hash(d.password, 10);
  var user = { id: Date.now(), username: d.username, password: hash, name: d.name, role: d.role || 'tecnico', active: true, createdAt: new Date().toISOString() };
  db.users.push(user);
  save(db);
  res.json(Object.assign({}, user, {password: undefined}));
});

app.put('/api/admin/users/:id', admin, async (req, res) => {
  var db = load();
  var idx = db.users.findIndex(function(u) { return u.id == req.params.id; });
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  var d = req.body;
  if (d.name !== undefined) db.users[idx].name = d.name;
  if (d.role !== undefined) db.users[idx].role = d.role;
  if (d.active !== undefined) db.users[idx].active = d.active;
  if (d.password) db.users[idx].password = await bcrypt.hash(d.password, 10);
  save(db);
  res.json(Object.assign({}, db.users[idx], {password: undefined}));
});

app.delete('/api/admin/users/:id', admin, (req, res) => {
  var db = load();
  db.users = db.users.filter(function(u) { return u.id != req.params.id; });
  save(db);
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function buildSystemPrompt(brand, content, pastSolutions) {
  brand = brand || 'desconocida';

  var hasSolutions = pastSolutions && pastSolutions.length > 0;
  var solutionsBlock = '';
  if (hasSolutions) {
    solutionsBlock = '\n\nCASOS RESUELTOS POR TECNICOS DE DAVOFRIO CON ESTE CODIGO:\n';
    pastSolutions.forEach(function(s, i) {
      solutionsBlock += (i+1) + '. [' + s.ts.substring(0,10) + '] ';
      if (s.problem) solutionsBlock += 'Problema: ' + s.problem + '. ';
      solutionsBlock += 'Solucion aplicada: ' + s.solution + '\n';
    });
    solutionsBlock += 'Incluye estos casos al final de tu respuesta bajo el titulo "Casos resueltos".\n';
  }

  var hasContent = content && content.length > 50;

  return [
    'Eres el motor de diagnostico tecnico de DAVOFRIO para la marca ' + brand + '.',
    'Tu funcion: extraer y presentar el procedimiento de diagnostico EXACTAMENTE como aparece en el manual.',
    '',
    hasContent
      ? 'FRAGMENTOS RELEVANTES DE LOS MANUALES DE ' + brand + ' (extraidos donde aparece el codigo buscado):\n---\n' + content + '\n---'
      : 'AVISO: No se encontro el codigo en los manuales indexados de ' + brand + '. Indica esto claramente al tecnico.',
    solutionsBlock,
    '',
    'REGLAS — SIN EXCEPCION:',
    'PROHIBIDO:',
    '- Decir "consulte a un tecnico" o "contacte al servicio tecnico" — EL QUE LEE ES EL TECNICO',
    '- Decir "si el problema persiste llame a..." — NUNCA',
    '- Resumir o acortar el procedimiento del manual',
    '- Inventar pasos que no esten en el manual',
    '- Generar doble respuesta o repetir bloques',
    '- Mostrar nombres de archivos PDF al tecnico',
    '- Copiar el formato de ejemplo del prompt como respuesta',
    '',
    'OBLIGATORIO:',
    '- Extraer el procedimiento COMPLETO tal como esta en el manual',
    '- Incluir TODOS los valores exactos (kOhm, Vdc, bar, grados C)',
    '- Reproducir TODAS las tablas de valores',
    '- Convertir CADA bifurcacion si/no en un bloque interactivo con botones',
    '- Si el tecnico responde a una condicion, continuar SOLO por esa rama sin repetir nada',
    '- Generar UNA SOLA respuesta completa, no multiples bloques',
    '- Si el contenido del manual esta en ingles, traducir TODO al espanol en la respuesta',
    '- Si el contenido extraido parece corrupto o ilegible, indicarlo claramente: "El manual de este modelo tiene codificacion no compatible. Consulta el PDF directamente."',
    '',
    'FORMATO DE RESPUESTA (una sola vez, completo):',
    '',
    'Linea 1 — encabezado:',
    '<div class="rc"><div class="rc-h"><span class="etag"><i class="ti ti-alert-triangle"></i> [CODIGO REAL]</span><span class="edesc">[descripcion exacta del manual]</span><span class="msrc"><i class="ti ti-book-2"></i> ' + brand + '</span></div><div class="rc-b">',
    '',
    'Causas (todas las del manual):',
    '<div class="slbl">Causas posibles</div><div class="causes"><span class="cause">[causa]</span></div>',
    '',
    'Pasos (todos, sin omitir):',
    '<div class="slbl">Procedimiento</div><div class="steps"><div class="step"><div class="sn">1</div><div class="st">[paso exacto con valores: <code>X kOhm</code>]</div></div></div>',
    '',
    'Cada bifurcacion si/no del manual:',
    '<div class="cond-card"><div class="cond-q"><i class="ti ti-help-circle"></i>[pregunta exacta del diagrama]</div><div class="cond-btns"><button class="cond-btn yes" onclick="condAnswer(this,\'si\')"><i class="ti ti-check"></i> Si</button><button class="cond-btn no" onclick="condAnswer(this,\'no\')"><i class="ti ti-x"></i> No</button></div></div>',
    '',
    'Cada tabla de valores:',
    '<table class="vtable"><thead><tr><th>[col]</th></tr></thead><tbody><tr><td>[valor]</td></tr></tbody></table>',
    '',
    'Cierre obligatorio:',
    '<span class="srctag"><i class="ti ti-book-2"></i> ' + brand + '</span></div></div>',
    '<button class="resolve-btn" onclick="markResolved()"><i class="ti ti-circle-check"></i> Marcar averia como resuelta</button>',
    '',
    'CUANDO EL TECNICO RESPONDE SI O NO A UNA CONDICION:',
    'No repitas encabezado ni causas. Responde SOLO con los pasos de esa rama.',
    '',
    'IDIOMA: espanol tecnico directo. Cero introduccion. Cero conclusion. Solo el procedimiento.'
  ].join('\n');
}

// ── START ─────────────────────────────────────────────────────────────────────
async function start() {
  var db = load();
  if (db.users.length === 0) {
    var hash = await bcrypt.hash('admin123', 10);
    db.users.push({ id: 1, username: 'admin', password: hash, name: 'Administrador', role: 'admin', active: true, createdAt: new Date().toISOString() });
    save(db);
    console.log('Admin creado: admin / admin123');
  }

  var idx = loadIndex();
  if (idx.manuals && idx.manuals.length > 0) {
    console.log('Indice listo: ' + idx.manuals.length + ' manuales en memoria');
  } else {
    console.log('Sin indice. Ve a Admin > Indice > Reconstruir.');
  }

  app.listen(PORT, function() {
    console.log('DAVOFRIO en http://localhost:' + PORT);
  });
}

start();
