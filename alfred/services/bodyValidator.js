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

const fs = require('fs');
const path = require('path');

/**
 * Source of truth for the set of known plugin ids: the descriptor
 * JSON files in `builder/addons/`. Same scan the patch generator and
 * brainstorm Alfred do — guarantees the validator stays in sync as
 * new addons are added. Server restart picks them up.
 */
function loadKnownPlugins() {
  const dir = path.join(__dirname, '..', '..', 'builder', 'addons');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.addon.json'));
    const ids = files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).pluginId;
      } catch {
        return null;
      }
    }).filter(Boolean);
    return new Set(ids);
  } catch (err) {
    console.warn('[bodyValidator] failed to load addon descriptors:', err.message);
    // Fall back to the original built-in set so validation still works
    // even if the addons folder is unreadable.
    return new Set(['talker', 'field-extractor', 'transition-router']);
  }
}
const KNOWN_PLUGINS  = loadKnownPlugins();
const VALID_LANES    = new Set(['main', 'background', 'offline']);
const VALID_OUTPUTS  = new Set(['text-to-user', 'json-to-memory', 'transition']);
const VALID_FIELD_TYPES   = new Set(['string', 'int', 'enum', 'boolean']);
const VALID_FIELD_SOURCES = new Set(['explicit', 'inferred', 'pinned']);
// Mirrors the HistoryMode union in builder/types/index.ts —
// `full` is the legacy alias for `all`.
const VALID_HISTORY_MODES = new Set([
  'none', 'all', 'full', 'last_n', 'since_transition', 'since_summarizer',
]);

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
    // `enumType` points at an EnumTypeDef.id on `agent.enums`. Empty is
    // allowed at validation time (field can be authored before the
    // enum exists), but the runtime will treat the field as unwired.
    if (field.enumType !== undefined && typeof field.enumType !== 'string')
      pushErr(errors, `${path}.enumType`, 'must be a string id when present');
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
  if ('joinsPreviousStep' in addon && addon.joinsPreviousStep !== undefined
      && typeof addon.joinsPreviousStep !== 'boolean')
    pushErr(errors, `${path}.joinsPreviousStep`, 'when present must be a boolean');
  if (!isObject(addon.config))
    pushErr(errors, `${path}.config`, 'required object');
  if (!isObject(addon.context))
    pushErr(errors, `${path}.context`, 'required object');
  else {
    const hist = addon.context.history;
    if (!isObject(hist) || !VALID_HISTORY_MODES.has(hist.mode)) {
      pushErr(errors, `${path}.context.history.mode`, `must be one of ${[...VALID_HISTORY_MODES].join(', ')}`);
    } else {
      if (hist.mode === 'last_n' && typeof hist.n !== 'number')
        pushErr(errors, `${path}.context.history.n`, 'required number when mode is last_n');
      if (hist.mode === 'since_summarizer' && (typeof hist.summarizerName !== 'string' || !hist.summarizerName))
        pushErr(errors, `${path}.context.history.summarizerName`, 'required string when mode is since_summarizer');
    }
    // Phase B: persona / memoryReads / thinkingReads were dropped — the
    // prompt now owns placement via {{...}} tokens. `context` carries
    // runtime knobs only: history + optional trigger (offline lane) +
    // optional filter (run gate).
    if ('trigger' in addon.context && addon.context.trigger !== undefined && !isObject(addon.context.trigger))
      pushErr(errors, `${path}.context.trigger`, 'when present must be an object');
    if ('filter' in addon.context && addon.context.filter !== undefined) {
      const f = addon.context.filter;
      if (!isObject(f) || !Array.isArray(f.conditions))
        pushErr(errors, `${path}.context.filter`, 'when present must be an object with a conditions array');
    }
  }
  if (!VALID_OUTPUTS.has(addon.outputType))
    pushErr(errors, `${path}.outputType`, `must be one of ${[...VALID_OUTPUTS].join(', ')}`);
  // Empty is legitimate for non-LLM plugins (transition-router,
  // kb-retriever) — their descriptors ship an empty template.
  if (typeof addon.promptTemplate !== 'string')
    pushErr(errors, `${path}.promptTemplate`, 'required string (may be empty)');

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

const VALID_PANEL_RENDERS = new Set(['text', 'html', 'tags', 'fields', 'bars', 'cards']);

/** Light checks for agent.liveBrain (LiveBrainDef). Catches generator
 *  mistakes (missing prompt/model/trigger on an AI panel, bogus render)
 *  without re-implementing the full type. */
function checkLiveBrain(liveBrain, errors) {
  if (!isObject(liveBrain)) {
    pushErr(errors, 'liveBrain', 'when present must be an object');
    return;
  }
  if (!Array.isArray(liveBrain.panels)) {
    pushErr(errors, 'liveBrain.panels', 'required array (may be empty)');
    return;
  }
  liveBrain.panels.forEach((p, i) => {
    const path = `liveBrain.panels[${i}]`;
    if (!isObject(p)) { pushErr(errors, path, 'must be an object'); return; }
    if (typeof p.id !== 'string' || !p.id)
      pushErr(errors, `${path}.id`, 'required string');
    if (typeof p.title !== 'string')
      pushErr(errors, `${path}.title`, 'required string');
    if (!VALID_PANEL_RENDERS.has(p.render))
      pushErr(errors, `${path}.render`, `must be one of ${[...VALID_PANEL_RENDERS].join(', ')}`);
    const src = p.source;
    if (!isObject(src)) {
      pushErr(errors, `${path}.source`, 'required object');
    } else if (src.kind === 'text') {
      if (typeof src.text !== 'string')
        pushErr(errors, `${path}.source.text`, 'required string for kind "text"');
    } else if (src.kind === 'prompt') {
      if (typeof src.prompt !== 'string')
        pushErr(errors, `${path}.source.prompt`, 'required string for kind "prompt"');
      if (!isObject(src.model))
        pushErr(errors, `${path}.source.model`, 'required ModelRef object for kind "prompt"');
      if (!isObject(src.history) || !VALID_HISTORY_MODES.has(src.history.mode))
        pushErr(errors, `${path}.source.history.mode`, `must be one of ${[...VALID_HISTORY_MODES].join(', ')}`);
      if (!isObject(src.trigger) || typeof src.trigger.kind !== 'string')
        pushErr(errors, `${path}.source.trigger`, 'required object with a kind for kind "prompt"');
    } else {
      pushErr(errors, `${path}.source.kind`, 'must be "text" or "prompt"');
    }
    if ('filter' in p && p.filter !== undefined) {
      if (!isObject(p.filter) || !Array.isArray(p.filter.conditions))
        pushErr(errors, `${path}.filter`, 'when present must be an object with a conditions array');
    }
  });
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

  if ('liveBrain' in body && body.liveBrain !== undefined)
    checkLiveBrain(body.liveBrain, errors);

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
