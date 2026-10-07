/**
 * In-process "stop this reload" flags, keyed by base schema name.
 *
 * Killing the running statement is not enough to stop a reload: the index and
 * MV builders catch a failed statement and move on to the next one, so a
 * terminated CREATE INDEX just meant the loop started the next index. On
 * 2026-10-07 a thestock run that had been "cancelled" kept building views for
 * minutes while the scheduler started a second run on the same shadow schema.
 *
 * The builders call throwIfAborted() before each step. Whoever learns that the
 * run is over — the cancel endpoint on this instance, or the heartbeat seeing
 * the DB row flip away from 'running' on another instance — calls request().
 *
 * Shadow names (`thestock_new`) map to their base schema, because the builders
 * only know the schema they are writing into.
 */

const aborted = new Map(); // baseSchema -> reason

function baseSchema(schema) {
  return String(schema).replace(/_new$/, '');
}

function request(schema, reason = 'Run cancelled') {
  aborted.set(baseSchema(schema), reason);
}

function clear(schema) {
  aborted.delete(baseSchema(schema));
}

function throwIfAborted(schema) {
  const reason = aborted.get(baseSchema(schema));
  if (reason) {
    const err = new Error(reason);
    err.aborted = true;
    throw err;
  }
}

module.exports = { request, clear, throwIfAborted };
