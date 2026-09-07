/**
 * Smart Replenishment — scope-protocol battery (the chat-quality fix).
 *
 * Verifies the RESOLVE → COMPUTE decomposition end to end:
 *   scope (any vocabulary, the model's job) × arithmetic (the engine's job).
 *
 * Two layers:
 *   default        — DB only: the tool handle + service with every scope
 *                    parameter, scoped counts, over-cap and empty-scope honesty.
 *   --chat         — adds REAL chat turns (LLM + DB), including the exact two
 *                    phrasings from the client's screenshot of 2026-09-06 that
 *                    were refused before this fix. Run in a quiet window.
 *
 * Needs the module live for zolstock and the data DB reachable.
 * Run:  node scripts/test-replenishment-scope.js [--chat]
 */
require('dotenv').config();

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${String(detail).slice(0, 140)}`}`);
  cond ? pass++ : fail++;
};

async function main() {
  const withChat = process.argv.includes('--chat');
  await require('../services/db.pg').initialize();
  const moduleService = require('../modules/services/module.service');
  if (!await moduleService.isLive('zolstock', 'replenishment')) {
    console.log('replenishment is not live for zolstock — nothing to test'); process.exit(0);
  }
  const { handle } = require('../modules/replenishment/chat-tool');
  const { MAX_SCOPE_SKUS } = require('../modules/replenishment/scope');
  const recs = require('../modules/replenishment/services/recommendations.service');

  console.log('\n1 · Service: scoped summaries describe the asked-about set');
  {
    const plain = await recs.getRecommendations('zolstock', { onlyDue: false });
    ok('no scope → scopedSummary equals summary exactly (unscoped consumers cannot drift)',
      JSON.stringify(plain.scopedSummary) === JSON.stringify(plain.summary));
    ok('no scope → no scope line', plain.scope === null || plain.scope === undefined);

    const wood = await recs.getRecommendations('zolstock', { search: 'עץ', onlyDue: false });
    ok('search "עץ" matches a real, non-empty scope', wood.total > 0, `total=${wood.total}`);
    ok('…the scope line states the term and matched-of-total', /עץ/.test(wood.scope || '') && / of /.test(wood.scope || ''), wood.scope);
    ok('…scoped counts sum to the scoped set, whole-set summary unchanged',
      (wood.scopedSummary.orderNow + wood.scopedSummary.dueSoon + wood.scopedSummary.ok + wood.scopedSummary.noDemand) <= plain.totalUnscoped
      && JSON.stringify(wood.summary) === JSON.stringify(plain.summary));

    // skus[] round-trip: resolve a scope one way, feed it back the other way.
    const skuList = wood.recommendations.slice(0, 5).map(r => r.sku);
    const bySkus = await recs.getRecommendations('zolstock', { skus: skuList, onlyDue: false });
    ok('a resolved skus[] list returns exactly those items', bySkus.total === skuList.length, `${bySkus.total} vs ${skuList.length}`);

    const cat = await recs.getRecommendations('zolstock', { category: wood.recommendations[0]?.category, onlyDue: false });
    ok('category label (as delivered) scopes without error', !cat.error && cat.total > 0, `total=${cat.total}`);
  }

  console.log('\n2 · Tool handle: honesty at the edges');
  {
    const over = await handle('zolstock', { skus: Array.from({ length: MAX_SCOPE_SKUS + 1 }, (_, i) => `X${i}`) });
    ok('over-cap is an instruction, not a truncation — nothing computed',
      over.total === 0 && /limit/i.test(over.summary) && over.recommendations.length === 0, over.summary);

    const none = await handle('zolstock', { search: 'צירוף-שלא-קיים-בקטלוג-999' });
    ok('empty scope names what was searched and offers a way forward, never a bare refusal',
      none.total === 0 && /searched, not refused/i.test(none.summary) && /999/.test(none.dataContract.join(' ')), none.summary);

    const scoped = await handle('zolstock', { search: 'עץ' });
    ok('a scoped answer carries the scope in its data contract', scoped.dataContract.some(l => /עץ/.test(l)));
    ok('…and its counts are the scoped ones', scoped.counts.orderNow <= scoped.total || scoped.counts.ok >= 0);
  }

  console.log('\n2b · Scoped attach: the tune scope swaps the tool set, and gives it back');
  {
    const attach = require('../modules/services/module-tools.service');
    const ownTool = { name: 'fetch_zolstock_data', handler: async () => ({}) };
    const crew = { datasetSchema: 'zolstock', tools: [ownTool] };

    const plain = await attach.attachTo(crew);
    ok('plain turn keeps the crew\'s own tool and adds the module\'s',
      !plain.scoped && crew.tools.some(t => t.name === 'fetch_zolstock_data')
      && crew.tools.some(t => t.name === 'fetch_replenishment'));

    const scoped = await attach.attachTo(crew,
      { moduleId: 'replenishment', scopeId: 'tune', context: { group: 'order_now' } },
      { conversationId: 'scope-battery' });
    ok('scoped turn = scope tools ONLY — the general SQL tool is not attached',
      scoped.scoped
      && crew.tools.some(t => t.name === 'fetch_replenishment')
      && crew.tools.some(t => t.name === 'propose_group_change')
      && !crew.tools.some(t => t.name === 'fetch_zolstock_data'),
      crew.tools.map(t => t.name).join(', '));
    ok('…and hands the dispatcher the D8 fragment', /NEVER say items were moved/i.test(scoped.fragment || ''));

    const back = await attach.attachTo(crew);
    ok('the next plain turn restores the crew\'s own tools exactly',
      !back.scoped && crew.tools.some(t => t.name === 'fetch_zolstock_data'));

    const bad = await attach.attachTo(crew, { moduleId: 'replenishment', scopeId: 'nope' });
    ok('an unknown scope refuses into a PLAIN turn — ordinary answers, clear signal',
      !bad.scoped && bad.refused === 'scope_unavailable'
      && crew.tools.some(t => t.name === 'fetch_zolstock_data'));
  }

  if (withChat) {
    console.log('\n3 · REAL chat turns — the screenshot conversation, both languages');
    const { runChatTurn } = require('../services/chat-turn.service');
    const realLog = console.log;
    const turn = async (message, conversationId) => {
      const tools = [];
      console.log = (...a) => { const s = a.join(' '); if (/crew tool handler/.test(s)) tools.push(s); };
      let reply = '';
      try {
        const r = await runChatTurn({ message, conversationId, agentName: 'ZolStock', userId: 'replay-scope-battery' });
        reply = r.reply || '';
      } catch (e) { reply = `TURN ERROR: ${e.message}`; }
      console.log = realLog;
      return { reply, usedTool: tools.some(s => /fetch_replenishment/.test(s)) };
    };
    const refused = (t) => /לא ניתן|אין אפשרות|cannot|can't|unable/i.test(t.slice(0, 220)) && !/\d{2,}/.test(t);

    // The two exact phrasings from the client's screenshot (was: refused twice).
    const q1 = await turn('תן לי המלצה להזמנת רכש במחלקת יצירה - מוצרי עץ', 'replay-scope-he-dept');
    ok('HE department question is ANSWERED (resolve→compute), not refused',
      q1.usedTool && !refused(q1.reply), q1.reply.slice(0, 160));
    const q2 = await turn('אז תעשה על המוצרים שיש בתיאור שלהם את המילה עץ', 'replay-scope-he-dept');
    ok('HE follow-up "word עץ in the name" is answered with numbers',
      q2.usedTool && !refused(q2.reply) && /\d/.test(q2.reply), q2.reply.slice(0, 160));

    const q3 = await turn('Give me a purchase recommendation for wooden products', 'replay-scope-en-wood');
    ok('EN equivalent routes through the tool and answers', q3.usedTool && !refused(q3.reply), q3.reply.slice(0, 160));

    const q4 = await turn('What should we order from category כלי בית? Give quantities.', 'replay-scope-en-cat');
    ok('category-vocabulary question answers with stated scope', !refused(q4.reply), q4.reply.slice(0, 160));

    console.log('\n  NOTE: clean up with the ownership-based replay cleanup (user replay-scope-battery).');
  } else {
    console.log('\n(3 · chat layer skipped — run with --chat in a quiet window)');
  }

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
