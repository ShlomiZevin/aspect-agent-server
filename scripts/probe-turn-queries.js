// Dev tool (turn query map, verification/db-queries/): starts the normal server
// with the pg pool wrapped — every query logged with its start time, duration,
// SQL and (when the driver allows) the frames of our code, to QMAP_FILE (JSON lines).
//   QMAP_FILE=queries.jsonl node scripts/probe-turn-queries.js   (then run turns against :3000)
// Note: pool.query and the checked-out client both log — keep the entries without "(checked-out client)".
const path = require('path');
const fs = require('fs');
const SERVER = path.join(__dirname, '..');
process.chdir(SERVER);
Error.stackTraceLimit = 60;
const pg = require(path.join(SERVER, 'node_modules/pg'));
const OUT = process.env.QMAP_FILE;
const stream = fs.createWriteStream(OUT, { flags: 'w' });

const key = sql => String(typeof sql === 'string' ? sql : (sql && sql.text) || '').replace(/\s+/g, ' ').replace(/\$\d+/g, '?').trim().slice(0, 140);

function callers() {
  const lines = String(new Error().stack).split('\n').slice(2);
  const ours = [];
  for (const l of lines) {
    const m = l.match(/at (?:async )?(?:(\S+) \()?([A-Za-z]:[^)]*aspect-agent-server[\\/]([^)]+?)):(\d+):\d+\)?/);
    if (!m) continue;
    const file = m[3].replace(/\\/g, '/');
    if (file.startsWith('node_modules/') || file.endsWith('db.pg.js')) continue;
    ours.push(`${file}:${m[4]}${m[1] ? ` ${m[1]}` : ''}`);
    if (ours.length >= 4) break;
  }
  return ours;
}

const origPoolQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (config, values, cb) {
  const t0 = Date.now();
  const ev = { t: t0, sql: key(config), from: callers() };
  const done = () => { ev.ms = Date.now() - t0; stream.write(JSON.stringify(ev) + '\n'); };
  if (typeof values === 'function') { const f = values; values = (...a) => { done(); f(...a); }; }
  else if (typeof cb === 'function') { const f = cb; cb = (...a) => { done(); f(...a); }; }
  const r = origPoolQuery.call(this, config, values, cb);
  if (r && typeof r.then === 'function') r.then(done, done);
  return r;
};
// Queries on a checked-out client (transactions, LISTEN) — logged too.
const origConnect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function (cb) {
  const from = callers();
  const wrap = c => {
    if (c && !c.__qmap) {
      c.__qmap = true;
      const oq = c.query;
      c.query = function (config, values, cb2) {
        const t0 = Date.now();
        const ev = { t: t0, sql: key(config), from: ['(checked-out client) ' + (from[0] || '?'), ...callers()], client: true };
        const done = () => { ev.ms = Date.now() - t0; stream.write(JSON.stringify(ev) + '\n'); };
        if (typeof values === 'function') { const f = values; values = (...a) => { done(); f(...a); }; }
        else if (typeof cb2 === 'function') { const f = cb2; cb2 = (...a) => { done(); f(...a); }; }
        const r = oq.call(this, config, values, cb2);
        if (r && typeof r.then === 'function') r.then(done, done);
        return r;
      };
    }
    return c;
  };
  if (cb) return origConnect.call(this, (e, c, rel) => cb(e, wrap(c), rel));
  return origConnect.call(this).then(wrap);
};
require(path.join(SERVER, 'server.js'));
