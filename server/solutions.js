/**
 * MEMORIA DE SOLUCIONES
 * Cuando un técnico resuelve una avería, guarda cómo la solucionó.
 * Eso enriquece las respuestas futuras del mismo código.
 */
const fs = require('fs');
const path = require('path');

const SOL_PATH = path.join(__dirname, '../data/solutions.json');

function load() {
  if (!fs.existsSync(SOL_PATH)) return { solutions: [] };
  return JSON.parse(fs.readFileSync(SOL_PATH));
}
function save(data) {
  fs.writeFileSync(SOL_PATH, JSON.stringify(data, null, 2));
}

// Add a new solution
function addSolution({ code, brand, manualUid, manualName, problem, solution, techName, techId }) {
  const db = load();
  db.solutions.push({
    id: Date.now(),
    code: code.toUpperCase(),
    brand,
    manualUid,
    manualName,
    problem,
    solution,
    techName,
    techId,
    ts: new Date().toISOString(),
    helpful: 0
  });
  save(db);
}

// Get solutions for a specific code + brand
function getSolutions(code, brand) {
  const db = load();
  const c = code.toUpperCase();
  return db.solutions
    .filter(s => s.code === c && (!brand || s.brand === brand))
    .sort((a, b) => b.helpful - a.helpful)
    .slice(0, 5);
}

// Vote helpful
function voteHelpful(id) {
  const db = load();
  const s = db.solutions.find(x => x.id == id);
  if (s) { s.helpful++; save(db); }
}

// All solutions (admin)
function getAllSolutions(filters = {}) {
  const db = load();
  let list = db.solutions;
  if (filters.brand) list = list.filter(s => s.brand === filters.brand);
  if (filters.code) list = list.filter(s => s.code === filters.code.toUpperCase());
  return list.reverse();
}

module.exports = { addSolution, getSolutions, voteHelpful, getAllSolutions };
