const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultData = {
  users: [],
  payments: [],
  videos: [],
  uploads: [],
  streamTokens: [],
  loginAttempts: [],
  emailQueue: []
};

let cache = null;
let writeQueue = Promise.resolve();
let dirty = false;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DB_FILE)) {
    cache = JSON.parse(JSON.stringify(defaultData));
    persistSync();
    return cache;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    cache = JSON.parse(raw);
    for (const key of Object.keys(defaultData)) {
      if (!cache[key]) cache[key] = JSON.parse(JSON.stringify(defaultData[key]));
    }
  } catch (e) {
    console.error('[db] read failed, restoring defaults:', e.message);
    cache = JSON.parse(JSON.stringify(defaultData));
    persistSync();
  }
  return cache;
}

function persistSync() {
  fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2));
  dirty = false;
}

function save() {
  dirty = true;
  writeQueue = writeQueue.then(() => new Promise((resolve) => {
    if (!dirty) return resolve();
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(cache, null, 2), (err) => {
      if (err) { console.error('[db] write error:', err); return resolve(); }
      fs.rename(tmp, DB_FILE, (err2) => {
        if (err2) console.error('[db] rename error:', err2);
        dirty = false;
        resolve();
      });
    });
  }));
  return writeQueue;
}

function id() {
  return crypto.randomBytes(12).toString('hex');
}

function getCollection(name) {
  const db = load();
  if (!db[name]) db[name] = [];
  return db[name];
}

function findById(name, id) {
  return getCollection(name).find(x => x.id === id) || null;
}

function findOne(name, predicate) {
  return getCollection(name).find(predicate) || null;
}

function find(name, predicate) {
  return getCollection(name).filter(predicate);
}

function insert(name, doc) {
  const c = getCollection(name);
  if (!doc.id) doc.id = id();
  doc.createdAt = doc.createdAt || Date.now();
  c.push(doc);
  save();
  return doc;
}

function update(name, id, patch) {
  const c = getCollection(name);
  const idx = c.findIndex(x => x.id === id);
  if (idx === -1) return null;
  c[idx] = { ...c[idx], ...patch, updatedAt: Date.now() };
  save();
  return c[idx];
}

function remove(name, id) {
  const c = getCollection(name);
  const idx = c.findIndex(x => x.id === id);
  if (idx === -1) return false;
  c.splice(idx, 1);
  save();
  return true;
}

function all(name) {
  return [...getCollection(name)];
}

load();

module.exports = {
  id,
  load,
  save,
  findById,
  findOne,
  find,
  insert,
  update,
  remove,
  all,
  raw: () => cache
};
