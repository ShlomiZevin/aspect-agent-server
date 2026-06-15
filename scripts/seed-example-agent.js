/**
 * Seed: the "example" demo agent — small, focused walkthrough of the
 * enum bible + DC tokens + multi-field Reasoner.
 *
 *   node scripts/seed-example-agent.js
 *   node scripts/seed-example-agent.js --reset
 *
 * What this agent demonstrates:
 *
 *  - ONE enum (`priority`) declared on the agent's bible, with three
 *    values (`urgent` / `normal` / `low`) and two declared sections
 *    (`how_to_identify`, `how_to_respond`). Per-value content is
 *    authored ONCE on the bible.
 *
 *  - TWO fields bind to the same enum:
 *      • customer_request_priority — how the customer experiences
 *        the urgency.
 *      • team_response_priority   — how OUR team should handle it.
 *    Same enum, two fields = the big win over the old per-field DC
 *    model.
 *
 *  - ONE Field Reasoner with BOTH fields wired (multi-field). One LLM
 *    call derives both customer-side and team-side priorities, using
 *    the same bible for context.
 *
 *  - The Talker speaks adapting to the live values of both fields.
 *
 * Token tour (each used at least once in the prompts below):
 *
 *   {{enum:priority:values}}            inline list of declared values
 *                                       (used in the Reasoner schema line)
 *   {{enum:priority}}                   aggregate of every value's umbrella
 *                                       (used to brief the Reasoner)
 *   {{enum:priority:how_to_identify}}   aggregate of one section across values
 *                                       (used to give per-value identification rules)
 *   {{dc:customer_request_priority:how_to_respond}}
 *                                       live value's section body (Talker)
 *   {{dc:team_response_priority}}       live matched value's umbrella (Talker)
 *   {{fields_schema}} / {{fields_current}}
 *                                       multi-field schema + state blocks
 *                                       (used by the Reasoner)
 *
 * Open after seeding:  http://localhost:5173/example/builder
 */

require('dotenv').config();

const db = require('../services/db.pg');
const projects = require('../builder/services/builderProjects');
const { builderAgents } = require('../db/schema');
const { eq } = require('drizzle-orm');

const AGENT_SLUG     = 'example';
const OWNER_USER_ID  = 'example-seed-owner';
const RESET          = process.argv.includes('--reset');

// ─── id helpers ───────────────────────────────────────────────────

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
  enum:    () => rid('enum', 8),
  val:     () => rid('enumval', 8),
};

// ─── The enum bible — one type, three values, two sections ────────

const PRIORITY_ENUM_ID = id.enum();

const PRIORITY_ENUM = {
  id:   PRIORITY_ENUM_ID,
  name: 'priority',
  // Section names are declared on the enum (shared by every value).
  // Bodies are authored per-value below.
  sections: [
    { name: 'how_to_identify' },
    { name: 'how_to_respond' },
  ],
  values: [
    {
      id:    id.val(),
      value: 'urgent',
      umbrellaText:
        'A blocking issue — the customer cannot proceed until this is resolved. ' +
        'Treat as the top priority for the turn.',
      sectionTexts: {
        how_to_identify:
          'Explicit urgency markers ("ASAP", "right now", "emergency"), a description '
          + 'of a system that is currently down, or a hard deadline within the next hour.',
        how_to_respond:
          'Acknowledge the urgency in the very first sentence. Give a concrete ETA or '
          + 'next step. If you cannot fix it yourself, name the on-call route.',
      },
    },
    {
      id:    id.val(),
      value: 'normal',
      umbrellaText:
        'A standard request — important to the customer but not blocking. Handle in '
        + 'the next few hours.',
      sectionTexts: {
        how_to_identify:
          'Account changes, feature questions, billing inquiries with no immediate '
          + 'deadline. The customer wants progress today but is not stuck.',
        how_to_respond:
          'Confirm receipt, set a "within the next few hours" expectation, walk through '
          + 'the standard playbook.',
      },
    },
    {
      id:    id.val(),
      value: 'low',
      umbrellaText:
        'A nice-to-have request — informational, exploratory, or a suggestion with no '
        + 'deadline.',
      sectionTexts: {
        how_to_identify:
          '"When you have time" framing, feature suggestions, cosmetic feedback, requests '
          + 'to schedule something for next week or later.',
        how_to_respond:
          'Thank the customer for the input, log it for the backlog, give a rough '
          + 'timeframe (e.g. "next sprint") for any follow-up.',
      },
    },
  ],
};

const ENUMS = [PRIORITY_ENUM];

// ─── Fields — both bound to the SAME enum ─────────────────────────

const F = {
  customer_request_priority: {
    id:           id.field(),
    name:         'customer_request_priority',
    type:         'enum',
    enumType:     PRIORITY_ENUM_ID,
    source:       'inferred',
    domain:       'request',
    howToExtract:
      'The priority the CUSTOMER is signalling — what they think the urgency of '
      + 'this request is. Pull it from explicit urgency markers and the situation '
      + 'described.',
  },
  team_response_priority: {
    id:           id.field(),
    name:         'team_response_priority',
    type:         'enum',
    enumType:     PRIORITY_ENUM_ID,
    source:       'inferred',
    domain:       'response',
    howToExtract:
      'The priority OUR team should give to this request. Often matches the '
      + 'customer-signalled one but may be upgraded (compliance, outage spillover) '
      + 'or downgraded (low business impact, duplicate request).',
  },
};

const AGENT_FIELDS = Object.values(F);

// ─── Addon factory ────────────────────────────────────────────────

function makeAddon({
  pluginId, name, model, historyN, prompt,
  extractsFields = null, domain = null, lane = 'main', outputType,
}) {
  const config = { prompt, model };
  if (name !== undefined)           config.name           = name;
  if (extractsFields !== null)      config.extractsFields = extractsFields;
  if (domain !== null)              config.domain         = domain;
  return {
    instanceId:     id.addon(),
    pluginId,
    lane,
    enabled:        true,
    config,
    context:        { history: { mode: 'last_n', n: historyN } },
    outputType:     outputType || (pluginId === 'talker' ? 'text-to-user' : 'json-to-memory'),
    promptTemplate: '{{prompt}}',
  };
}

// ─── Persona ──────────────────────────────────────────────────────

const PERSONA = `You are a calm, helpful customer-support assistant.
You read the priority the customer is signalling, decide the team-side priority,
and reply with the right tempo for both.`;

// ─── Crew "Triage" — multi-field reasoner + talker ────────────────

const CREW_ADDONS = [
  // 1. ONE Field Reasoner derives BOTH priority fields in a single
  //    LLM call. Demonstrates: multi-field Reasoner + every enum
  //    aggregate token.
  makeAddon({
    pluginId:       'field-reasoner',
    name:           'Priority Reasoner',
    model:          { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    historyN:       6,
    extractsFields: [F.customer_request_priority.id, F.team_response_priority.id],
    prompt: `Read the conversation and derive BOTH priority fields below.

## Fields you must emit
{{fields_schema}}

## Already collected (this turn's prior state)
{{fields_current}}

## What each priority means (the bible)
{{enum:priority}}

## How to identify each priority (per-value rules)
{{enum:priority:how_to_identify}}

## Decision rules
- \`customer_request_priority\`: pick the value that best matches the
  customer's own urgency cues — explicit markers, deadlines, framing.
- \`team_response_priority\`: usually equals the customer one. Upgrade
  to \`urgent\` for compliance / security / outages. Downgrade to
  \`low\` for informational-only with no deadline.
- Allowed values (both fields): {{enum:priority:values}}.

## Output format
Output JSON only — one key per field. Omit a key when you cannot
decide confidently. Example shape:

  { "customer_request_priority": "<value>", "team_response_priority": "<value>" }
`,
  }),

  // 2. Talker — uses LIVE-VALUE DC tokens, adapting tempo to whatever
  //    the Reasoner just settled on.
  makeAddon({
    pluginId:       'talker',
    name:           'Support Voice',
    model:          { providerId: 'google', modelId: 'gemini-2.5-flash' },
    historyN:       6,
    prompt: `{{persona}}

Customer's request priority is **{{field:customer_request_priority}}**.
How to respond to that customer:
{{dc:customer_request_priority:how_to_respond}}

Our team's handling priority is **{{field:team_response_priority}}**:
{{dc:team_response_priority}}

Reply now — one reply, tuned to those two priorities.`,
  }),
];

// ─── Bodies ───────────────────────────────────────────────────────

const PROJECT_ID    = id.project();
const AGENT_ID      = id.agent();
const AGENT_VER_ID  = id.version();
const CREW_ID       = id.crew();
const CREW_VER_ID   = id.version();

const AGENT_BODY = {
  name:           'Example',
  slug:           AGENT_SLUG,
  spec:           'Minimal walkthrough of the enum bible + DC tokens + multi-field Reasoner. One enum, two fields binding to it, one Reasoner deriving both fields, one Talker speaking adapted to live values.',
  persona:        PERSONA,
  defaultCrewId:  CREW_ID,
  fields:         AGENT_FIELDS,
  domains:        ['request', 'response'],
  parameters:     [],
  enums:          ENUMS,
  snippets:       [],
  cortex:         [],
};

const CREW_BODY = {
  name:        'Triage',
  description: 'Derive both priorities in one Reasoner call, then reply tuned to them.',
  spec:        'Linear chain: Reasoner → Talker. No transitions.',
  addons:      CREW_ADDONS,
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

  console.log(`Creating "${AGENT_SLUG}" demo agent…`);
  await projects.createProject({
    ownerUserId:    OWNER_USER_ID,
    projectId:      PROJECT_ID,
    projectName:    'Example',
    agentId:        AGENT_ID,
    agentSlug:      AGENT_SLUG,
    agentVersionId: AGENT_VER_ID,
    agentBody:      AGENT_BODY,
    crewId:         CREW_ID,
    crewVersionId:  CREW_VER_ID,
    crewBody:       CREW_BODY,
  });

  console.log('');
  console.log('✓ Seeded.');
  console.log(`   enums            ${ENUMS.length}  (priority — 3 values × 2 sections)`);
  console.log(`   fields           ${AGENT_FIELDS.length}  (both bound to the priority enum)`);
  console.log(`   crew addons      ${CREW_ADDONS.length}  (multi-field reasoner → talker)`);
  console.log('');
  console.log(`Open at  /${AGENT_SLUG}/builder  to see the bible and the tokens in each prompt.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('✗ Seed failed:', err);
    process.exit(1);
  });
