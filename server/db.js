const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/db.json');

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      users: [
        { id: 1, username: 'admin', password: '$2a$10$rqJ7z5Z5Q5Q5Q5Q5Q5Q5QeZQ5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q', role: 'admin', name: 'Administrador', active: true, createdAt: new Date().toISOString() },
      ],
      history: [],
      manualCache: {}
    };
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = { load, save };
