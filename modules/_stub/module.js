/**
 * `_stub` — a dev-only module that exists purely to exercise the framework.
 *
 * Registered ONLY when NODE_ENV !== 'production' (see ../registry.js), so it
 * never appears in a client-facing admin panel.
 *
 * Why it exists: the init orchestrator (audit -> propose -> render -> build ->
 * verify, up to 5 rounds) is the most intricate part of the framework, and
 * every real module's version of those hooks costs an LLM call and a live
 * database. This stub implements the same contract with neither — fixed
 * audit, fixed binding, EMPTY DDL (so the build step executes zero statements
 * and touches no DB), and synthetic probes. That makes the orchestrator,
 * the round loop, the failure report and the progress stages testable
 * offline and deterministically.
 *
 * Two settings drive its behaviour in tests:
 *   failingProbes   — how many rounds must fail before the probes go green.
 *                     0 = pass on round 1. 99 = never passes, so the run
 *                     exhausts its round cap and lands in `failed`, which is
 *                     the path A3 has to prove works.
 *   simulatedDelayMs— per-stage sleep, so a test can observe intermediate
 *                     progress stages rather than a run that finishes before
 *                     the first poll.
 */

module.exports = {
  id: '_stub',
  name: { en: 'Framework Stub (dev only)', he: 'מודול בדיקה (פיתוח בלבד)' },
  version: 1,

  settingsSchema: [
    {
      key: 'failingProbes',
      type: 'number',
      required: false,
      default: 0,
      label: { en: 'Rounds that should fail', he: 'סבבים שייכשלו' },
      hint: {
        en: 'How many verification rounds fail before passing. 99 = always fail.',
        he: 'כמה סבבי אימות ייכשלו לפני הצלחה. 99 = תמיד נכשל.',
      },
    },
    {
      key: 'simulatedDelayMs',
      type: 'number',
      required: false,
      default: 0,
      label: { en: 'Simulated delay per stage (ms)', he: 'השהיה מדומה לכל שלב (מ״ש)' },
      hint: {
        en: 'Sleep between pipeline stages so progress polling has something to observe.',
        he: 'המתנה בין שלבים כדי שניתן יהיה לעקוב אחר ההתקדמות.',
      },
    },
  ],

  notificationEvents: ['init_completed', 'init_failed', 'nightly_build_failed', 'verification_degraded'],

  hooks: {
    async audit(ctx) {
      await sleep(ctx.settings?.simulatedDelayMs);
      return {
        measurementGroups: 3,
        note: 'stub audit — no database was read',
        tables: { fake_facts: { rows: 1000 }, fake_items: { rows: 50 } },
      };
    },

    async proposeBinding(ctx) {
      await sleep(ctx.settings?.simulatedDelayMs);
      // A real module calls an LLM here (via services/llm.js, temperature 0,
      // with a context key). The stub returns a fixed binding so the
      // orchestrator can be tested with no provider and no network. `round`
      // and `previousFailures` are echoed back so a test can assert the
      // feedback loop actually carries failures forward.
      return {
        itemKey: 'fake_id',
        round: ctx.round,
        revisedAfter: (ctx.previousFailures || []).map(f => f.probe),
      };
    },

    // Empty DDL on purpose: zero statements to execute means the build step
    // creates no scratch schema and touches no database, which is what makes
    // the whole lifecycle runnable offline.
    renderInfra() {
      return [];
    },

    async verify(ctx) {
      await sleep(ctx.settings?.simulatedDelayMs);
      const failing = Number(ctx.settings?.failingProbes ?? 0);
      const shouldFail = ctx.round <= failing;

      const probes = [
        { probe: 'relations_exist', passed: true, detail: 'stub: 2/2 relations present' },
        { probe: 'row_counts_reconcile', passed: true, detail: 'stub: counts match audit' },
        {
          probe: 'join_rate',
          passed: !shouldFail,
          detail: shouldFail
            ? `stub: 61.9% < 95% threshold (round ${ctx.round} of ${failing} configured to fail)`
            : 'stub: 99.9% >= 95% threshold',
        },
      ];

      return { passed: probes.every(p => p.passed), probes };
    },

    async nightlyBuild() {
      return { built: [], note: 'stub nightly build — nothing to build' };
    },

    // Off by design: the stub must never influence a real chat or the
    // SQL-generation prompt, even if someone enables it in dev.
    chatTools() { return []; },
    manifestFragment() { return null; },
  },
};

function sleep(ms) {
  return ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}
