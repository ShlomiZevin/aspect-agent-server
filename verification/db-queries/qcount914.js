// Queries per turn: q-log entries between a turn's start and the next turn's start.
const fs = require('fs'); const path = require('path');
const [runF, qF] = process.argv.slice(2).map(f => path.resolve(f));
const run = require(runF);
const qs = fs.readFileSync(qF, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const turns = run.conversations.flatMap(c => c.turns);
const counts = [], bySql = {};
turns.forEach((t, i) => {
  const end = turns[i + 1] ? turns[i + 1].start : t.end + 1200;
  const mine = qs.filter(q => q.t >= t.start && q.t < end);
  counts.push(mine.length);
  for (const q of mine) { const k = q.sql.slice(0, 70) + '  ← ' + (q.from[0] || '?'); bySql[k] = (bySql[k] || 0) + 1; }
});
const sum = counts.reduce((a, b) => a + b, 0);
console.log(`turns ${counts.length}, queries ${sum}, per turn avg ${(sum / counts.length).toFixed(1)}, min ${Math.min(...counts)}, max ${Math.max(...counts)}`);
console.log('per turn:', counts.join(' '));
if (process.argv.includes('--detail')) Object.entries(bySql).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(String(n).padStart(5), k));
