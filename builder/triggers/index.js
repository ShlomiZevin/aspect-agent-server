/**
 * Side-effect imports — register every built-in trigger type.
 *
 * Mirrors `builder/plugins/index.js`. Adding a trigger type is three
 * files (descriptor JSON, this server half, the client config UI) plus
 * one line here.
 */

require('./silence/trigger.silence');

module.exports = require('./registry');
