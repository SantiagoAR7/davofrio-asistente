/**
 * RECURSOS (vídeos por código de error)
 * El admin asocia vídeos a códigos de error específicos.
 */
const fs = require('fs');
const path = require('path');

const RES_PATH = path.join(__dirname, '../data/resources.json');

function load() {
  if (!fs.existsSync(RES_PATH)) return { resources: [] };
  return JSON.parse(fs.readFileSync(RES_PATH));
}
function save(data) { fs.writeFileSync(RES_PATH, JSON.stringify(data, null, 2)); }

function addResource({ code, brand, manualUid, title, url, type, uploadedBy }) {
  const db = load();
  db.resources.push({
    id: Date.now(),
    code: code ? code.toUpperCase() : null,
    brand: brand || null,
    manualUid: manualUid || null,
    title,
    url,          // YouTube URL, Vimeo, or local path
    type: type || 'video',  // video | pdf | image
    uploadedBy,
    ts: new Date().toISOString()
  });
  save(db);
  return db.resources[db.resources.length - 1];
}

function getResources(code, brand) {
  const db = load();
  return db.resources.filter(r => {
    const codeMatch = !r.code || !code || r.code === code.toUpperCase();
    const brandMatch = !r.brand || !brand || r.brand === brand;
    return codeMatch && brandMatch;
  });
}

function deleteResource(id) {
  const db = load();
  db.resources = db.resources.filter(r => r.id != id);
  save(db);
}

function getAllResources() {
  return load().resources.reverse();
}

module.exports = { addResource, getResources, deleteResource, getAllResources };
