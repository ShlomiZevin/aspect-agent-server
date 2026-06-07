/**
 * One-shot script: seed the Cardly demo agent in Builder V2.
 *
 * Cardly is the end-to-end demo described in
 * `docs/guides/BUILDER_V2_EXAMPLE_CARDLY.md` — a single-crew banking
 * sales agent that exercises every V2 feature shipped so far
 * (Persona, parameters, domains, fields, dynamic contexts with
 * sections, agent cortex with field extractor / vibe extractor /
 * field reasoners, and a crew cortex with extractor → reasoner →
 * thinker → talker).
 *
 * Run from aspect-agent-server:
 *   node scripts/seed-cardly-agent.js
 *
 * Re-run safe: if a project/agent with slug "cardly" already exists,
 * the script bails. Pass --reset to delete and recreate.
 *
 *   node scripts/seed-cardly-agent.js --reset
 *
 * Then open http://localhost:5173/cardly/builder in the React client.
 */

require('dotenv').config();

const db = require('../services/db.pg');
const projects = require('../builder/services/builderProjects');
const {
  builderProjects,
  builderAgents,
} = require('../db/schema');
const { eq } = require('drizzle-orm');

const AGENT_SLUG = 'cardly';
const OWNER_USER_ID = 'cardly-seed-owner';
const RESET = process.argv.includes('--reset');

// ─── ID helpers (match client `uid()` and friends) ────────────────

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
  dc:      () => rid('dc', 8),
  param:   () => `param_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
};

// ─── Field definitions (agent-scoped) ─────────────────────────────

const F = {
  customer_name:        { id: id.field(), name: 'customer_name',        type: 'string',  source: 'explicit', domain: 'customer', howToExtract: 'Capture the customer first name when they state it ("I\'m Sara").' },
  is_existing_customer: { id: id.field(), name: 'is_existing_customer', type: 'boolean', source: 'inferred', domain: 'customer', howToExtract: 'True if the customer mentions already banking with us; false if they mention another bank as their primary; otherwise leave blank.' },
  existing_card_loyalty:{ id: id.field(), name: 'existing_card_loyalty',type: 'string',  source: 'inferred', domain: 'customer', howToExtract: 'The competing card or bank the customer mentions using today (e.g. "Chase", "Amex Platinum").' },
  customer_income_band: { id: id.field(), name: 'customer_income_band', type: 'enum',    source: 'inferred', domain: 'customer', enumValues: ['under_50k', '50k_100k', '100k_200k', 'over_200k'], howToExtract: 'Reasoned from occupation, lifestyle markers, large purchases, premium products mentioned.' },
  customer_credit_tier: { id: id.field(), name: 'customer_credit_tier', type: 'enum',    source: 'inferred', domain: 'customer', enumValues: ['starter', 'good', 'premium'], howToExtract: 'Reasoned from income band, existing card loyalty, mentions of debt or missed payments.' },
  customer_priority:    { id: id.field(), name: 'customer_priority',    type: 'enum',    source: 'inferred', domain: 'customer', enumValues: ['travel', 'cashback', 'low_fees', 'build_credit'], howToExtract: 'Reasoned from themes across recent messages — travel mentions, fee sensitivity, score concerns, lifestyle.' },
  mood:                 { id: id.field(), name: 'mood',                 type: 'enum',    source: 'inferred', domain: 'signal',   enumValues: ['curious', 'skeptical', 'hurried', 'stressed', 'enthusiastic', 'hostile'], howToExtract: 'Read between the lines — word choice, pacing, hedging, urgency. Trust patterns over single utterances.' },
  objection_type:       { id: id.field(), name: 'objection_type',       type: 'enum',    source: 'inferred', domain: 'signal',   enumValues: ['fees', 'interest', 'credit_check', 'loyalty_to_other_bank', 'not_interested', 'privacy'], howToExtract: 'The specific concern the customer is raising. Leave blank if no objection has been voiced this turn.' },
  recommended_card:     { id: id.field(), name: 'recommended_card',     type: 'enum',    source: 'inferred', domain: 'pitch',    enumValues: ['bronze', 'silver', 'platinum', 'business'], howToExtract: 'Card best matched to the inferred credit tier and priority. See the Card Matcher prompt for the decision tree.' },
  pitch_stage:          { id: id.field(), name: 'pitch_stage',          type: 'enum',    source: 'inferred', domain: 'pitch',    enumValues: ['rapport', 'discovery', 'objection_handling', 'closing', 'declined'], howToExtract: 'Where the conversation sits in the sales arc.' },
};

const AGENT_FIELDS = Object.values(F);

// ─── Parameters (agent-wide, `#` token) ───────────────────────────

const PARAMS = [
  { id: id.param(), name: 'bankName',             value: 'Vaultwise Bank',                              description: 'Bank display name' },
  { id: id.param(), name: 'supportPhone',         value: '1-800-VAULT-HELP',                            description: 'Customer support phone' },
  { id: id.param(), name: 'branchName',           value: 'Premier Center',                              description: 'Branch / channel name' },
  { id: id.param(), name: 'complianceDisclaimer', value: 'Terms apply. APR varies by credit profile.',  description: 'Mandatory compliance line' },
  { id: id.param(), name: 'cardLineup',           value: 'Bronze (starter), Silver (cashback), Platinum (travel), Business', description: 'Available card products' },
];

// ─── Dynamic Contexts (per-value sections — the showpiece) ────────

function dcCase(value, sectionTexts, text) {
  return { value, ...(text ? { text } : {}), sectionTexts };
}

const DC_MOOD = {
  id: id.dc(),
  fieldId: F.mood.id,
  sections: [{ name: 'tone' }, { name: 'pacing' }, { name: 'do' }, { name: 'dont' }],
  fallback: 'Balanced, professional. Ask one question per turn. Keep it specific, no jargon.',
  cases: [
    dcCase('curious',      { tone: 'warm, exploratory',         pacing: 'unhurried',              do: 'ask open questions about lifestyle and travel patterns', dont: 'dump features all at once' }),
    dcCase('skeptical',    { tone: 'factual, calm',              pacing: 'short sentences',        do: 'cite numbers, name fees up front',                       dont: 'gush, oversell, use superlatives' }),
    dcCase('hurried',      { tone: 'crisp',                      pacing: '1–2 sentences per turn', do: 'lead with bottom-line value',                            dont: 'small talk, multi-paragraph replies' }),
    dcCase('stressed',     { tone: 'empathetic',                 pacing: 'pause, soften',          do: 'acknowledge feelings, offer to defer the conversation',  dont: 'hard sell, urgency, anchoring on a card' }),
    dcCase('enthusiastic', { tone: 'matched energy',             pacing: 'normal',                 do: 'ride momentum to the next concrete step',                dont: 'stall, over-qualify' }),
    dcCase('hostile',      { tone: 'respectful, brief',          pacing: 'minimal',                do: 'defuse, offer to disengage gracefully',                  dont: 'argue, justify, push back' }),
  ],
};

const DC_CREDIT_TIER = {
  id: id.dc(),
  fieldId: F.customer_credit_tier.id,
  sections: [{ name: 'pitch_focus' }, { name: 'card_recommendation' }, { name: 'compliance_notes' }],
  fallback: '',
  cases: [
    dcCase('starter', { pitch_focus: 'building credit history',          card_recommendation: 'Bronze; mention secured option as a path',     compliance_notes: 'mention this is a soft pull only — no harm to credit' }),
    dcCase('good',    { pitch_focus: 'smart everyday rewards',           card_recommendation: 'Silver; mention upgrade path to Platinum',     compliance_notes: 'mention APR transparency and the full fee schedule' }),
    dcCase('premium', { pitch_focus: 'travel / lifestyle value',         card_recommendation: 'Platinum; mention lounge access + travel insurance', compliance_notes: 'mention concierge and FX fees' }),
  ],
};

const DC_OBJECTION = {
  id: id.dc(),
  fieldId: F.objection_type.id,
  sections: [{ name: 'acknowledge' }, { name: 'reframe' }, { name: 'bridge' }],
  fallback: '',
  cases: [
    dcCase('fees',                  { acknowledge: '"Totally fair concern about fees."',                                                    reframe: '"Look at it per-month vs the cashback you\'d earn."',                              bridge: '"Want me to model your monthly spend?"' }),
    dcCase('interest',              { acknowledge: '"Smart to ask about APR."',                                                              reframe: '"If you pay in full it\'s effectively 0%."',                                         bridge: '"What\'s your usual repayment pattern?"' }),
    dcCase('credit_check',          { acknowledge: '"Good to clarify — at this stage it\'s just a soft pull."',                              reframe: '"Soft pull doesn\'t affect your score."',                                            bridge: '"Want me to share what pre-qualification shows?"' }),
    dcCase('loyalty_to_other_bank', { acknowledge: '"Makes sense to stay where you trust."',                                                  reframe: '"Many customers use ours alongside, not instead."',                                  bridge: '"Want to hear what\'s actually different?"' }),
    dcCase('not_interested',        { acknowledge: '"Totally fine — appreciate you saying so."',                                              reframe: '',                                                                                   bridge: '"Can I email a summary you can read later?"' }),
    dcCase('privacy',               { acknowledge: '"Privacy is the right thing to ask about."',                                              reframe: '"We minimise — only what\'s needed for the card decision."',                          bridge: '"Want me to walk through what we\'d store?"' }),
  ],
};

const DC_PRIORITY = {
  id: id.dc(),
  fieldId: F.customer_priority.id,
  sections: [{ name: 'feature_emphasis' }, { name: 'proof_point' }],
  fallback: '',
  cases: [
    dcCase('travel',       { feature_emphasis: 'lounges, no FX fees, travel insurance',          proof_point: '"Last quarter, average Platinum holder saved $340 in FX."' }),
    dcCase('cashback',     { feature_emphasis: 'tiered % by category, no minimum spend',         proof_point: '"Silver typically returns ~$420/year for $2k/month spend."' }),
    dcCase('low_fees',     { feature_emphasis: '$0 annual on Bronze, transparent statements',    proof_point: '"No hidden fees — the fee schedule is one page."' }),
    dcCase('build_credit', { feature_emphasis: 'secured path, monthly score view',               proof_point: '"85% of Bronze holders see score improvement in 6 months."' }),
  ],
};

const DYNAMIC_CONTEXTS = [DC_MOOD, DC_CREDIT_TIER, DC_OBJECTION, DC_PRIORITY];

// ─── Addon factories ──────────────────────────────────────────────

function makeAddon({ pluginId, name, model, historyN, prompt, extractsFields = null, domain = null, lane = 'main', outputType }) {
  const config = {
    prompt,
    model,
  };
  if (name !== undefined)              config.name = name;
  if (extractsFields !== null)         config.extractsFields = extractsFields;
  if (domain !== null)                  config.domain = domain;

  return {
    instanceId: id.addon(),
    pluginId,
    lane,
    enabled: true,
    config,
    context: { history: { mode: 'last_n', n: historyN } },
    outputType: outputType || (pluginId === 'talker' ? 'text-to-user' : 'json-to-memory'),
    promptTemplate: '{{prompt}}',
  };
}

// ─── Persona ───────────────────────────────────────────────────────

const PERSONA = `You are Cardly, the digital credit-card consultant for {{param:bankName}}.
Your job is to help the customer pick the right card — never push a worse fit
to close faster. You sound like a calm, knowledgeable banker on a quiet
afternoon: friendly, specific, no jargon, no hard sell.

Rules you never break:
- If the customer asks for the cost or rate, tell them plainly.
- Never invent a benefit. If unsure, say "let me check that."
- Respect a clear "no" the first time. {{param:complianceDisclaimer}}`;

// ─── Agent cortex (runs first, every turn) ────────────────────────

const AGENT_CORTEX = [
  // 1. Profile Extractor — explicit facts
  makeAddon({
    pluginId: 'field-extractor',
    name: 'Profile Extractor',
    model: { providerId: 'openai', modelId: 'gpt-4o-mini' },
    historyN: 3,
    extractsFields: [F.customer_name.id, F.is_existing_customer.id, F.existing_card_loyalty.id],
    prompt: `Extract profile facts the customer has stated or strongly implied in recent turns.

## Field schema
{{fields_schema}}

## Already collected
{{fields_current}}

Rules:
- customer_name: only when the user introduces themselves explicitly.
- is_existing_customer: true if they mention banking with us; false if they name another bank as their primary; otherwise omit.
- existing_card_loyalty: capture the competing bank or card if they name one.
- Omit any field you can't confidently fill. Return {} if nothing.`,
  }),
  // 2. Mood Reader — vibe extractor
  makeAddon({
    pluginId: 'vibe-extractor',
    name: 'Mood Reader',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    historyN: 8,
    extractsFields: [F.mood.id],
    prompt: `Read the customer's mood from how they write — word choice, pacing, hedging, urgency, sarcasm.

## Vibe schema
{{fields_schema}}

## Currently read
{{fields_current}}

Guidance:
- Trust patterns over single utterances. One short reply isn't "hurried"; consistent terseness is.
- Stay tentative when signals are mixed. Better to omit mood than to misread it.
- Update if the conversation shifts (hostile → curious is a real arc).`,
  }),
  // 3. Income Inferrer — field reasoner
  makeAddon({
    pluginId: 'field-reasoner',
    name: 'Income Inferrer',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    historyN: 10,
    extractsFields: [F.customer_income_band.id],
    prompt: `{{persona}}

You are inferring the value of \`{{this_field}}\`.

How to decide:
- Combine signals: any mentioned occupation, neighbourhood, lifestyle markers, large purchases or assets, mention of competing premium products.
- If @existing_card_loyalty is a premium card (Amex Platinum, Sapphire Reserve), lean higher.
- @is_existing_customer = true with no other signal → leave blank.

Allowed values: {{enum_values}}

OUTPUT RULES:
- Output JSON only — no preamble, no markdown fences.
- Shape: { "{{this_field}}": <value> }
- If you can't confidently infer, omit the key.`,
  }),
  // 4. Credit Tier Inferrer — field reasoner
  makeAddon({
    pluginId: 'field-reasoner',
    name: 'Credit Tier Inferrer',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    historyN: 10,
    extractsFields: [F.customer_credit_tier.id],
    prompt: `{{persona}}

You are inferring the value of \`{{this_field}}\`.

How to decide:
- If @customer_income_band is \`over_200k\` or @existing_card_loyalty signals a premium product → lean \`premium\`.
- If @customer_income_band is \`under_50k\` OR there's no signal of credit history → lean \`starter\`.
- Everything else stable → \`good\`.
- A mention of missed payments, debt, or late fees → never \`premium\`.

Allowed values: {{enum_values}}

OUTPUT RULES:
- Output JSON only.
- Shape: { "{{this_field}}": <value> }
- If you can't confidently infer, omit the key.`,
  }),
  // 5. Priority Inferrer — field reasoner
  makeAddon({
    pluginId: 'field-reasoner',
    name: 'Priority Inferrer',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    historyN: 8,
    extractsFields: [F.customer_priority.id],
    prompt: `{{persona}}

You are inferring the value of \`{{this_field}}\`.

How to decide:
- Travel mentions (flights, FX, hotels, "I travel for work") → \`travel\`.
- Fee sensitivity ("$95/yr is a lot", "cheapest one") → \`low_fees\` or \`cashback\`.
- Credit-building language (rebuild, score, history) → \`build_credit\`.
- Generic everyday rewards talk → \`cashback\`.
- Consider @mood — a stressed user is rarely chasing travel perks.

Allowed values: {{enum_values}}

OUTPUT RULES:
- Output JSON only.
- Shape: { "{{this_field}}": <value> }
- Omit the key when ambiguous.`,
  }),
];

// ─── Crew "Sales Floor" cortex ────────────────────────────────────

const CREW_ADDONS = [
  // 1. Objection Picker — field extractor
  makeAddon({
    pluginId: 'field-extractor',
    name: 'Objection Picker',
    model: { providerId: 'openai', modelId: 'gpt-4o-mini' },
    historyN: 4,
    extractsFields: [F.objection_type.id, F.pitch_stage.id],
    prompt: `Capture the specific concern (if any) the customer is raising AND where the conversation sits in the sales arc.

## Field schema
{{fields_schema}}

## Already collected
{{fields_current}}

Rules:
- objection_type: only set when the customer voices a concrete concern this turn. Otherwise omit.
- pitch_stage: pick the closest stage based on the last few turns; update as the arc moves.
- "Just looking" / "thanks, no" → pitch_stage=declined + objection_type=not_interested.

Return {} when neither moved.`,
  }),
  // 2. Card Matcher — the showpiece reasoner
  makeAddon({
    pluginId: 'field-reasoner',
    name: 'Card Matcher',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    historyN: 6,
    extractsFields: [F.recommended_card.id],
    prompt: `{{persona}}

You are inferring the value of \`{{this_field}}\`.

How to decide:
- If @customer_credit_tier = \`starter\` → \`bronze\`.
- If @customer_credit_tier = \`premium\` AND @customer_priority = \`travel\` → \`platinum\`.
- If @customer_credit_tier = \`good\` AND @customer_priority = \`cashback\` → \`silver\`.
- If @customer_credit_tier = \`good\` AND @customer_priority = \`travel\` → \`silver\` (Platinum overshoots unless income > 100k).
- If @customer_priority = \`build_credit\` → \`bronze\`.
- If @is_existing_customer = true AND spending suggests a business → \`business\`.
- Otherwise balanced default: \`silver\`.

Allowed values: {{enum_values}}

OUTPUT RULES:
- Output JSON only.
- Shape: { "{{this_field}}": <value> }
- Omit when prerequisites (tier + priority) aren't in memory yet.`,
  }),
  // 3. Sales Strategist — thinker
  makeAddon({
    pluginId: 'thinker',
    name: 'Sales Strategist',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    historyN: 8,
    domain: 'pitch',
    prompt: `{{persona}}

You are the strategist. The {{param:bankName}} customer profile:
{{memory:customer}}

Signals this turn:
{{memory:signal}}

Recommended card: {{field:recommended_card}}

Apply this mood guidance:
- Tone: {{dynamic:mood:tone}}
- Pacing: {{dynamic:mood:pacing}}
- Do: {{dynamic:mood:do}}
- Don't: {{dynamic:mood:dont}}

Apply this credit-tier framing:
{{dynamic:customer_credit_tier:pitch_focus}}
Compliance reminder: {{dynamic:customer_credit_tier:compliance_notes}}

If @objection_type is set, apply this handling:
{{dynamic:objection_type:*}}

Return JSON with these keys:
- main_plan: 1 sentence — the strategy for this turn.
- opening_line: 1 line — the first thing the rep should say.
- key_phrase_to_use: a specific phrase that lands the value.
- ask_next: optional follow-up question to keep momentum.
- hard_no_topics: list of things to NOT bring up this turn.

Output JSON only.`,
  }),
  // 4. Sales Rep — talker
  makeAddon({
    pluginId: 'talker',
    name: 'Sales Rep',
    model: { providerId: 'google', modelId: 'gemini-2.5-flash' },
    historyN: 6,
    prompt: `{{persona}}

Customer: {{field:customer_name}}  ·  {{param:bankName}} customer: {{field:is_existing_customer}}

Plan for this turn:
{{thinking:pitch}}

Tone for this turn (umbrella):
{{dynamic:mood}}

Feature emphasis for this customer:
{{dynamic:customer_priority:feature_emphasis}}
Proof point you can lean on: {{dynamic:customer_priority:proof_point}}

Hard rules:
- If @mood is \`hostile\` or \`stressed\`, do NOT mention any specific card unless the customer brings it up.
- If @objection_type = \`not_interested\`, your only job is to gracefully close.
- Anchor on {{field:recommended_card}} only when the strategist's plan calls for it.

Reply now. One reply only. Include {{param:complianceDisclaimer}} only when fees, APR, or rates are part of your reply.`,
  }),
];

// ─── Bodies ────────────────────────────────────────────────────────

const PROJECT_ID    = id.project();
const AGENT_ID      = id.agent();
const AGENT_VER_ID  = id.version();
const CREW_ID       = id.crew();
const CREW_VER_ID   = id.version();

const AGENT_BODY = {
  name:            'Cardly',
  slug:            AGENT_SLUG,
  spec:            'End-to-end demo: a single-crew banking sales agent that exercises every V2 builder feature. See docs/guides/BUILDER_V2_EXAMPLE_CARDLY.md for the test scenarios.',
  persona:         PERSONA,
  defaultCrewId:   CREW_ID,
  fields:          AGENT_FIELDS,
  domains:         ['customer', 'signal', 'pitch'],
  parameters:      PARAMS,
  dynamicContexts: DYNAMIC_CONTEXTS,
  cortex:          AGENT_CORTEX,
};

const CREW_BODY = {
  name:        'Sales Floor',
  description: 'The only crew — runs the full pitch / objection / close loop.',
  spec:        'Single crew, no transitions. Field Extractor → Card Matcher → Strategist → Talker. Reads everything the agent cortex produced this turn.',
  addons:      CREW_ADDONS,
  fields:      [], // all fields are agent-scoped for Cardly
};

// ─── Run ───────────────────────────────────────────────────────────

async function main() {
  await db.initialize();
  const d = db.getDrizzle();

  const existing = await d.select({ id: builderAgents.id, projectId: builderAgents.projectId })
    .from(builderAgents)
    .where(eq(builderAgents.slug, AGENT_SLUG))
    .limit(1);

  if (existing.length > 0) {
    if (!RESET) {
      console.log(`✓ Agent "${AGENT_SLUG}" already exists (agent=${existing[0].id}). Pass --reset to recreate.`);
      return;
    }
    console.log(`Removing existing "${AGENT_SLUG}" project before reseed…`);
    await projects.deleteProject({ projectId: existing[0].projectId });
  }

  console.log(`Creating Cardly demo agent (slug="${AGENT_SLUG}")…`);
  await projects.createProject({
    ownerUserId:    OWNER_USER_ID,
    projectId:      PROJECT_ID,
    projectName:    'Cardly',
    agentId:        AGENT_ID,
    agentSlug:      AGENT_SLUG,
    agentVersionId: AGENT_VER_ID,
    agentBody:      AGENT_BODY,
    crewId:         CREW_ID,
    crewVersionId:  CREW_VER_ID,
    crewBody:       CREW_BODY,
  });

  console.log('✓ Seeded.');
  console.log(`   project    ${PROJECT_ID}`);
  console.log(`   agent      ${AGENT_ID}  (slug=${AGENT_SLUG})`);
  console.log(`   crew       ${CREW_ID}  ("Sales Floor")`);
  console.log(`   parameters ${PARAMS.length}`);
  console.log(`   fields     ${AGENT_FIELDS.length}`);
  console.log(`   DCs        ${DYNAMIC_CONTEXTS.length}`);
  console.log(`   agent cortex addons  ${AGENT_CORTEX.length}`);
  console.log(`   crew addons          ${CREW_ADDONS.length}`);
  console.log('');
  console.log(`Open the builder at:  /${AGENT_SLUG}/builder`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('✗ Seed failed:', err);
    process.exit(1);
  });
