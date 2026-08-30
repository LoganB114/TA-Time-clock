const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
const port = process.env.PORT || 3000;
const database = new Database(path.join(__dirname, 'data.sqlite'));
const APPROVED_LATITUDE = 43.6150;
const APPROVED_LONGITUDE = -116.2038;
const MAX_DISTANCE_METERS = 200;

function distanceInMeters(latitude1, longitude1, latitude2, longitude2) {
  const earthRadius = 6371000;
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDifference = radians(latitude2 - latitude1);
  const longitudeDifference = radians(longitude2 - longitude1);
  const area = Math.sin(latitudeDifference / 2) ** 2
    + Math.cos(radians(latitude1))
    * Math.cos(radians(latitude2))
    * Math.sin(longitudeDifference / 2) ** 2;

  return earthRadius * 2 * Math.atan2(Math.sqrt(area), Math.sqrt(1 - area));
}

database.exec(`
  CREATE TABLE IF NOT EXISTS names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'clocked out' CHECK(status IN ('clocked in', 'clocked out'))
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL CHECK(type IN ('clock in', 'clock out'))
  );
`);

const nameColumns = database.prepare('PRAGMA table_info(names)').all();
if (!nameColumns.some((column) => column.name === 'status')) {
  database.exec("ALTER TABLE names ADD COLUMN status TEXT NOT NULL DEFAULT 'clocked out'");
}

const addName = database.prepare('INSERT OR IGNORE INTO names (name) VALUES (?)');
const names = fs.readFileSync(path.join(__dirname, 'names.txt'), 'utf8')
  .split(/\r?\n/)
  .map((name) => name.trim())
  .filter(Boolean);
const syncNames = database.transaction(() => {
  names.forEach((name) => addName.run(name));
});
syncNames();

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/names', (request, response) => {
  if (names.length === 0) {
    return response.json([]);
  }

  const placeholders = names.map(() => '?').join(', ');
  const currentNames = database.prepare(`
    SELECT id, name, status
    FROM names
    WHERE name IN (${placeholders})
    ORDER BY name
  `).all(...names);
  return response.json(currentNames);
});

app.get('/api/logs/today/:nameId', (request, response) => {
  const nameId = Number(request.params.nameId);
  if (!Number.isInteger(nameId)) {
    return response.status(400).json({ error: 'nameId must be an integer' });
  }

  const activity = database.prepare(`
    SELECT logs.id, logs.type, logs.timestamp
    FROM logs
    INNER JOIN names ON names.name = logs.name
    WHERE names.id = ?
      AND date(logs.timestamp, 'localtime') = date('now', 'localtime')
    ORDER BY logs.timestamp DESC
  `).all(nameId);
  return response.json(activity);
});

app.get('/api/logs', (request, response) => {
  const nameId = request.query.nameId || 'all';
  const page = Number(request.query.page || 1);
  const limit = 50;

  if (!Number.isFinite(page) || page < 1) {
    return response.status(400).json({ error: 'page must be a positive integer' });
  }

  let baseQuery = 'FROM logs';
  let countQuery = 'SELECT COUNT(*) AS count FROM logs';
  let params = [];

  if (nameId === 'all') {
    baseQuery = 'FROM logs';
    countQuery = 'SELECT COUNT(*) AS count FROM logs';
  } else if (/^\d+$/.test(nameId)) {
    baseQuery = `
      FROM logs
      INNER JOIN names ON names.name = logs.name
      WHERE names.id = ?`;
    countQuery = `
      SELECT COUNT(*) AS count
      FROM logs
      INNER JOIN names ON names.name = logs.name
      WHERE names.id = ?`;
    params = [Number(nameId)];
  } else {
    return response.status(400).json({ error: 'nameId must be all or an integer' });
  }

  const total = database.prepare(countQuery).get(...params).count;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;

  const rows = database.prepare(`
    SELECT logs.id, logs.name, logs.type, logs.timestamp
    ${baseQuery}
    ORDER BY logs.timestamp DESC, logs.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return response.json({
    rows,
    page: safePage,
    totalPages,
    total
  });
});

app.post('/api/logs', (request, response) => {
  const nameId = Number(request.body.nameId);
  const type = request.body.type;
  const latitude = Number(request.body.latitude);
  const longitude = Number(request.body.longitude);
  if (!Number.isInteger(nameId) || !['clock in', 'clock out'].includes(type)
    || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return response.status(400).json({ error: 'A valid nameId and clock type are required' });
  }

  const distance = distanceInMeters(latitude, longitude, APPROVED_LATITUDE, APPROVED_LONGITUDE);
  if (distance > MAX_DISTANCE_METERS) {
    return response.status(403).json({ error: 'You must be within 200 meters of the approved location' });
  }

  const name = database.prepare('SELECT name FROM names WHERE id = ?').get(nameId);
  if (!name) {
    return response.status(404).json({ error: 'Name not found' });
  }

  const updateStatus = database.prepare('UPDATE names SET status = ? WHERE id = ?');
  const addLog = database.prepare('INSERT INTO logs (name, timestamp, type) VALUES (?, CURRENT_TIMESTAMP, ?)');
  const saveClockEvent = database.transaction(() => {
    updateStatus.run(type === 'clock in' ? 'clocked in' : 'clocked out', nameId);
    addLog.run(name.name, type);
  });
  saveClockEvent();
  return response.status(201).json({ saved: true });
});

app.listen(port, () => {
  console.log(`Website running at http://localhost:${port}`);
});
