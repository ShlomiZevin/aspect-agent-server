/**
 * Seed: the "rules-test" demo agent — a small sandbox for the Rules
 * addon (deterministic if/then over memory, no LLM).
 *
 *   node scripts/seed-rules-test-agent.js
 *   node scripts/seed-rules-test-agent.js --reset
 *
 * Chain: Field Extractor (age / mood / birthdate) → Rules → Talker.
 *
 * The Rules addon demonstrates every capability:
 *   Rule 1 (always)          — formula value: age_group from {{age}}
 *   Rule 2 (formula WHEN)    — {{age}} > 50 && {{mood}} == "bad" → risk_level = high
 *   Rule 3 (field WHEN)      — mood equals "great" → clear risk_level
 *
 * Try: "I'm 62 and feeling bad today" → risk_level=high, age_group=50+.
 * Then: "actually I feel great now"   → risk_level cleared.
 */

require('dotenv').config();

const db = require('../services/db.pg');
const projects = require('../builder/services/builderProjects');
const { builderAgents } = require('../db/schema');
const { eq } = require('drizzle-orm');

const AGENT_SLUG    = 'rules-test';
const OWNER_USER_ID = 'builder-owner-letw5667-mpo9fmy6'; // Shlomi's builder identity
const WORKSPACE_ID  = 'ws_phgon7hlmrw6g6t6';             // Test Domain › Test Project
const RESET         = process.argv.includes('--reset');

function rid(prefix, len = 7) {
  return `${prefix}_${Math.random().toString(36).slice(2, 2 + len)}`;
}
const id = {
  project: () => rid('project'),
  agent:   () => rid('agent'),
  crew:    () => rid('crew'),
  version: () => rid('ver'),
  addon:   () => rid('addon'),
  field:   () => rid('field', 8),
  rule:    () => rid('rule', 8),
};

// ─── Fields ───────────────────────────────────────────────────────

const F = {
  age: {
    id: id.field(), name: 'age', type: 'int', source: 'inferred', domain: null,
    howToExtract: "The user's age in years, when stated (e.g. \"I'm 62\").",
  },
  mood: {
    id: id.field(), name: 'mood', type: 'string', source: 'inferred', domain: null,
    howToExtract: 'One word for how the user says they feel: bad / okay / great.',
  },
  birthdate: {
    id: id.field(), name: 'birthdate', type: 'string', source: 'inferred', domain: null,
    howToExtract: "The user's birth date if given, as YYYY-MM-DD.",
  },
  risk_level: {
    id: id.field(), name: 'risk_level', type: 'string', source: 'inferred', domain: null,
    howToExtract: 'Set by rules — do not extract.',
  },
  age_group: {
    id: id.field(), name: 'age_group', type: 'string', source: 'inferred', domain: null,
    howToExtract: 'Set by rules — do not extract.',
  },
};
const AGENT_FIELDS = Object.values(F);

// ─── Addons ───────────────────────────────────────────────────────

const EXTRACTOR = {
  instanceId: id.addon(),
  pluginId:   'field-extractor',
  lane:       'main',
  enabled:    true,
  config: {
    name:  'Info Extractor',
    model: { providerId: 'openai', modelId: 'gpt-4o-mini' },
    extractsFields: [F.age.id, F.mood.id, F.birthdate.id],
    prompt: `Extract the fields below from the conversation.

## Fields
{{fields_schema}}

## Already collected
{{fields_current}}

Output JSON only — one key per field you can determine from THIS message.
Omit keys you cannot determine. Do not invent values.`,
  },
  context:        { history: { mode: 'last_n', n: 4 } },
  outputType:     'json-to-memory',
  promptTemplate: '{{prompt}}',
};

const RULES = {
  instanceId: id.addon(),
  pluginId:   'rules',
  lane:       'main',
  enabled:    true,
  config: {
    name: 'Rules',
    rules: [
      {
        id: id.rule(),
        conditions: [],
        actions: [{
          type: 'set', field: 'age_group', valueMode: 'formula',
          formula: '{{age}} == null ? "unknown" : ({{age}} >= 50 ? "50+" : "under 50")',
        }],
      },
      {
        id: id.rule(),
        conditions: [{ type: 'formula', expr: '{{age}} > 50 && {{mood}} == "bad"' }],
        actions: [{ type: 'set', field: 'risk_level', valueMode: 'fixed', value: 'high' }],
      },
      {
        id: id.rule(),
        conditions: [{ type: 'field', field: 'mood', op: 'equals', value: 'great' }],
        actions: [{ type: 'clear', field: 'risk_level' }],
      },
    ],
    extractsFields: [F.age_group.id, F.risk_level.id],
  },
  context:        { history: { mode: 'none' } },
  outputType:     'json-to-memory',
  promptTemplate: '',
};

const TALKER = {
  instanceId: id.addon(),
  pluginId:   'talker',
  lane:       'main',
  enabled:    true,
  config: {
    name:  'Voice',
    model: { providerId: 'google', modelId: 'gemini-2.5-flash' },
    prompt: `{{persona}}

Current computed state (set deterministically by the Rules addon):
- age: {{field:age}}
- mood: {{field:mood}}
- age_group: {{field:age_group}}
- risk_level: {{field:risk_level}}

Reply briefly. ALWAYS end your reply with one line exactly in this format so
the rules are easy to verify:
[state: age_group=<value>, risk_level=<value or none>]`,
  },
  context:        { history: { mode: 'last_n', n: 6 } },
  outputType:     'text-to-user',
  promptTemplate: '{{prompt}}',
};

// ─── Bodies ───────────────────────────────────────────────────────

const PROJECT_ID   = id.project();
const AGENT_ID     = id.agent();
const AGENT_VER_ID = id.version();
const CREW_ID      = id.crew();
const CREW_VER_ID  = id.version();

const AGENT_BODY = {
  name:          'Rules Test',
  slug:          AGENT_SLUG,
  spec:          'Sandbox for the Rules addon: extractor pulls age/mood/birthdate, rules compute age_group + risk_level deterministically (formula value, formula WHEN, clear), talker echoes the state.',
  persona:       'You are a friendly test assistant. Keep replies to 1-2 sentences.',
  defaultCrewId: CREW_ID,
  fields:        AGENT_FIELDS,
  domains:       [],
  parameters:    [],
  enums:         [],
  snippets:      [],
  cortex:        [],
};

const CREW_BODY = {
  name:        'Main',
  description: 'Extractor → Rules → Talker.',
  spec:        'Linear chain, no transitions.',
  addons:      [EXTRACTOR, RULES, TALKER],
  fields:      [],
};

// ─── Run ──────────────────────────────────────────────────────────

async function main() {
  await db.initialize();
  const d = db.getDrizzle();

  const existing = await d.select({ id: builderAgents.id, projectId: builderAgents.projectId })
    .from(builderAgents)
    .where(eq(builderAgents.slug, AGENT_SLUG))
    .limit(1);

  if (existing.length > 0) {
    if (!RESET) {
      console.log(`✓ Agent "${AGENT_SLUG}" already exists. Pass --reset to recreate.`);
      return;
    }
    console.log(`Removing existing "${AGENT_SLUG}" project before reseed…`);
    await projects.deleteProject({ projectId: existing[0].projectId });
  }

  console.log(`Creating "${AGENT_SLUG}" agent…`);
  await projects.createProject({
    ownerUserId:    OWNER_USER_ID,
    projectId:      PROJECT_ID,
    projectName:    'Rules Test',
    agentId:        AGENT_ID,
    agentSlug:      AGENT_SLUG,
    agentVersionId: AGENT_VER_ID,
    agentBody:      AGENT_BODY,
    crewId:         CREW_ID,
    crewVersionId:  CREW_VER_ID,
    crewBody:       CREW_BODY,
  });

  // Place it in the Test Domain › Test Project folder on the homepage.
  await d.update(builderAgents)
    .set({ workspaceId: WORKSPACE_ID })
    .where(eq(builderAgents.id, AGENT_ID));

  console.log('✓ Seeded. Open /rules-test/builder — Test Domain › Test Project on the homepage.');
  console.log('Try: "I\'m 62 and feeling bad today" → risk_level=high, age_group=50+');
  console.log('Then: "actually I feel great now" → risk_level cleared.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('✗ Seed failed:', err);
    process.exit(1);
  });
