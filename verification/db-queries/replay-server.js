// #914 proof harness: the normal server against the STAGING DB, with
//  - every pg query logged (t, sql, our frames) to QLOG
//  - model calls recorded (MODE=record) or replayed (MODE=replay) from CASSETTE,
//    keyed by the exact model input — a replay miss means the input changed.
// Usage: MODE=record|replay CASSETTE=x.json QLOG=q.jsonl PORT=3100 node replay-server.js
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const SERVER = 'C:/workspace/aspect/aspect-agent-server';
process.chdir(SERVER);

const envLines = f => fs.readFileSync(path.join(SERVER, f), 'utf8').split(/\r?\n/);
// Staging env (dotenv won't override what is already set).
for (const l of envLines('.env.production.staging')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
// Nothing from the local .env may leak in (it holds production's OpenAI org/project ids).
for (const l of envLines('.env')) {
  const m = l.match(/^([A-Z0-9_]+)=/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = '';
}
process.env.NODE_ENV = 'development';
process.env.DB_HOST = '34.165.76.81';
process.env.DB_SSL = 'true';
process.env.PORT = process.env.PORT || '3100';

Error.stackTraceLimit = 60;
const pg = require(path.join(SERVER, 'node_modules/pg'));
const qlog = fs.createWriteStream(process.env.QLOG, { flags: 'w' });
const key = sql => String(typeof sql === 'string' ? sql : (sql && sql.text) || '').replace(/\s+/g, ' ').replace(/\$\d+/g, '?').trim().slice(0, 160);
function callers() {
  const out = [];
  for (const l of String(new Error().stack).split('\n').slice(2)) {
    const m = l.match(/at (?:async )?(?:(\S+) \()?([A-Za-z]:[^)]*aspect-agent-server[\\/]([^)]+?)):(\d+):\d+\)?/);
    if (!m) continue;
    const file = m[3].replace(/\\/g, '/');
    if (file.startsWith('node_modules/') || file.endsWith('db.pg.js')) continue;
    out.push(`${file}:${m[4]}${m[1] ? ` ${m[1]}` : ''}`);
    if (out.length >= 4) break;
  }
  return out;
}
const origPoolQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (config, values, cb) {
  const ev = { t: Date.now(), sql: key(config), from: callers() };
  qlog.write(JSON.stringify(ev) + '\n');
  return origPoolQuery.call(this, config, values, cb);
};

// ── Model record / replay ──
const MODE = process.env.MODE;
const CASSETTE = process.env.CASSETTE;
const tape = MODE === 'replay' ? JSON.parse(fs.readFileSync(CASSETTE, 'utf8')) : {};
const used = {};
const misses = [];
const save = () => { if (MODE === 'record') fs.writeFileSync(CASSETTE, JSON.stringify(tape)); };
const hash = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 24);
function take(k, input) {
  const list = tape[k];
  const i = used[k] || 0;
  if (!list || i >= list.length) {
    misses.push({ k, input });
    fs.writeFileSync(CASSETTE + '.misses.json', JSON.stringify(misses, null, 1));
    throw new Error(`REPLAY MISS ${k}`);
  }
  used[k] = i + 1;
  return list[i];
}
const llm = require(path.join(SERVER, 'services/llm.js'));
const realOneShot = llm.sendOneShot.bind(llm);
const realStream = llm.sendMessageStreamWithPrompt.bind(llm);
llm.sendOneShot = async function (instructions, message, options = {}) {
  const input = { m: 'oneShot', model: options.model, instructions, message, jsonOutput: options.jsonOutput, maxTokens: options.maxTokens, context: options.context };
  const k = hash(input);
  if (MODE === 'replay') return JSON.parse(JSON.stringify(take(k, input)));
  const out = await realOneShot(instructions, message, options);
  (tape[k] = tape[k] || []).push(out); save();
  return out;
};
llm.sendMessageStreamWithPrompt = async function* (message, conversationId, config = {}) {
  const input = { m: 'stream', model: config.model, prompt: config.prompt, message, history: config.historyMessages, context: config.context };
  const k = hash(input);
  if (MODE === 'replay') { for (const c of take(k, input)) yield c; return; }
  const chunks = [];
  for await (const c of realStream(message, conversationId, config)) { chunks.push(c); yield c; }
  (tape[k] = tape[k] || []).push(chunks); save();
};

require(path.join(SERVER, 'server.js'));
