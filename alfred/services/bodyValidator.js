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

function checkFieldDef(field, path, errors, knownEnumIds) {
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
    // A NON-empty enumType must resolve against the agent's enum bible —
    // a dangling id renders as "(missing Targeted KB)" in the builder.
    // `knownEnumIds` is null when the caller has no bible to check
    // against (skip), a Set otherwise.
    else if (field.enumType && knownEnumIds && !knownEnumIds.has(field.enumType))
      pushErr(errors, `${path}.enumType`,
        `enum id "${field.enumType}" does not exist on agent.enums — bind an existing enum or include the new EnumTypeDef in the agent's enums section`);
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

  // Rules — deterministic if/then, no model, no prompt. Light shape
  // checks that catch the generator mistakes that matter: malformed
  // rule/action rows, unknown action types, and extractsFields carrying
  // field NAMES instead of ids (writes would lose their domain).
  if (addon.pluginId === 'rules') {
    if (!isObject(addon.config)) return;
    const RULE_ACTION_TYPES = new Set(['set', 'clear', 'transition', 'stop', 'reply']);
    if (!Array.isArray(addon.config.rules)) {
      pushErr(errors, `${path}.config.rules`, 'required array');
    } else {
      addon.config.rules.forEach((r, ri) => {
        const rp = `${path}.config.rules[${ri}]`;
        if (!isObject(r)) { pushErr(errors, rp, 'must be an object'); return; }
        if (typeof r.id !== 'string' || !r.id) pushErr(errors, `${rp}.id`, 'required string');
        if (!Array.isArray(r.conditions)) pushErr(errors, `${rp}.conditions`, 'required array (empty = always fires)');
        if (!Array.isArray(r.actions) || r.actions.length === 0) {
          pushErr(errors, `${rp}.actions`, 'required non-empty array');
        } else {
          r.actions.forEach((a, ai) => {
            const ap = `${rp}.actions[${ai}]`;
            if (!isObject(a) || !RULE_ACTION_TYPES.has(a.type)) {
              pushErr(errors, `${ap}.type`, `must be one of ${[...RULE_ACTION_TYPES].join(', ')}`);
              return;
            }
            if ((a.type === 'set' || a.type === 'clear') && (typeof a.field !== 'string' || !a.field))
              pushErr(errors, `${ap}.field`, 'required field name for set/clear');
            if (a.type === 'set' && a.valueMode === 'formula' && (typeof a.formula !== 'string' || !a.formula.trim()))
              pushErr(errors, `${ap}.formula`, 'required expression when valueMode is "formula"');
            if (a.type === 'transition' && (typeof a.target !== 'string' || !a.target))
              pushErr(errors, `${ap}.target`, 'required crew id for transition');
            if (a.type === 'reply' && (typeof a.text !== 'string' || !a.text.trim()))
              pushErr(errors, `${ap}.text`, 'required text for reply');
          });
        }
      });
    }
    if (!Array.isArray(addon.config.extractsFields)) {
      pushErr(errors, `${path}.config.extractsFields`, 'required array (ids of fields the rules touch)');
    } else if (knownFieldIds) {
      addon.config.extractsFields.forEach((fid, i) => {
        if (typeof fid !== 'string' || !knownFieldIds.has(fid))
          pushErr(errors, `${path}.config.extractsFields[${i}]`, `unknown field id "${fid}" — must be a field ID (not a name) from agent.fields or this crew's fields`);
      });
    }
  }
}

const VALID_PANEL_RENDERS = new Set(['text', 'html', 'tags', 'fields', 'bars', 'cards', 'journey']);
const VALID_PANEL_PLACEMENTS = new Set(['header', 'body']);
const VALID_PROFILER_OPEN_MODES = new Set(['third', 'half', 'full']);

/** Per-panel checks shared by Live Brain and Profiler (a ProfilerPanel
 *  is structurally a BrainPanel + placement/description). Catches
 *  generator mistakes (missing prompt/model/trigger on an AI panel,
 *  bogus render) without re-implementing the full type. */
function checkPanel(p, path, errors, { allowPlacement = false } = {}) {
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
  if (allowPlacement && p.placement !== undefined && !VALID_PANEL_PLACEMENTS.has(p.placement))
    pushErr(errors, `${path}.placement`, 'when present must be "header" or "body"');
}

/** Light checks for agent.liveBrain (LiveBrainDef). */
function checkLiveBrain(liveBrain, errors) {
  if (!isObject(liveBrain)) {
    pushErr(errors, 'liveBrain', 'when present must be an object');
    return;
  }
  if (!Array.isArray(liveBrain.panels)) {
    pushErr(errors, 'liveBrain.panels', 'required array (may be empty)');
    return;
  }
  liveBrain.panels.forEach((p, i) => checkPanel(p, `liveBrain.panels[${i}]`, errors));
}

/** Light checks for agent.profiler (ProfilerDef): panels (with
 *  placement) + the ask block + frame. */

/**
 * Triggers (proactive) — see docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * Light shape checks only, matching the house style: the server does
 * not police the semantics of a trigger type's own config (that lives
 * in the type). What it DOES police is the handful of fields whose
 * absence would make a trigger silently do nothing or, worse, do
 * something unbounded.
 */
function checkTriggers(triggers, errors) {
  if (!isObject(triggers)) {
    pushErr(errors, 'triggers', 'when present must be an object');
    return;
  }
  if ('enabled' in triggers && triggers.enabled !== undefined && typeof triggers.enabled !== 'boolean') {
    pushErr(errors, 'triggers.enabled', 'when present must be a boolean');
  }
  if (!Array.isArray(triggers.triggers)) {
    pushErr(errors, 'triggers.triggers', 'required array (may be empty)');
    return;
  }
  const seen = new Set();
  triggers.triggers.forEach((t, i) => {
    const at = `triggers.triggers[${i}]`;
    if (!isObject(t)) { pushErr(errors, at, 'must be an object'); return; }
    if (typeof t.id !== 'string' || !t.id) pushErr(errors, `${at}.id`, 'required string');
    else if (seen.has(t.id)) pushErr(errors, `${at}.id`, `duplicate trigger id "${t.id}"`);
    else seen.add(t.id);
    if (typeof t.name !== 'string') pushErr(errors, `${at}.name`, 'required string');
    if (typeof t.typeId !== 'string' || !t.typeId) pushErr(errors, `${at}.typeId`, 'required string (a registered trigger type, e.g. "silence")');
    if (typeof t.enabled !== 'boolean') pushErr(errors, `${at}.enabled`, 'required boolean');
    if (!isObject(t.config)) pushErr(errors, `${at}.config`, 'required object (shape defined by the trigger type)');
    // activeSince is what makes backfill impossible: without it a
    // trigger would treat every long-dead conversation as fair game
    // and nudge all of them on its first tick.
    if (typeof t.activeSince !== 'string' || Number.isNaN(Date.parse(t.activeSince))) {
      pushErr(errors, `${at}.activeSince`, 'required ISO timestamp — stamped when the trigger is switched on; without it the trigger would reach back into old conversations');
    }
    if (!isObject(t.run)) {
      pushErr(errors, `${at}.run`, 'required object { crewId, brief? }');
    } else {
      if (typeof t.run.crewId !== 'string' || !t.run.crewId) {
        pushErr(errors, `${at}.run.crewId`, 'required crew id — a trigger with no crew can never do anything');
      }
      if ('brief' in t.run && t.run.brief !== undefined && typeof t.run.brief !== 'string') {
        pushErr(errors, `${at}.run.brief`, 'when present must be a string');
      }
    }
    if ('quietHours' in t && t.quietHours !== undefined) {
      const q = t.quietHours;
      if (!isObject(q)) pushErr(errors, `${at}.quietHours`, 'when present must be an object');
      else {
        for (const k of ['from', 'to']) {
          if (!/^d{2}:d{2}$/.test(String(q[k] || ''))) {
            pushErr(errors, `${at}.quietHours.${k}`, 'required "HH:MM" (24h)');
          }
        }
        if (typeof q.timezone !== 'string' || !q.timezone) {
          pushErr(errors, `${at}.quietHours.timezone`, 'required IANA zone, e.g. "Asia/Jerusalem"');
        }
      }
    }
  });
}

function checkProfiler(profiler, errors) {
  if (!isObject(profiler)) {
    pushErr(errors, 'profiler', 'when present must be an object');
    return;
  }
  if (!Array.isArray(profiler.panels)) {
    pushErr(errors, 'profiler.panels', 'required array (may be empty)');
  } else {
    profiler.panels.forEach((p, i) =>
      checkPanel(p, `profiler.panels[${i}]`, errors, { allowPlacement: true }));
  }
  if ('ask' in profiler && profiler.ask !== undefined) {
    const a = profiler.ask;
    if (!isObject(a)) {
      pushErr(errors, 'profiler.ask', 'when present must be an object');
    } else {
      if (typeof a.enabled !== 'boolean')
        pushErr(errors, 'profiler.ask.enabled', 'required boolean');
      if (!isObject(a.model))
        pushErr(errors, 'profiler.ask.model', 'required ModelRef object');
      if (typeof a.prompt !== 'string')
        pushErr(errors, 'profiler.ask.prompt', 'required string (empty = server default)');
      if ('chips' in a && a.chips !== undefined && !Array.isArray(a.chips))
        pushErr(errors, 'profiler.ask.chips', 'when present must be an array of strings');
    }
  }
  if ('frame' in profiler && profiler.frame !== undefined) {
    const f = profiler.frame;
    if (!isObject(f)) {
      pushErr(errors, 'profiler.frame', 'when present must be an object');
    } else if (f.openMode !== undefined && !VALID_PROFILER_OPEN_MODES.has(f.openMode)) {
      pushErr(errors, 'profiler.frame.openMode', 'when present must be "third", "half" or "full"');
    }
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

  // Enum bible — light shape check + the id set that fields' enumType
  // must resolve against.
  const enumIds = new Set();
  if ('enums' in body && body.enums !== undefined) {
    if (!Array.isArray(body.enums)) {
      pushErr(errors, 'enums', 'when present must be an array');
    } else {
      body.enums.forEach((e, i) => {
        if (!isObject(e)) { pushErr(errors, `enums[${i}]`, 'must be an object'); return; }
        if (typeof e.id !== 'string' || !e.id) pushErr(errors, `enums[${i}].id`, 'required string');
        else {
          if (enumIds.has(e.id)) pushErr(errors, `enums[${i}].id`, `duplicate enum id "${e.id}"`);
          enumIds.add(e.id);
        }
        if (typeof e.name !== 'string' || !e.name) pushErr(errors, `enums[${i}].name`, 'required string');
        if (!Array.isArray(e.values)) pushErr(errors, `enums[${i}].values`, 'required array');
      });
    }
  }

  if (!Array.isArray(body.fields))
    pushErr(errors, 'fields', 'required array (may be empty)');
  else {
    const seenIds = new Set();
    body.fields.forEach((f, i) => {
      checkFieldDef(f, `fields[${i}]`, errors, enumIds);
      if (f && typeof f.id === 'string') {
        if (seenIds.has(f.id)) pushErr(errors, `fields[${i}].id`, `duplicate field id "${f.id}"`);
        seenIds.add(f.id);
      }
    });
  }

  if ('liveBrain' in body && body.liveBrain !== undefined)
    checkLiveBrain(body.liveBrain, errors);

  if ('profiler' in body && body.profiler !== undefined)
    checkProfiler(body.profiler, errors);

  if ('triggers' in body && body.triggers !== undefined)
    checkTriggers(body.triggers, errors);

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateCrewBody(body, agentFieldIds = [], agentEnumIds = null) {
  const errors = [];
  if (!isObject(body)) return { ok: false, errors: ['body: must be an object'] };

  if (typeof body.name !== 'string') pushErr(errors, 'name', 'required string');
  if (typeof body.spec !== 'string') pushErr(errors, 'spec', 'required string');
  if (body.description != null && typeof body.description !== 'string')
    pushErr(errors, 'description', 'must be a string or omitted');
  if (body.persona != null && typeof body.persona !== 'string')
    pushErr(errors, 'persona', 'must be a string or omitted');

  // Crew fields' enumType resolves against the AGENT's bible (enums
  // live only on the agent body). Callers pass the id list from the
  // (post-patch) agent body context; null = no context, skip the check.
  const knownEnumIds = Array.isArray(agentEnumIds) ? new Set(agentEnumIds) : null;

  const crewFieldIds = new Set();
  if (!Array.isArray(body.fields)) {
    pushErr(errors, 'fields', 'required array (may be empty)');
  } else {
    body.fields.forEach((f, i) => {
      checkFieldDef(f, `fields[${i}]`, errors, knownEnumIds);
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
