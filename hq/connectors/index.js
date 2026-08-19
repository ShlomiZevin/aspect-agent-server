/**
 * Connector registry. Adding a source is one file plus one line here — the
 * engine, the routes and the UI all work off this list.
 */

const notion = require('./notion.connector');
const drive = require('./drive.connector');

const CONNECTORS = [notion, drive];

/** Declared but not built yet — the UI shows what's coming without pretending. */
const PLANNED = [
  { id: 'meet', name: 'Google Meet recordings' },
];

function get(id) {
  const found = CONNECTORS.find(c => c.id === id);
  if (!found) {
    // 404, not 500 — asking for a source that isn't built yet is a client
    // mistake, and a planned-but-absent one says so specifically.
    const planned = PLANNED.find(p => p.id === id);
    const err = new Error(planned
      ? `${planned.name} isn't connected yet`
      : `Unknown source "${id}"`);
    err.status = 404;
    throw err;
  }
  return found;
}

module.exports = { CONNECTORS, PLANNED, get, list: () => CONNECTORS };
