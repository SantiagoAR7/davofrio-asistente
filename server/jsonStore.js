const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  // Corrupt data is an error, never an empty database to overwrite.
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
module.exports = { readJson, writeJson };
