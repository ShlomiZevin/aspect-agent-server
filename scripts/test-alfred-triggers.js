/**
 * test-alfred-triggers.js — does Alfred actually know about Triggers?
 * (Builder V2 Triggers, phase T5.)
 *
 * See docs/guides/ALFRED_UPDATE_PROTOCOL.md. Every item on that
 * checklist exists because a feature once shipped without it, and the
 * failure mode is always the same and always silent: Alfred generates a
 * change that looks right, the merge quietly drops it, and the user is
 * told it worked.
 *
 * So this battery asserts the wiring rather than the behaviour. No LLM
 * calls, no database, instant.
 *
 * Usage:  node scripts/test-alfred-triggers.js
 * Writes: verification/alfred-triggers/results.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const patchGenerator = require('../alfred/services/patchGenerator');
const alfredContext = require('../alfred/services/alfredContext');
const bodyValidator = require('../alfred/services/bodyValidator');

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const base = {
  name: 'A', slug: 'a', spec: '', persona: '',
  fields: [], domains: [], parameters: [], enums: [],
  cortex: [], snippets: [], personas: [],
};

function withTriggers(triggers) {
  return { ...base, triggers };
}

function main() {
  console.log('\nAlfred × Triggers wiring battery\n');

  const { SYSTEM_PROMPT, TRIGGER_TEMPLATES, AGENT_SECTION_KEYS } = patchGenerator.__promptSections;

  console.log('[1] the merge whitelist — the silent-vanish check');
  check('`triggers` is in AGENT_SECTION_KEYS',
    AGENT_SECTION_KEYS.includes('triggers'),
    'without this the merge drops the key and Alfred\'s change disappears between "generated OK" and the working copy');

  console.log('\n[2] the patch generator knows the shape');
  check('trigger templates are rendered', TRIGGER_TEMPLATES.length > 0, `${TRIGGER_TEMPLATES.length} chars`);
  check('they reach the actual SYSTEM_PROMPT', SYSTEM_PROMPT.includes(TRIGGER_TEMPLATES));
  check('the silence type has a template', /### silence/.test(TRIGGER_TEMPLATES));
  check('it is told a trigger is NOT an addon', /NOT addons/.test(TRIGGER_TEMPLATES),
    'the one wrong thing it could do is emit one as an AddonInstance');
  check('activeSince is demanded', /`activeSince` is REQUIRED/.test(TRIGGER_TEMPLATES),
    'omitting it would let a new trigger nudge every dead conversation at once');
  check('anything it creates starts disabled', /`enabled: false` on anything you create/.test(TRIGGER_TEMPLATES),
    'arming something that messages real customers is the human\'s call');
  check('the types file it embeds documents AgentTrigger',
    SYSTEM_PROMPT.includes('AgentTrigger'),
    'the doc-comments in builder/types/index.ts ARE its knowledge');

  console.log('\n[3] brainstorm Alfred can advise about it');
  const advise = alfredContext.SYSTEM_PROMPT;
  check('there is a Triggers section', /# Triggers \(proactive/.test(advise));
  check('it states the decision rule vs an addon', /A TRIGGER IS NOT AN ADDON/.test(advise));
  check('it warns to point at a crew allowed to stay silent',
    /ALLOWED TO SAY NOTHING/.test(advise),
    'the commonest way to build this badly');
  check('it explains why a trigger has not fired', /three switches/.test(advise));

  console.log('\n[4] the validator catches the shapes that would misbehave');
  const now = new Date().toISOString();
  const good = withTriggers({ triggers: [{
    id: 't1', name: 'Re-engage', typeId: 'silence', enabled: true, activeSince: now,
    config: { after: { value: 30, unit: 'minutes' }, maxAttempts: 3 },
    run: { crewId: 'crew_1', brief: '' },
  }] });
  check('a well-formed trigger validates', bodyValidator.validateAgentBody(good).ok === true,
    JSON.stringify(bodyValidator.validateAgentBody(good).errors || []));

  const cases = [
    ['no activeSince', { id: 't', name: 'n', typeId: 'silence', enabled: true, config: {}, run: { crewId: 'c' } }, /activeSince/],
    ['no crew',        { id: 't', name: 'n', typeId: 'silence', enabled: true, activeSince: now, config: {}, run: {} }, /run\.crewId/],
    ['no typeId',      { id: 't', name: 'n', enabled: true, activeSince: now, config: {}, run: { crewId: 'c' } }, /typeId/],
    ['bad quiet hours',{ id: 't', name: 'n', typeId: 'silence', enabled: true, activeSince: now, config: {}, run: { crewId: 'c' }, quietHours: { from: '10pm', to: '8am' } }, /quietHours/],
  ];
  for (const [label, trig, expect] of cases) {
    const r = bodyValidator.validateAgentBody(withTriggers({ triggers: [trig] }));
    const caught = !r.ok && r.errors.some(e => expect.test(e));
    check(`rejects: ${label}`, caught, caught ? r.errors.find(e => expect.test(e)) : JSON.stringify(r));
  }

  const dupes = withTriggers({ triggers: [
    { id: 'same', name: 'a', typeId: 'silence', enabled: true, activeSince: now, config: {}, run: { crewId: 'c' } },
    { id: 'same', name: 'b', typeId: 'silence', enabled: true, activeSince: now, config: {}, run: { crewId: 'c' } },
  ] });
  const dupeRes = bodyValidator.validateAgentBody(dupes);
  check('rejects: duplicate trigger ids', !dupeRes.ok && dupeRes.errors.some(e => /duplicate/.test(e)),
    dupeRes.errors?.find(e => /duplicate/.test(e)) || 'not caught');

  console.log('\n[5] absent stays absent');
  check('an agent with no triggers key still validates',
    bodyValidator.validateAgentBody(base).ok === true,
    'every agent that predates this feature must be unaffected');

  const outDir = path.join(__dirname, '..', 'verification', 'alfred-triggers');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
    ranAt: new Date().toISOString(),
    passed: results.length - failures,
    failed: failures,
    checks: results,
  }, null, 2));

  console.log(`\n════════ ${results.length - failures}/${results.length} PASS ════════`);
  console.log('Written to verification/alfred-triggers/results.json');
  process.exit(failures === 0 ? 0 : 1);
}

main();
