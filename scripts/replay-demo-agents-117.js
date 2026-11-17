// Usage: node scripts/replay-demo-agents-117.js <label> [scenarioIdx,...]  (needs the Cloud SQL proxy; writes verification/demo-agents-117/replay-<label>.json)
// Task #117: replay Itzik-style turns through the REAL chat path (runChatTurn), in-process.
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config({ path: '.env' });
const { runChatTurn } = require('../services/chat-turn.service');
const fs = require('fs');
const label = process.argv[2] || 'run';
const scenarios = [
  { agent: 'Aspect', crew: 'technology', turns: ['איזה מוצר נמכר הכי הרבה?', 'תן לי בטבלה', 'תוסיף לי אחוז המכר', 'כן'] },
  { agent: 'Aspect', crew: 'technology', turns: ['תבנה טבלה עם עשרת המוצרים הנמכרים ביותר תוסיף עמודה של sell-through וכמות במלאי'] },
  { agent: 'Aspect', crew: 'technology', turns: ['אילו מוצרים כדאי להעביר בין סניפים?', 'תסדר את זה בטבלת ההעברות'] },
  { agent: 'Aspect', crew: 'technology', turns: ['תן לי דוח רווח והפסד לחודש האחרון'] },
  { agent: 'Aspect', crew: 'technology', turns: ['Which products sell the most? Give me a table.'] },
  { agent: 'Aspect', crew: 'fmcg', turns: ['טופ 10 מוצרים נמכרים החודש'] },
  { agent: 'Aspect', crew: 'fashion', turns: ['Top 10 best-selling items this month'] },
  { agent: 'Aspect', crew: 'fashion', fileprompt: true, turns: ['Top 10 best-selling items this month', 'תן לי טבלה של 10 הפריטים הנמכרים ביותר עם מלאי'] },
  { agent: 'ZolStock', crew: null, turns: ['What are the top 10 best-selling items this year by quantity?'] },
];
const only = process.argv[3] ? process.argv[3].split(',').map(Number) : null;
(async () => {
  await require('../services/db.pg').initialize();
  await require('../services/provider-config.service').initialize();
  const out = [];
  for (const [i, sc] of scenarios.entries()) {
    if (only && !only.includes(i)) continue;
    const conversationId = 'test117-' + label + '-' + i + '-' + Date.now();
    for (const message of sc.turns) {
      const t = Date.now();
      let r, err = null;
      try {
        r = await runChatTurn({ agentName: sc.agent, message, conversationId, userId: 'anon_test_117', overrideCrewMember: sc.crew || undefined, promptOverrides: sc.fileprompt ? { fashion: new (require('../agents/aspect/crew/fashion.crew.js'))().guidance } : undefined });
      } catch (e) { err = e.message; }
      const secs = (Date.now() - t) / 1000;
      const reply = r?.reply || '';
      const row = {
        scenario: i, crew: sc.crew || sc.agent, message, secs, modelUsed: r?.modelUsed, err,
        hasTable: /\n\s*\|.*\|\s*\n\s*\|\s*:?-{3,}/.test(reply),
        endsWithQuestion: /\?\s*\**\s*$/.test(reply.trim()),
        tools: (r?.toolResults || []).map(x => x.name || x.toolName || x.tool || '?'),
        saysBelow: /מוצג(ת)? (כעת )?(למטה|מתחת)|מצורפת|below the reply|shown below/.test(reply),
        reply,
      };
      out.push(row);
      console.log(`[${i}] ${secs.toFixed(1)}s table=${row.hasTable} q?=${row.endsWithQuestion} below=${row.saysBelow} tools=${row.tools.join(',')} model=${row.modelUsed} ${err ? 'ERR ' + err : ''} | ${message}\n     ...${reply.trim().slice(-160).replace(/\s+/g, ' ')}`);
    }
  }
  fs.writeFileSync('verification/demo-agents-117/replay-' + label + '.json', JSON.stringify(out, null, 1));
  process.exit(0);
})();
