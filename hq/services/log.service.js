/**
 * HQ — saying out loud what a worker is doing.
 *
 * There was none of this. Maya could run a twenty-turn job costing real money
 * and the server said nothing at all: five log lines existed in the whole HQ
 * worker path and every one of them was a failure case. When a job went wrong
 * the only evidence was whatever the UI happened to have rendered, and after a
 * refresh not even that.
 *
 * So: one line per thing that happens, on one line each, prefixed and readable
 * in a terminal. Cloud Run keeps stdout, so the same lines are the production
 * trace.
 *
 * Deliberately not a logging library — this has to be legible while you watch
 * it scroll, which rules out JSON per line.
 */

const ON = process.env.HQ_LOG !== 'off';

const GREY = '\x1b[90m';
const PINK = '\x1b[95m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const OFF = '\x1b[0m';

/** Colour only when a person is watching; a log file should not hold escapes. */
const paint = (c, s) => (process.stdout.isTTY ? `${c}${s}${OFF}` : s);

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Short enough to scan, long enough to identify. */
function brief(value, max = 90) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function line(colour, tag, message, detail) {
  if (!ON) return;
  const parts = [
    paint(GREY, stamp()),
    paint(colour, `[hq:${tag}]`),
    message,
    detail ? paint(GREY, detail) : '',
  ];
  console.log(parts.filter(Boolean).join(' '));
}

const log = {
  /** A person said something to a worker. */
  message: (worker, conversationId, text) =>
    line(PINK, worker, `◀ ${brief(text, 110)}`, `conv ${conversationId}`),

  /** One request to the model. */
  turn: (worker, n, model) =>
    line(GREY, worker, `turn ${n}`, model),

  /** What the model said out loud, as against what it did. */
  said: (worker, text) =>
    line(PINK, worker, `▶ ${brief(text, 110)}`),

  toolStart: (worker, tool, input) =>
    line(CYAN, worker, `→ ${tool}`, brief(input)),

  toolDone: (worker, tool, ms, result) =>
    line(GREEN, worker, `✓ ${tool}`, `${ms}ms  ${brief(result, 70)}`),

  toolFailed: (worker, tool, ms, error) =>
    line(RED, worker, `✗ ${tool}`, `${ms}ms  ${error}`),

  /** Progress a tool reports while it is still working. */
  progress: (worker, tool, note) =>
    line(GREY, worker, `  ${tool}`, note),

  jobStarted: (worker, jobId, title, steps, estimate) =>
    line(YELLOW, worker, `▣ job ${jobId} — ${title}`,
      `${steps} steps, est $${Number(estimate || 0).toFixed(2)}`),

  jobStep: (worker, jobId, n, total, status, title) =>
    line(YELLOW, worker, `▣ job ${jobId}  step ${n}/${total} ${status}`, brief(title, 70)),

  jobDone: (worker, jobId, cost) =>
    line(YELLOW, worker, `▣ job ${jobId} finished`, `$${Number(cost || 0).toFixed(4)}`),

  /** The whole exchange, once it is over. */
  finished: (worker, turns, tools, ms, usage) =>
    line(GREEN, worker, `done — ${turns} turns, ${tools} tool calls`,
      `${(ms / 1000).toFixed(1)}s  in ${usage.inputTokens} / out ${usage.outputTokens}`),

  failed: (worker, error) =>
    line(RED, worker, `FAILED — ${error}`),
};

module.exports = log;
