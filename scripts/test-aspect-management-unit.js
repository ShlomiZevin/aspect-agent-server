#!/usr/bin/env node
/**
 * Aspect Management — offline unit battery for the V0 alert rules. No DB, no LLM.
 *
 *   node scripts/test-aspect-management-unit.js
 */
const assert = require('assert');
const rules = require('../aspect-management/services/rules');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

// 2026-11-05 is a Thursday.
const THU = '2026-11-05';
const SUN = '2026-11-08';
const project = over => ({ id: 1, name: 'דשבורד', clientName: 'לקוח', hoursBudget: 100, hoursUsed: 10, dueDate: '2026-12-01', status: 'active', ...over });
const dev = over => ({ id: 2, name: 'דנה', createdDate: '2026-01-01', hoursOnPreviousWorkday: 0, ...over });
const quote = over => ({ id: 3, clientName: 'לקוח', subject: 'הצעה', status: 'sent', sentDate: '2026-11-01', lastFollowupDate: null, createdDate: '2026-10-01', ...over });
const alerts = over => rules.computeAlerts({ today: THU, projects: [], developers: [], quotes: [], blockers: [], ...over });
const kinds = list => list.map(a => a.kind);

check('today is the Israeli date, not the UTC one', () => {
  assert.strictEqual(rules.todayInIsrael(new Date('2026-11-04T23:30:00Z')), THU);
});

check('previous workday skips the Israeli weekend', () => {
  assert.strictEqual(rules.previousWorkday(THU), '2026-11-04');
  assert.strictEqual(rules.previousWorkday(SUN), THU);
  assert.strictEqual(rules.previousWorkday('2026-11-07'), THU);
  assert.strictEqual(rules.previousWorkday('2026-11-06'), THU);
});

check('a project past its due date is late, and only while active', () => {
  assert.deepStrictEqual(kinds(alerts({ projects: [project({ dueDate: '2026-11-03' })] })), ['late']);
  assert.deepStrictEqual(kinds(alerts({ projects: [project({ dueDate: '2026-11-03', status: 'done' })] })), []);
  assert.deepStrictEqual(kinds(alerts({ projects: [project({ dueDate: THU })] })), []);
});

check('budget: 89% nothing, 90% warning, 100% over', () => {
  assert.deepStrictEqual(kinds(alerts({ projects: [project({ hoursUsed: 89 })] })), []);
  assert.deepStrictEqual(kinds(alerts({ projects: [project({ hoursUsed: 90 })] })), ['near']);
  assert.deepStrictEqual(kinds(alerts({ projects: [project({ hoursUsed: 100 })] })), ['over']);
});

check('a project with no budget has no percent and no budget alert', () => {
  const state = rules.projectState(project({ hoursBudget: null, hoursUsed: 500 }), THU);
  assert.strictEqual(state.pct, null);
  assert.strictEqual(state.over, false);
  assert.strictEqual(state.near, false);
});

check('a developer with no entry on the previous workday is flagged', () => {
  assert.deepStrictEqual(kinds(alerts({ developers: [dev()] })), ['no_report']);
  assert.deepStrictEqual(kinds(alerts({ developers: [dev({ hoursOnPreviousWorkday: 4 })] })), []);
});

check('a developer added after that workday is not flagged', () => {
  assert.deepStrictEqual(kinds(alerts({ developers: [dev({ createdDate: THU })] })), []);
});

check('the no-report line says yesterday, or names the day after a weekend', () => {
  assert.strictEqual(alerts({ developers: [dev()] })[0].line, 'לא דיווח אתמול');
  assert.strictEqual(alerts({ today: SUN, developers: [dev()] })[0].line, 'לא דיווח ביום חמישי');
});

check('a quote flags at 7 days without follow-up, not at 6', () => {
  assert.deepStrictEqual(kinds(alerts({ quotes: [quote({ sentDate: '2026-10-29' })] })), ['no_followup']);
  assert.deepStrictEqual(kinds(alerts({ quotes: [quote({ sentDate: '2026-10-30' })] })), []);
});

check('a follow-up restarts the count', () => {
  assert.deepStrictEqual(kinds(alerts({ quotes: [quote({ sentDate: '2026-09-01', lastFollowupDate: '2026-11-04' })] })), []);
});

check('only sent and pending quotes can go without follow-up', () => {
  for (const status of ['preparing', 'won', 'lost']) {
    assert.deepStrictEqual(kinds(alerts({ quotes: [quote({ status, sentDate: '2026-01-01' })] })), []);
  }
  assert.deepStrictEqual(kinds(alerts({ quotes: [quote({ status: 'pending', sentDate: '2026-01-01' })] })), ['no_followup']);
});

check('a blocker shows from the previous workday on, and Sunday still sees Thursday', () => {
  const blocker = date => ({ personId: 2, personName: 'דנה', date, body: 'אין גישה' });
  assert.deepStrictEqual(kinds(alerts({ blockers: [blocker('2026-11-04')] })), ['blocker']);
  assert.deepStrictEqual(kinds(alerts({ blockers: [blocker('2026-11-03')] })), []);
  assert.deepStrictEqual(kinds(alerts({ today: SUN, blockers: [blocker(THU)] })), ['blocker']);
});

check('what needs action comes before what needs attention', () => {
  const list = alerts({ developers: [dev()], projects: [project({ dueDate: '2026-11-03' })] });
  assert.deepStrictEqual(kinds(list), ['late', 'no_report']);
});

check('day counts read as natural Hebrew', () => {
  const line = dueDate => alerts({ projects: [project({ dueDate })] })[0].line;
  assert.strictEqual(line('2026-11-04'), 'פרויקט באיחור של יום אחד');
  assert.strictEqual(line('2026-11-03'), 'פרויקט באיחור של יומיים');
  assert.strictEqual(line('2026-10-31'), 'פרויקט באיחור של 5 ימים');
});

console.log(process.exitCode ? 'FAILED' : `OK — ${passed} checks passed`);
