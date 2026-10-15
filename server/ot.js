const { writeJson } = require('./jsonStore');
/**
 * MÓDULO DE ÓRDENES DE TRABAJO (OT)
 * Cada visita tiene una OT única. Una misma OT puede tener múltiples visitas
 * (diagnóstico → reparación → mantenimiento) realizadas por distintos técnicos.
 */
const fs = require('fs');
const path = require('path');

const OT_PATH = path.join(__dirname, '../data/ot.json');

function load() {
  if (!fs.existsSync(OT_PATH)) return { orders: [] };
  return JSON.parse(fs.readFileSync(OT_PATH, 'utf8'));
}

function save(data) {
  fs.mkdirSync(path.dirname(OT_PATH), { recursive: true });
  writeJson(OT_PATH, data);
}

// Tipos de visita y sus etiquetas
const VISIT_TYPES = {
  diagnostico:    { label: 'Diagnóstico',           action: 'Diagnóstico realizado',       icon: 'ti-stethoscope' },
  reparacion:     { label: 'Reparación',             action: 'Reparación finalizada',        icon: 'ti-tool' },
  mantenimiento:  { label: 'Mantenimiento',          action: 'Mantenimiento realizado',      icon: 'ti-settings' }
};

// Obtener o crear una OT
function getOrCreate(otCode) {
  var db = load();
  var order = db.orders.find(function(o) { return o.code === otCode.toUpperCase(); });
  if (!order) {
    order = {
      code: otCode.toUpperCase(),
      createdAt: new Date().toISOString(),
      brand: null,
      model: null,
      visits: []
    };
    db.orders.push(order);
    save(db);
  }
  return order;
}

// Actualizar datos básicos de la OT (marca, modelo)
function updateOT(otCode, data) {
  var db = load();
  var order = db.orders.find(function(o) { return o.code === otCode.toUpperCase(); });
  if (!order) return null;
  if (data.brand) order.brand = data.brand;
  if (data.model) order.model = data.model;
  save(db);
  return order;
}

// Añadir una visita a la OT
function addVisit(otCode, visit) {
  var db = load();
  var order = db.orders.find(function(o) { return o.code === otCode.toUpperCase(); });
  if (!order) return null;
  order.visits.push({
    id: Date.now(),
    type: visit.type,          // diagnostico | reparacion | mantenimiento
    techId: visit.techId,
    techName: visit.techName,
    errorCode: visit.errorCode || null,
    problem: visit.problem || null,
    resolution: visit.resolution || null,
    notes: visit.notes || null,
    ts: new Date().toISOString()
  });
  save(db);
  return order;
}

// Obtener OT por código
function getOT(otCode) {
  var db = load();
  return db.orders.find(function(o) { return o.code === otCode.toUpperCase(); }) || null;
}

// Listar todas las OT (admin)
function getAllOTs(filters) {
  var db = load();
  var list = db.orders;
  filters = filters || {};
  if (filters.code) list = list.filter(function(o) { return o.code.includes(filters.code.toUpperCase()); });
  if (filters.brand) list = list.filter(function(o) { return o.brand && o.brand.toLowerCase().includes(filters.brand.toLowerCase()); });
  if (filters.tech) list = list.filter(function(o) {
    return o.visits.some(function(v) { return v.techName && v.techName.toLowerCase().includes(filters.tech.toLowerCase()); });
  });
  return list.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); }).slice(0, 200);
}

// Build context summary of an OT for the AI
function buildOTContext(order, currentVisitType) {
  if (!order || !order.visits || !order.visits.length) return '';

  var lines = ['HISTORIAL DE VISITAS ANTERIORES PARA ESTA OT (' + order.code + '):'];
  order.visits.forEach(function(v, i) {
    var typeInfo = VISIT_TYPES[v.type] || { label: v.type };
    lines.push('\nVisita ' + (i+1) + ' — ' + typeInfo.label + ' [' + v.ts.substring(0,10) + '] por ' + v.techName);
    if (v.errorCode) lines.push('  Código de error: ' + v.errorCode);
    if (v.problem) lines.push('  Problema detectado: ' + v.problem);
    if (v.resolution) lines.push('  Resolución aplicada: ' + v.resolution);
    if (v.notes) lines.push('  Notas: ' + v.notes);
  });

  if (currentVisitType === 'reparacion') {
    lines.push('\nACTUAL: Esta es una visita de REPARACIÓN. Usa el historial anterior para dar contexto al técnico.');
  } else if (currentVisitType === 'mantenimiento') {
    lines.push('\nACTUAL: Esta es una visita de MANTENIMIENTO. Ten en cuenta las reparaciones y diagnósticos previos.');
  }

  return lines.join('\n');
}

module.exports = { getOrCreate, updateOT, addVisit, getOT, getAllOTs, buildOTContext, VISIT_TYPES };
