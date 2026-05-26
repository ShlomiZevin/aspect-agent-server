/**
 * Light-weight schema/invariant validator for AgentBody / CrewBody
 * shapes produced by the patch generator.
 *
 * Catches obvious malformed output before we save it. Not a full Zod —
 * the schema lives in TypeScript and a doc; trying to mirror it all in
 * JS would drift. We assert the high-value invariants (decision 60).
 *
 * Returns:
 *   { ok: true }
 *   { ok: false, errors: string[] }
 */

const KNOWN_PLUGINS  = new Set(['talker', 'field-extractor', 'transition-router']);
const VALID_LANES    = new Set(['main', 'background', 'offline']);
const VALID_OUTPUTS  = new Set(['text-to-user', 'json-to-memory', 'transition']);
const VALID_FIELD_TYPES   = new Set(['string', 'int', 'enum', 'boolean']);
const VALID_FIELD_SOURCES = new Set(['explicit', 'inferred']);
const VALID_HISTORY_MODES = new Set(['none', 'last_n', 'full']);

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function pushErr(errors, path, msg) {
  errors.push(`${path}: ${msg}`);
}

function checkFieldDef(field, path, errors) {
  if (!isObject(field)) { pushErr(errors, path, 'must be an object'); return; }
  if (typeof field.id !== 'string' || field.id.length === 0)
    pushErr(errors, `${path}.id`, 'required string');
  if (typeof field.name !== 'string' || field.name.length === 0)
    pushErr(errors, `${path}.name`, 'required string');
  if (!VALID_FIELD_TYPES.has(field.type))
    pushErr(errors, `${path}.type`, `must be one of ${[...VALID_FIELD_TYPES].join(', ')}`);
  if (!VALID_FIELD_SOURCES.has(field.source))
    pushErr(errors, `${path}.source`, `must be one of ${[...VALID_FIELD_SOURCES].join(', ')}`);
  if (typeof field.howToExtract !== 'string')
    pushErr(errors, `${path}.howToExtract`, 'required string (may be empty)');
  if (field.type === 'enum') {
    if (!Array.isArray(field.enumValues) || field.enumValues.length === 0)
      pushErr(errors, `${path}.enumValues`, 'required non-empty array for enum fields');
  }
}

function checkAddonInstance(addon, path, errors, knownFieldIds) {
  if (!isObject(addon)) { pushErr(errors, path, 'must be an object'); return; }
  if (typeof addon.instanceId !== 'string' || !addon.instanceId)
    pushErr(errors, `${path}.instanceId`, 'required string');
  if (!KNOWN_PLUGINS.has(addon.pluginId))
    pushErr(errors, `${path}.pluginId`, `unknown plugin "${addon.pluginId}"`);
  if (!VALID_LANES.has(addon.lane))
    pushErr(errors, `${path}.lane`, `must be one of ${[...VALID_LANES].join(', ')}`);
  if (typeof addon.enabled !== 'boolean')
    pushErr(errors, `${path}.enabled`, 'required boolean');
  if (!isObject(addon.config))
    pushErr(errors, `${path}.config`, 'required object');
  if (!isObject(addon.context))
    pushErr(errors, `${path}.context`, 'required object');
  else {
    if (!isObject(addon.context.history) || !VALID_HISTORY_MODES.has(addon.context.history.mode))
      pushErr(errors, `${path}.context.history.mode`, `must be one of ${[...VALID_HISTORY_MODES].join(', ')}`);
    if (typeof addon.context.persona !== 'boolean')
      pushErr(errors, `${path}.context.persona`, 'required boolean');
    if (!Array.isArray(addon.context.memoryReads))
      pushErr(errors, `${path}.context.memoryReads`, 'required array');
  }
  if (!VALID_OUTPUTS.has(addon.outputType))
    pushErr(errors, `${path}.outputType`, `must be one of ${[...VALID_OUTPUTS].join(', ')}`);
  if (typeof addon.promptTemplate !== 'string' || addon.promptTemplate.length === 0)
    pushErr(errors, `${path}.promptTemplate`, 'required non-empty string');

  // Per-plugin invariants.
  if (addon.pluginId === 'field-extractor') {
    if (!isObject(addon.config)) return;
    if (!Array.isArray(addon.config.extractsFields))
      pushErr(errors, `${path}.config.extractsFields`, 'required array');
    else {
      for (let i = 0; i < addon.config.extractsFields.length; i++) {
        const id = addon.config.extractsFields[i];
        if (typeof id !== 'string') {
          pushErr(errors, `${path}.config.extractsFields[${i}]`, 'must be a string id');
        } else if (knownFieldIds && !knownFieldIds.has(id)) {
          pushErr(errors, `${path}.config.extractsFields[${i}]`, `unknown field id "${id}" — not present in agent.fields or this crew's fields`);
        }
      }
    }
    if (typeof addon.config.prompt !== 'string')
      pushErr(errors, `${path}.config.prompt`, 'required string');
    if (!isObject(addon.config.model))
      pushErr(errors, `${path}.config.model`, 'required ModelRef object');
  }

  if (addon.pluginId === 'talker') {
    if (!isObject(addon.config)) return;
    if (typeof addon.config.prompt !== 'string')
      pushErr(errors, `${path}.config.prompt`, 'required string');
    if (!isObject(addon.config.model))
      pushErr(errors, `${path}.config.model`, 'required ModelRef object');
  }
}

function validateAgentBody(body) {
  const errors = [];
  if (!isObject(body)) return { ok: false, errors: ['body: must be an object'] };

  if (typeof body.name   !== 'string') pushErr(errors, 'name',   'required string');
  if (typeof body.slug   !== 'string') pushErr(errors, 'slug',   'required string');
  if (typeof body.spec   !== 'string') pushErr(errors, 'spec',   'required string');
  if (typeof body.persona !== 'string') pushErr(errors, 'persona', 'required string');
  if (body.defaultCrewId != null && typeof body.defaultCrewId !== 'string')
    pushErr(errors, 'defaultCrewId', 'must be a string id or omitted');

  if (!Array.isArray(body.fields))
    pushErr(errors, 'fields', 'required array (may be empty)');
  else {
    const seenIds = new Set();
    body.fields.forEach((f, i) => {
      checkFieldDef(f, `fields[${i}]`, errors);
      if (f && typeof f.id === 'string') {
        if (seenIds.has(f.id)) pushErr(errors, `fields[${i}].id`, `duplicate field id "${f.id}"`);
        seenIds.add(f.id);
      }
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateCrewBody(body, agentFieldIds = []) {
  const errors = [];
  if (!isObject(body)) return { ok: false, errors: ['body: must be an object'] };

  if (typeof body.name !== 'string') pushErr(errors, 'name', 'required string');
  if (typeof body.spec !== 'string') pushErr(errors, 'spec', 'required string');
  if (body.description != null && typeof body.description !== 'string')
    pushErr(errors, 'description', 'must be a string or omitted');
  if (body.persona != null && typeof body.persona !== 'string')
    pushErr(errors, 'persona', 'must be a string or omitted');

  const crewFieldIds = new Set();
  if (!Array.isArray(body.fields)) {
    pushErr(errors, 'fields', 'required array (may be empty)');
  } else {
    body.fields.forEach((f, i) => {
      checkFieldDef(f, `fields[${i}]`, errors);
      if (f && typeof f.id === 'string') {
        if (crewFieldIds.has(f.id)) pushErr(errors, `fields[${i}].id`, `duplicate field id "${f.id}"`);
        crewFieldIds.add(f.id);
      }
    });
  }

  const knownFieldIds = new Set([...agentFieldIds, ...crewFieldIds]);

  if (!Array.isArray(body.addons)) {
    pushErr(errors, 'addons', 'required array (may be empty)');
  } else {
    body.addons.forEach((a, i) => checkAddonInstance(a, `addons[${i}]`, errors, knownFieldIds));
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

module.exports = { validateAgentBody, validateCrewBody };
