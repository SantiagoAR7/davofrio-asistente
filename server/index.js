require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const { load, save } = require('./db');
const { buildIndex, searchManuals, getBrandManuals, loadIndex, BRANDS, extractRelevantContext } = require('./indexer'); // OneDrive via Microsoft Graph
const { addSolution, getSolutions, voteHelpful, getAllSolutions } = require('./solutions');
const { addResource, getResources, deleteResource, getAllResources } = require('./resources');
const { getOrCreate, updateOT, addVisit, getOT, getAllOTs, buildOTContext, VISIT_TYPES } = require('./ot');
const { answerWithRAG } = require('./rag');
const { analyzeQuery, BRANDS: RAG_BRANDS } = require('./queryAnalyzer');
const { getStatus, startBuild } = require('./ragAdmin');

const app = express();
const PORT = process.env.PORT || 3000;
// Forward async failures to Express 4's error middleware.
for (const method of ['get', 'post', 'put', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (route, ...handlers) => register(route, ...handlers.map(fn => (req,res,next) => {
    try { Promise.resolve(fn(req,res,next)).catch(next); } catch (error) { next(error); }
  }));
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 24) throw new Error('SESSION_SECRET debe tener al menos 24 caracteres');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

function auth(req, res, next) {
  const current = req.session.user && load().users.find(u => u.id === req.session.user.id && u.active);
  if (!current || (current.sessionVersion || 0) !== (req.session.user.sessionVersion || 0)) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Sesión no válida' });
  }
  req.session.user = { id: current.id, username: current.username, name: current.name, role: current.role, sessionVersion: current.sessionVersion || 0 };
  next();
}
function admin(req, res, next) {
  auth(req, res, () => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
    next();
  });
}
const loginAttempts = new Map();
// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 200 || password.length > 200) return res.status(400).json({error:'Credenciales inválidas'});
  const key = req.ip + ':' + username.toLowerCase().trim();
  const now = Date.now();
  for (const [k,v] of loginAttempts) if (v.until < now) loginAttempts.delete(k);
  const attempt = loginAttempts.get(key) || {count:0,until:now+900000};
  if (++attempt.count > 10) return res.status(429).json({error:'Demasiados intentos. Espera 15 minutos.'});
  loginAttempts.set(key, attempt);
  const db = load();
  const user = db.users.find(u => u.username === username.toLowerCase().trim() && u.active);
  if (!user) return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
  loginAttempts.delete(key);
  await new Promise((resolve,reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role, sessionVersion: user.sessionVersion || 0 };
  const db2 = load();
  db2.history.push({ type: 'login', userId: user.id, username: user.username, name: user.name, ts: new Date().toISOString() });
  save(db2);
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: req.session.user }));

// ── OT ROUTES ─────────────────────────────────────────────────────────────────
// Get or create OT
app.get('/api/ot/:code', auth, (req, res) => {
  var order = getOT(req.params.code);
  res.json({ order: order, exists: !!order, visitTypes: VISIT_TYPES });
});

app.post('/api/ot', auth, (req, res) => {
  var { code } = req.body;
  if (typeof code !== 'string' || code.trim().length < 2 || code.length > 100) return res.status(400).json({ error: 'Código OT inválido' });
  var order = getOrCreate(code.trim());
  res.json({ order: order, visitTypes: VISIT_TYPES });
});

app.put('/api/ot/:code', auth, (req, res) => {
  var order = updateOT(req.params.code, req.body);
  if (!order) return res.status(404).json({ error: 'OT no encontrada' });
  res.json({ order: order });
});

// Close a visit (register result)
app.post('/api/ot/:code/visit', auth, (req, res) => {
  var { type, errorCode, problem, resolution, notes } = req.body;
  if (!type || !VISIT_TYPES[type]) return res.status(400).json({ error: 'Tipo de visita inválido' });
  if (!resolution && !notes) return res.status(400).json({ error: 'Debes documentar la resolución o agregar notas' });
  var order = addVisit(req.params.code, {
    type: type,
    techId: req.session.user.id,
    techName: req.session.user.name,
    errorCode: errorCode,
    problem: problem,
    resolution: resolution,
    notes: notes
  });
  if (!order) return res.status(404).json({ error: 'OT no encontrada' });
  res.json({ ok: true, order: order });
});

app.get('/api/admin/ot', admin, (req, res) => {
  res.json(getAllOTs(req.query));
});

// ── INDEX ─────────────────────────────────────────────────────────────────────
app.get('/api/index/status', auth, async (req, res) => res.json(await getStatus()));
app.post('/api/index/build', admin, (req, res) => {
  if (!startBuild()) return res.status(409).json({error:'Ya hay una indexación en curso'});
  res.status(202).json({ok:true});
});

// ── SEARCH ────────────────────────────────────────────────────────────────────
app.post('/api/search', auth, async (req, res) => {
  const { query } = req.body;
  if (typeof query !== 'string' || !query.trim() || query.length > 8000) return res.status(400).json({ error: 'Query requerida' });
  const results = searchManuals(query);
  const byBrand = {};
  var seenBrands = {}, prioritized = [];
  for (var ri = 0; ri < results.length; ri++) {
    var brand = results[ri].manual.brand;
    if (!seenBrands[brand]) { seenBrands[brand] = true; prioritized.push(results[ri]); }
  }
  for (var ri = 0; ri < results.length && prioritized.length < 50; ri++) {
    if (!prioritized.includes(results[ri])) prioritized.push(results[ri]);
  }
  for (const r of prioritized) {
    const key = r.manual.brand;
    if (!byBrand[key]) byBrand[key] = [];
    byBrand[key].push({ uid: r.manual.uid, brandId: r.manual.brandId, brand: r.manual.brand, brandColor: r.manual.brandColor, fileName: r.manual.fileName, score: r.score });
  }
  const brands = Object.values(byBrand);
  res.json({ results: brands, total: results.length, multiMatch: brands.length > 1, singleBrandId: brands.length === 1 ? brands[0][0].brandId : null, singleBrand: brands.length === 1 ? brands[0][0].brand : null });
});

// ── QUERY RAG ─────────────────────────────────────────────────────────────────
app.post('/api/query', auth, async (req, res) => {
  const { query, brandId, modelName, otCode, visitType, history = [], sessionId } = req.body;
  if (typeof query !== 'string' || !query.trim() || query.length > 8000 || !Array.isArray(history) || history.length > 24 ||
    history.some(h => !h || !['user','assistant'].includes(h.role) || typeof h.content !== 'string' || h.content.length > 16000) ||
    [brandId,modelName,otCode,visitType,sessionId].some(v => v != null && (typeof v !== 'string' || v.length > 300))) {
    return res.status(400).json({error:'Consulta o contexto inválido'});
  }
  const analysis = analyzeQuery(query);
  const legacyBrand = BRANDS.find(b => b.id === brandId)?.n;
  const brandName = (RAG_BRANDS.includes(brandId) ? brandId : legacyBrand) || analysis.brand || null;
  const order = otCode ? getOT(otCode) : null;
  const errorCode = analysis.errorCode;
  const pastSolutions = errorCode && brandName ? getSolutions(errorCode, brandName) : [];
  try {
    const result = await answerWithRAG(query, { brand:brandName, modelName, history, visitType, pastSolutions,
      otContext: order ? buildOTContext(order, visitType) : '' });
    if (order) updateOT(otCode, {brand:brandName,model:modelName});
    const user = req.session.user;
    const db = load();
    db.history.push({type:'query', sessionId, userId:user.id, username:user.username, name:user.name,
      brand:brandName, brandId, modelName, errorCode, otCode, visitType, query, answer:result.answer,
      ragSources:result.sources, evidenceStatus:result.evidenceStatus, ts:new Date().toISOString()});
    save(db);
    res.json({answer:result.answer, brand:brandName, brandId, errorCode, sources:result.sources,
      evidenceStatus:result.evidenceStatus, resources:errorCode ? getResources(errorCode,brandName) : []});
  } catch (error) {
    console.error('Consulta RAG fallida:', error.message);
    res.status(503).json({error:'No se pudo consultar la base documental. Intenta de nuevo; no se ha generado un diagnóstico sin fuentes.'});
  }
});

// ── SOLUTIONS ─────────────────────────────────────────────────────────────────
app.post('/api/solutions', auth, (req, res) => {
  var data = req.body;
  if (typeof data.code !== 'string' || !data.code || typeof data.solution !== 'string' || !data.solution || data.solution.length > 10000) return res.status(400).json({ error: 'La solucion no puede estar vacia' });
  addSolution({ code: data.code, brand: data.brand, problem: data.problem, solution: data.solution, techName: req.session.user.name, techId: req.session.user.id });
  res.json({ ok: true });
});
app.post('/api/solutions/:id/helpful', auth, (req, res) => { voteHelpful(req.params.id); res.json({ ok: true }); });
app.get('/api/solutions', auth, (req, res) => { if (typeof req.query.code !== 'string') return res.status(400).json({error:'Código requerido'}); res.json(getSolutions(req.query.code, req.query.brand)); });
app.get('/api/admin/solutions', admin, (req, res) => { res.json(getAllSolutions(req.query)); });

// ── RESOURCES ─────────────────────────────────────────────────────────────────
app.get('/api/resources', auth, (req, res) => { res.json(getResources(req.query.code, req.query.brand)); });
app.post('/api/resources', admin, (req, res) => {
  var d = req.body;
  if (typeof d.title !== 'string' || typeof d.url !== 'string' || !/^https?:\/\//i.test(d.url)) return res.status(400).json({ error: 'Titulo y URL requeridos' });
  res.json(addResource({ code: d.code, brand: d.brand, title: d.title, url: d.url, type: d.type, uploadedBy: req.session.user.name }));
});
app.delete('/api/resources/:id', admin, (req, res) => { deleteResource(req.params.id); res.json({ ok: true }); });
app.get('/api/admin/resources', admin, (req, res) => res.json(getAllResources()));

// ── ADMIN ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/history', admin, (req, res) => {
  var db = load(), q = req.query;
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
  res.json({
    totalQueries: queries.length, totalUsers: db.users.length, byUser: byUser, byBrand: byBrand,
    topCodes: Object.entries(byCode).sort(function(a,b){return b[1]-a[1];}).slice(0,10),
    last7days: queries.filter(function(q){return new Date(q.ts)>new Date(Date.now()-7*86400000);}).length
  });
});

app.get('/api/admin/users', admin, (req, res) => {
  res.json(load().users.map(function(u){return Object.assign({},u,{password:undefined});}));
});
app.post('/api/admin/users', admin, async (req, res) => {
  var d=req.body, db=load();
  // Validate email format
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (typeof d.username !== 'string' || !emailRegex.test(d.username)) return res.status(400).json({error:'El usuario debe ser un email válido (ej: tecnico@gmail.com)'});
  if (typeof d.name !== 'string' || d.name.trim().length < 2) return res.status(400).json({error:'El nombre es obligatorio'});
  if (db.users.find(function(u){return u.username===d.username.toLowerCase();})) return res.status(400).json({error:'Ya existe un técnico con ese email'});
  if (typeof d.password !== 'string' || d.password.length < 10 || d.password.length > 100) return res.status(400).json({error:'La contraseña debe tener entre 10 y 100 caracteres'});
  if (d.role && !['admin','tecnico'].includes(d.role)) return res.status(400).json({error:'Rol inválido'});
  var hash=await bcrypt.hash(d.password,10);
  db=load();
  if (db.users.some(u => u.username === d.username.toLowerCase())) return res.status(409).json({error:'Usuario existente'});
  var user={id:Date.now(),username:d.username.toLowerCase(),password:hash,name:d.name.trim(),role:d.role||'tecnico',active:true,createdAt:new Date().toISOString()};
  db.users.push(user); save(db);
  res.json(Object.assign({},user,{password:undefined}));
});
app.put('/api/admin/users/:id', admin, async (req, res) => {
  const d = req.body;
  if (d.role !== undefined && !['admin','tecnico'].includes(d.role)) return res.status(400).json({error:'Rol inválido'});
  if (d.active !== undefined && typeof d.active !== 'boolean') return res.status(400).json({error:'Estado inválido'});
  if (d.name !== undefined && (typeof d.name !== 'string' || d.name.trim().length < 2)) return res.status(400).json({error:'Nombre inválido'});
  if (d.password !== undefined && (typeof d.password !== 'string' || d.password.length < 10 || d.password.length > 100)) return res.status(400).json({error:'Contraseña inválida'});
  const hash = d.password ? await bcrypt.hash(d.password,10) : null;
  const db=load(), user=db.users.find(u => u.id == req.params.id);
  if (!user) return res.status(404).json({error:'No encontrado'});
  if (d.name) user.name=d.name.trim();
  if (d.role !== undefined) user.role=d.role;
  if (d.active !== undefined) user.active=d.active;
  if (hash) user.password=hash;
  if (hash || d.role !== undefined || d.active !== undefined) user.sessionVersion=(user.sessionVersion || 0)+1;
  save(db); res.json({...user,password:undefined});
});
app.delete('/api/admin/users/:id', admin, (req, res) => {
  var db=load(); db.users=db.users.filter(function(u){return u.id!=req.params.id;}); save(db); res.json({ok:true});
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.use((error, req, res, next) => {
  console.error('Error de petición:', error.message);
  if (!res.headersSent) res.status(error.status || 500).json({error:'No se pudo procesar la solicitud'});
});

// ── START ─────────────────────────────────────────────────────────────────────
async function start() {
  var db = load();
  var adminPass = process.env.ADMIN_PASSWORD;
  if (db.users.length === 0) {
    if (!adminPass || adminPass.length < 10) throw new Error('Configura ADMIN_PASSWORD (mínimo 10 caracteres) para crear el administrador');
    var hash = await bcrypt.hash(adminPass, 10);
    db.users.push({id:1,username:'admin',password:hash,name:'Administrador',role:'admin',active:true,createdAt:new Date().toISOString()});
    if (!db.history) db.history = [];
    save(db);
    console.log('Administrador inicial creado');
  }
  var idx = loadIndex();
  console.log(idx.manuals && idx.manuals.length > 0 ? 'Indice listo: ' + idx.manuals.length + ' manuales' : 'Sin indice. Ve a Admin > Indice > Reconstruir.');
  app.listen(PORT, function() { console.log('DAVOFRIO en http://localhost:' + PORT); });
}

if (require.main === module) start().catch(error => { console.error(error.message); process.exitCode=1; });
module.exports = { app, start };
