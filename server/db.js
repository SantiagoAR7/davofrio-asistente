const path = require('path');
const { readJson, writeJson } = require('./jsonStore');
const DB_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '../data'), 'db.json');
function load() {
  const data = readJson(DB_PATH, { users: [], history: [] });
  if (!Array.isArray(data.users) || !Array.isArray(data.history)) throw new Error('Estructura de base de datos inválida');
  return data;
}
function save(data) { writeJson(DB_PATH, data); }
module.exports = { load, save };
