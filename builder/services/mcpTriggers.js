/**
 * mcpTriggers — what the Builder MCP (`/builder/mcp`) says about
 * TRIGGERS: the composed page every type is described on, and the
 * read-only views of one agent's triggers (heartbeat, next fire, events,
 * who is due, why a conversation did or didn't get one).
 *
 * See docs/guides/BUILDER_V2_TRIGGERS.md and BUILDER_MCP_MAINTENANCE.md.
 *
 * Every view is READ ONLY. "Who's due" calls `findDue` directly — not
 * the sweep's dry run, which also writes the trigger's heartbeat row —
 * so an outside assistant looking can never change what the card shows.
 *
 * The type list is read from the registry, so a new trigger type reaches
 * this door the moment its `*.trigger.json` + server half are registered;
 * the only per-type code here is the one-line summary of a config.
 */

const triggerRegistry = require('../triggers');
const triggerEvaluator = require('../runtime/triggerEvaluator');
const triggerEventsStore = require('../runtime/triggerEventsStore');
const { resolveLegacyAgentId } = require('../runtime/triggerDispatcher');
const { resolveAgentBody } = require('./builderProjects');
const scheduleSlots = require('../triggers/schedule/scheduleSlots');

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sun–Thu" / "every day" / "Sun, Tue, Thu" — the Builder card's words. */
function daysLabel(days) {
  const set = Array.from(new Set(days)).sort((a, b) => a - b);
  if (set.length === 7) return 'every day';
  if (set.length === 0) return 'no days';
  const contiguous = set.every((d, i) => i === 0 || d === set[i - 1] + 1);
  if (contiguous && set.length >= 3) return `${DAY[set[0]]}–${DAY[set[set.length - 1]]}`;
  return set.map(d => DAY[d]).join(', ');
}

/** One line per config, in the screen's words. */
function summarize(trigger) {
  const c = trigger?.config || {};
  if (trigger?.typeId === 'silence') {
    const v = c.after?.value ?? 30;
    const u = c.after?.unit ?? 'minutes';
    return `after ${v} ${u} of quiet · up to ${c.maxAttempts ?? 3} attempts`;
  }
  if (trigger?.typeId === 'schedule') {
    const s = scheduleSlots.normalizeSchedule(c);
    if (s.problems.length) return `schedule not set (${s.problems.join('; ')})`;
    if (s.repeat === 'once') return `once on ${c.onceAt.replace('T', ' ')} (${s.timezone})`;
    const range = [c.startDate && `from ${c.startDate}`, c.endDate && `until ${c.endDate}`].filter(Boolean).join(' ');
    return `${daysLabel(s.days)} at ${s.times.join(', ')} (${s.timezone})${range ? ` · ${range}` : ''}`;
  }
  return JSON.stringify(c);
}

function iso(d) {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
}

/** The composed page: how triggers live in a body, then every type. */
function triggersPage({ base }) {
  const types = triggerRegistry.listTriggerTypes();
  const out = [
    '# Triggers — the agent acting with no customer message',
    '',
    'A trigger watches an agent\'s conversations and, when one matches, runs ONE crew\'s chain on it — the crew may',
    'speak (the customer gets a message) or stay silent. Triggers are NOT addons: never put one on a crew or on',
    '`agent.cortex`. They live only in the agent body, at `triggers.triggers[]`:',
    '',
    '```json',
    '"triggers": {',
    '  "enabled": true,                  // optional master switch, absent = on',
    '  "triggers": [{',
    '    "id": "trg_ab12cd34",           // make one up: "trg_" + 8 lowercase letters/digits',
    '    "name": "Morning check-in",',
    '    "typeId": "schedule",           // a type below',
    '    "enabled": false,               // new triggers start OFF — the person switches it on in the Builder',
    '    "activeSince": "<ISO now>",     // stamped when switched on; set it to now when you create one',
    '    "config": { ... },              // the type\'s own settings — see each type below',
    '    "quietHours": { "from": "22:00", "to": "08:00", "timezone": "Asia/Jerusalem" },   // optional',
    '    "limits": { "perConversation": { "max": 3, "days": 7 } },                        // optional',
    '    "filter": { "mode": "include", "conditions": [ ... ] },                          // optional, same as an addon filter, no cap',
    '    "run": { "crewId": "<a real crew id>", "brief": "optional instruction for the crew" }',
    '  }]',
    '}',
    '```',
    '',
    'The envelope (every type gets it unchanged):',
    '- **quietHours** — inside the window nothing is sent. Silence just tries again later; a Schedule slot inside it is SKIPPED.',
    '- **limits.perConversation** — at most `max` DELIVERED messages per `days` (rolling) to one conversation. Does not reset on reply.',
    '- **filter** — memory conditions checked per conversation before the crew runs (`conditionMatcher`, the addon Filter shape).',
    '- **run.brief** — fills the message slot for that turn; never written to the transcript.',
    '',
    'Nothing fires until three things are on: the trigger (`enabled`), the agent\'s master switch, and the system clock',
    '(Builder → Triggers → the clock bar). Creating or editing a trigger through this door never switches it on — leave',
    '`enabled: false` on a new one and tell the person to switch it on in the Builder when ready.',
    '',
    'Watching what they do (read only):',
    `- ${base}/agents/<slug>/triggers — each trigger, its settings in words, next fire, last check, recent events`,
    `- ${base}/agents/<slug>/triggers/<triggerId>/due — who it would act on right now, and what blocks the rest (sends nothing)`,
    `- ${base}/agents/<slug>/triggers/<triggerId>/explain?conversationId=<id>&at=<ISO time> — why it did or didn't fire for`,
    '  that conversation at that moment, clause by clause (evaluated with the trigger\'s CURRENT settings)',
    '',
    `## The trigger types (${types.length})`,
  ];
  for (const t of types) {
    const d = t.descriptor || {};
    out.push('', `### ${d.icon || ''} ${d.displayName || t.typeId} — \`typeId: "${t.typeId}"\``.replace('###  ', '### '), '',
      d.purpose || '', '');
    if (Array.isArray(d.configReference) && d.configReference.length) {
      out.push('`config` keys:', '```', ...d.configReference, '```', '');
    }
    out.push('Default config:', '```json', JSON.stringify(d.defaultConfig || {}, null, 2), '```');
    if (d.guide?.alsoDoes?.length) out.push('', 'Also true, never configured:', ...d.guide.alsoDoes.map(x => `- ${x}`));
  }
  return out.join('\n');
}

/** Saved triggers of one agent (the version the Builder opens). */
async function agentTriggers(slug) {
  const agent = await resolveAgentBody({ agentSlug: slug, mode: 'viewing' });
  const def = agent.body?.triggers;
  return { agent, def, list: Array.isArray(def?.triggers) ? def.triggers : [] };
}

async function agentTriggersText(slug) {
  const { agent, def, list } = await agentTriggers(slug);
  if (list.length === 0) return `${slug} has no triggers. The page ../../triggers explains how to add one.`;
  const status = await triggerEventsStore.statusForAgent(agent.agentId);
  const now = new Date();
  const lines = [
    `# Triggers on ${slug}`,
    def?.enabled === false ? '\n**The agent\'s master switch is OFF — none of these runs.**' : '',
  ];
  for (const t of list) {
    const st = status[t.id];
    const next = triggerEvaluator.nextFireOf(t, now);
    const events = await triggerEventsStore.recentForTrigger(t.id, 10);
    lines.push('',
      `## ${t.name || t.id} — ${t.typeId} · ${t.enabled ? 'ON' : 'off'} · id \`${t.id}\``,
      `- Settings: ${summarize(t)}`,
      `- Runs crew \`${t.run?.crewId || '(none picked)'}\`${t.run?.brief ? ` with brief: "${t.run.brief}"` : ''}`,
      t.quietHours ? `- Quiet hours ${t.quietHours.from}–${t.quietHours.to} ${t.quietHours.timezone}` : '- No quiet hours',
      t.limits?.perConversation ? `- At most ${t.limits.perConversation.max} messages per ${t.limits.perConversation.days} days per conversation` : '- No message limit',
      t.filter?.conditions?.length ? `- Filter (${t.filter.mode || 'include'}): ${JSON.stringify(t.filter.conditions)}` : '- No filter',
    );
    if (next) {
      lines.push(`- Next fire: ${next.at ? iso(next.at) : 'none — nothing left on the schedule'}` +
        (next.skippedForQuietHours ? ` (skipping ${next.skippedForQuietHours} time(s) inside quiet hours)` : ''));
    }
    lines.push(st
      ? `- Last checked ${iso(st.lastEvaluatedAt)}: ${st.lastResult === 'matched' ? `${st.lastMatched} matched` : (st.lastReason || st.lastResult)}`
      : '- Never checked yet');
    if (events.length) {
      lines.push('- Recent events (newest first):');
      for (const e of events) {
        lines.push(`  - ${iso(e.matchedAt)} · conversation ${e.conversationId} · ${e.outcome || e.status}` +
          `${e.source === 'manual' ? ' · by hand' : ''} · ${e.matchReason || ''}${e.error ? ` · error: ${e.error}` : ''}`);
      }
    } else {
      lines.push('- No events yet');
    }
  }
  return lines.join('\n');
}

function findTrigger(list, triggerId, slug) {
  const t = list.find(x => x.id === triggerId);
  if (!t) {
    const ids = list.map(x => `${x.id} (${x.name || x.typeId})`).join(', ') || 'none';
    const err = new Error(`No trigger "${triggerId}" on ${slug}. Its triggers: ${ids}.`);
    err.status = 404;
    throw err;
  }
  return t;
}

/** Who's due right now — read only, nothing is opened or sent. */
async function dueText(slug, triggerId) {
  const { list } = await agentTriggers(slug);
  const trigger = findTrigger(list, triggerId, slug);
  const legacyAgentId = await resolveLegacyAgentId(slug);
  if (!legacyAgentId) return `${slug} has no conversations yet.`;
  const { due, blocked, considered } = await triggerEvaluator.findDue({ legacyAgentId, trigger, limit: 200 });
  const lines = [
    `# Who "${trigger.name || trigger.id}" would act on right now`,
    `Read only — nothing was sent. Settings: ${summarize(trigger)}.`,
    trigger.enabled ? '' : '(This trigger is switched OFF, so the clock will not actually run it.)',
    `${considered} conversation(s) passed the cheap query; ${due.length} pass every clause.`,
  ];
  for (const d of due.slice(0, 50)) lines.push(`- conversation ${d.facts.conversationId} — ${d.evaluation.reason}`);
  if (due.length > 50) lines.push(`- … and ${due.length - 50} more`);
  const b = Object.entries(blocked);
  if (b.length) lines.push('', 'Blocked by:', ...b.map(([name, n]) => `- ${name}: ${n}`));
  lines.push('', 'Quiet hours and the Filter are checked after this, when the trigger actually fires.');
  return lines.filter(x => x !== '').join('\n');
}

/** Why it did or didn't fire for one conversation at one moment. */
async function explainText(slug, triggerId, conversationId, at) {
  const { list } = await agentTriggers(slug);
  const trigger = findTrigger(list, triggerId, slug);
  const when = at ? new Date(at) : new Date();
  if (!Number.isFinite(when.getTime())) {
    const err = new Error(`"${at}" is not a time — send an ISO time, e.g. 2026-11-09T07:10:00Z.`);
    err.status = 400;
    throw err;
  }
  const r = await triggerEvaluator.explainAt({ trigger, conversationId, at: when });
  const quiet = triggerEvaluator.checkQuietHours(trigger.quietHours, when);
  return [
    `# ${trigger.name || trigger.id} · conversation ${conversationId} · ${iso(when)}`,
    ...r.evaluation.clauses.map(c => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.why}`),
    `${quiet.suppressed ? '✗' : '✓'} quiet hours — ${quiet.why}`,
    r.evaluation.ok
      ? (quiet.suppressed ? '→ matched, but held by quiet hours (recorded as quiet_hours, nothing sent)' : '→ would have fired (then the Filter, if any, decides)')
      : '→ did not fire',
    '',
    r.configCaveat,
  ].join('\n');
}

module.exports = { triggersPage, agentTriggersText, dueText, explainText, summarize };
