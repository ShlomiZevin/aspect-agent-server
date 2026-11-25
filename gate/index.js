/**
 * Lybi Gate (beta) — the data gate between a bank and Lybi. A side project:
 * its own router, services and gate_* tables; it does not touch agents,
 * crews or the runtime. Mounted in server.js:
 *
 *   app.use('/api/gate', require('./gate'));
 *
 * Read gate/README.md first.
 */

const { createGateRouter } = require('./routes');

module.exports = createGateRouter();
module.exports.createGateRouter = createGateRouter;
