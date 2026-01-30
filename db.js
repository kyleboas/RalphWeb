const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

function init() {
  // Default to /app/data if not specified (for Railway volume compatibility)
  // or fallback to local ./data
  let dataDir;
  if (process.env.DATA_DIR) {
    dataDir = process.env.DATA_DIR;
  } else if (fs.existsSync('/app/data')) {
    dataDir = '/app/data';
  } else {
    dataDir = path.join(__dirname, 'data');
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'ralph.db');
  console.log(`Initializing database at ${dbPath}`);

  db = new Database(dbPath);

  // Jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      iterations INTEGER DEFAULT 0,
      startTime INTEGER,
      cost REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

  // Repos table
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      url TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

  console.log('Database initialized successfully');
}

function createJob(job) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare(`
        INSERT INTO jobs (repo, type, status, iterations, startTime, cost)
        VALUES (@repo, @type, @status, @iterations, @startTime, @cost)
    `);
    const info = stmt.run({
        repo: job.repo,
        type: job.type,
        status: job.status,
        iterations: job.iterations || 0,
        startTime: job.startTime || Date.now(),
        cost: job.cost || 0
    });
    return { ...job, id: info.lastInsertRowid };
}

function updateJob(id, updates) {
    if (!db) throw new Error('Database not initialized');
    const keys = Object.keys(updates).filter(k => k !== 'id');
    if (keys.length === 0) return;

    const setClause = keys.map(k => `${k} = @${k}`).join(', ');
    const stmt = db.prepare(`UPDATE jobs SET ${setClause} WHERE id = @id`);
    stmt.run({ ...updates, id });
}

function getJob(id) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
    return stmt.get(id);
}

function getJobs() {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare('SELECT * FROM jobs ORDER BY id DESC');
    return stmt.all();
}

function addRepo(repo) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO repos (name, path, url)
        VALUES (@name, @path, @url)
    `);
    stmt.run({
        name: repo.name,
        path: repo.path,
        url: repo.url || null
    });
}

function getRepo(name) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare('SELECT * FROM repos WHERE name = ?');
    return stmt.get(name);
}

function getRepos() {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare('SELECT * FROM repos ORDER BY name ASC');
    return stmt.all();
}

function deleteRepo(name) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare('DELETE FROM repos WHERE name = ?');
    stmt.run(name);
}

module.exports = {
    init,
    createJob,
    updateJob,
    getJob,
    getJobs,
    addRepo,
    getRepo,
    getRepos,
    deleteRepo
};
