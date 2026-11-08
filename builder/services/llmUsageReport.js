/**
 * Admin → LLM Usage (task #953): every model call an agent made, one row
 * each, with the add-on that made it and the interaction it belongs to.
 *
 * Two sources, joined here:
 *   - `llm_usage` — one row per model call (llm.js → logUsage): the exact
 *     model id, input/output tokens, duration, crew name, conversation.
 *     It is the base: it has every call and the real token counts.
 *     What it lacks is WHICH add-on made the call — only the add-on type
 *     (`process`), so two Thinkers in one crew look the same.
 *   - `addon_runs` — one row per add-on run: the instance id (→ the
 *     add-on's name in the agent's config) and the assistant message it
 *     belongs to (→ the interaction number). Its own token counts are 0
 *     for most add-on types, so they are not used.
 *
 * A call is matched to the run of the same type in the same conversation
 * that ended when the call ended (the call is logged the moment the model
 * answers, and the run closes right after) with the same duration; a run
 * that made several calls gets the ones that fall inside its time window.
 * Calls with no run (Live Brain panels, Profiler asks) keep their type as
 * the add-on name; calls with no conversation are "Unlinked calls".
 *
 * Interaction n = the conversation's n-th assistant message (the
 * assistant message row is written when the turn starts, so a call
 * belongs to the latest one written before the call began). A
 * conversation with no assistant message at all is counted by its user
 * messages.
 *
 * Cost = models.service costOf at list price; null for a model with no
 * known price (shown as "—" and left out of the totals).
 *
 * Agent: rows are found by the agent's display name (what the runtime
 * logs) or its slug — same as the MCP's /agents/<slug>/usage.
 */

const fs = require('fs');
const path = require('path');
const db = require('../../services/db.pg');
const models = require('../../services/models.service');
const builderProjects = require('./builderProjects');

const TZ = process.env.ALFRED_TIMEZONE || 'Asia/Jerusalem';
const MAX_CALLS = 20000;          // newest first; older calls are left out (flagged)
const CACHE_MS = 30 * 1000;       // filter changes reuse the joined period
const MATCH_END_MS = 1500;        // call logged ≈ when its run ended
const MATCH_DURATION_MS = 1500;

// ─── Add-on type names (as the Builder shows them) ────────────────────
const TYPE_NAMES = (() => {
  const out = {};
  try {
    const dir = path.join(__dirname, '..', 'addons');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.addon.json')) continue;
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d.pluginId && d.displayName) out[d.pluginId] = d.displayName;
    }
  } catch { /* fall back to the id */ }
  return out;
})();
const PREFIX_TYPES = { LB: 'Live Brain', PF: 'Profiler' };
const OTHER_TYPES = { mcp_simulated_user: 'Simulated user', profiler: 'Profiler', live_brain: 'Live Brain' };

function humanize(id) {
  const s = String(id || '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Other';
}

/** Type + name for a call that no add-on run explains, from its `process`. */
function describeProcess(proc) {
  const p = String(proc || '');
  const m = p.match(/^([A-Z]{2,4})\s*·\s*(.+)$/);           // 'LB · Panel title'
  if (m) return { type: PREFIX_TYPES[m[1]] || m[1], name: m[2].trim() };
  const type = TYPE_NAMES[p] || OTHER_TYPES[p] || humanize(p);
  return { type, name: type };
}

// ─── Period ───────────────────────────────────────────────────────────
const PERIODS = new Set(['today', '7d', '30d', '90d', 'all']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizePeriod(p) {
  const s = String(p || '').trim();
  return PERIODS.has(s) || DAY_RE.test(s) ? s : '30d';
}

/** SQL condition on llm_usage `u.created_at` (naive UTC) for a period. */
function periodSql(period, params) {
  if (period === 'all') return 'true';
  // The time-zone parameter is pushed only by the branches that use it —
  // an unused $n makes Postgres refuse the query.
  const local = () => `(u.created_at at time zone 'UTC' at time zone $${params.push(TZ)})::date`;
  if (period === 'today') { const l = local(); return `${l} = (now() at time zone $${params.length})::date`; }
  if (DAY_RE.test(period)) { const l = local(); return `${l} = $${params.push(period)}::date`; }
  const days = Number(period.replace('d', '')) || 30;
  return `u.created_at > (now() at time zone 'UTC') - make_interval(days => $${params.push(days)})`;
}

// ─── The agent's add-on instances, current config first ───────────────
function instanceMap(agent) {
  const map = new Map();
  const add = (list, crew) => {
    for (const a of Array.isArray(list) ? list : []) {
      if (!a || !a.instanceId || map.has(a.instanceId)) continue;
      map.set(a.instanceId, {
        name: String(a.config?.name || '').trim(),
        pluginId: a.pluginId,
        crew: crew ? String(crew).trim() || null : null,
        model: a.config?.model || null,
      });
    }
  };
  // Current working copy first, so a renamed add-on shows its name today.
  add(agent.cortex, null);
  for (const c of agent.crews || []) add(c.addons, c.name || null);
  // Then every older version — add-ons since removed still get a name.
  for (const v of agent.versions || []) add(v.body?.cortex, null);
  for (const c of agent.crews || []) {
    for (const v of c.versions || []) add(v.body?.addons, v.body?.name || c.name || null);
  }
  return map;
}

// ─── Load + join one period (cached briefly) ──────────────────────────
const cache = new Map();

async function loadPeriod(agentSlug, period) {
  const key = `${agentSlug}|${period}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await buildPeriod(agentSlug, period);
  if (data) {
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
  }
  return data;
}

async function buildPeriod(agentSlug, period) {
  const project = await builderProjects.hydrateProject({ agentSlug });
  const agent = project && project.agents && project.agents[0];
  if (!agent) return null;
  const names = [...new Set([agent.name, agentSlug].filter(Boolean))];
  const instances = instanceMap(agent);

  const params = [names];
  const where = periodSql(period, params);
  const { rows: calls } = await db.query(
    `select u.id,
            (extract(epoch from u.created_at) * 1000)::bigint as at,
            u.process, nullif(trim(u.crew_member), '') as crew, u.model,
            coalesce(u.input_tokens, 0) as i, coalesce(u.output_tokens, 0) as o,
            u.duration_ms as dur, nullif(trim(u.conversation_id), '') as conv
       from llm_usage u
      where u.agent_name = any($1::text[]) and ${where}
      order by u.created_at desc, u.id desc
      limit ${MAX_CALLS + 1}`,
    params,
  );
  const capped = calls.length > MAX_CALLS;
  if (capped) calls.length = MAX_CALLS;

  // Days with calls (the period picker) — last 90 days, local days.
  const { rows: dayRows } = await db.query(
    `select to_char((u.created_at at time zone 'UTC' at time zone $2)::date, 'YYYY-MM-DD') as day, count(*)::int as n
       from llm_usage u
      where u.agent_name = any($1::text[]) and u.created_at > (now() at time zone 'UTC') - interval '90 days'
      group by 1 order by 1 desc limit 60`,
    [names, TZ],
  );

  const convIds = [...new Set(calls.map(c => c.conv).filter(c => c && /^\d+$/.test(c)).map(Number))];
  const runsByConv = new Map();
  const asstByConv = new Map();
  const convInfo = new Map();
  if (convIds.length) {
    const [runs, msgs, convs] = await Promise.all([
      db.query(
        `select conversation_id as conv, message_id as mid, instance_id as iid, plugin_id as pid,
                (extract(epoch from started_at) * 1000)::bigint as s,
                (extract(epoch from coalesce(ended_at, started_at + coalesce(duration_ms, 0) * interval '1 millisecond')) * 1000)::bigint as e,
                duration_ms as dur, run_data->>'label' as label
           from addon_runs
          where conversation_id = any($1::int[]) and status <> 'skipped'`,
        [convIds],
      ),
      db.query(
        `select conversation_id as conv, id, role, (extract(epoch from created_at) * 1000)::bigint as at
           from messages
          where conversation_id = any($1::int[]) and role in ('assistant', 'user')
          order by conversation_id, id`,
        [convIds],
      ),
      db.query(
        `select id, (extract(epoch from created_at) * 1000)::bigint as at, metadata->>'kind' as kind
           from conversations where id = any($1::int[])`,
        [convIds],
      ),
    ]);
    for (const r of runs.rows) {
      const k = String(r.conv);
      const run = { ...r, s: Number(r.s), e: Number(r.e), used: false };
      (runsByConv.get(k) || runsByConv.set(k, []).get(k)).push(run);
    }
    // Turns are counted by assistant messages; a conversation whose turns
    // all failed before an answer was written has only user messages —
    // count those instead.
    const userByConv = new Map();
    for (const m of msgs.rows) {
      const k = String(m.conv);
      const into = m.role === 'assistant' ? asstByConv : userByConv;
      (into.get(k) || into.set(k, []).get(k)).push({ id: m.id, at: Number(m.at) });
    }
    for (const [k, list] of userByConv) if (!asstByConv.has(k)) asstByConv.set(k, list);
    for (const c of convs.rows) convInfo.set(String(c.id), { startedAt: Number(c.at), kind: c.kind || null });
  }

  // ── Match each call to its add-on run ──
  const callsAsc = calls.map(c => ({ ...c, at: Number(c.at), dur: c.dur == null ? null : Number(c.dur) }))
    .sort((a, b) => a.at - b.at || a.id - b.id);
  const runOf = new Map();
  // Pass 1: the run that ended with the call, same duration — one call each.
  for (const c of callsAsc) {
    const runs = c.conv && runsByConv.get(c.conv);
    if (!runs) continue;
    let best = null; let bestGap = Infinity;
    for (const r of runs) {
      if (r.used || r.pid !== c.process) continue;
      const gap = Math.abs(r.e - c.at);
      if (gap > MATCH_END_MS) continue;
      if (c.dur != null && r.dur != null && Math.abs(r.dur - c.dur) > MATCH_DURATION_MS) continue;
      if (gap < bestGap) { best = r; bestGap = gap; }
    }
    if (best) { best.used = true; runOf.set(c.id, best); }
  }
  // Pass 2: a run that made several calls — the tightest run around the call.
  for (const c of callsAsc) {
    if (runOf.has(c.id)) continue;
    const runs = c.conv && runsByConv.get(c.conv);
    if (!runs) continue;
    const start = c.at - (c.dur || 0);
    let best = null;
    for (const r of runs) {
      if (r.pid !== c.process) continue;
      if (start < r.s - 1000 || c.at > r.e + MATCH_END_MS) continue;
      if (!best || (r.e - r.s) < (best.e - best.s)) best = r;
    }
    if (best) { best.used = true; runOf.set(c.id, best); }
  }
  // Pass 3: copied / replayed conversations keep the order but not the
  // timing — when a conversation has exactly as many unexplained calls of a
  // type as unused runs of that type, pair them in order.
  const leftover = new Map();
  for (const c of callsAsc) {
    if (runOf.has(c.id) || !c.conv || !runsByConv.has(c.conv)) continue;
    const k = `${c.conv}|${c.process}`;
    (leftover.get(k) || leftover.set(k, []).get(k)).push(c);
  }
  for (const [k, list] of leftover) {
    const [conv, proc] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
    const free = runsByConv.get(conv).filter(r => !r.used && r.pid === proc).sort((a, b) => a.s - b.s);
    if (free.length !== list.length) continue;
    list.forEach((c, i) => { free[i].used = true; runOf.set(c.id, free[i]); });
  }

  // ── Build the rows ──
  const rows = callsAsc.map(c => {
    const run = runOf.get(c.id) || null;
    const inst = run ? instances.get(run.iid) : null;
    let addonId; let addonName; let addonType;
    if (run) {
      // An instance can change type between versions (an Extractor that
      // became a Field Reasoner) — keep those apart.
      addonId = `${run.iid}:${run.pid}`;
      addonType = TYPE_NAMES[run.pid] || describeProcess(run.pid).type;
      const label = run.label && run.label !== run.pid ? String(run.label).trim() : '';
      addonName = inst?.name || label || addonType;
    } else {
      const d = describeProcess(c.process);
      addonId = `process:${c.process}`;
      addonName = d.name;
      addonType = d.type;
    }

    let interaction = null;
    const asst = c.conv ? asstByConv.get(c.conv) : null;
    if (asst && asst.length) {
      const byMsg = run && run.mid != null ? asst.findIndex(m => m.id === run.mid) : -1;
      if (byMsg >= 0) interaction = byMsg + 1;
      else {
        const start = c.at - (c.dur || 0) + 50;
        let n = 0;
        for (const m of asst) { if (m.at <= start) n += 1; else break; }
        interaction = Math.max(1, n);
      }
    }

    const cost = models.costOf(c.model, Number(c.i), Number(c.o));
    return {
      id: c.id,
      at: c.at,
      crew: c.crew || inst?.crew || null,
      addonId,
      addonName,
      addonType,
      // Where the add-on lives in the config: its crew, or the agent level
      // (an agent-level add-on runs in whichever crew is active).
      addonScope: inst ? (inst.crew || 'Agent level') : null,
      model: c.model,
      modelName: models.MODELS.find(m => m.id === c.model)?.name || c.model,
      conversationId: c.conv || null,
      interaction,
      input: Number(c.i),
      output: Number(c.o),
      durationMs: c.dur,
      cost,
    };
  }).sort((a, b) => b.at - a.at || b.id - a.id);

  return {
    agent: { slug: agentSlug, name: agent.name || agentSlug },
    rows,
    capped,
    days: dayRows,
    convInfo,
  };
}

// ─── Filters, summary, views ──────────────────────────────────────────
function applyFilters(rows, { crew, addon, model }) {
  return rows.filter(r =>
    (!crew || (r.crew || '') === crew) &&
    (!addon || r.addonId === addon) &&
    (!model || r.model === model));
}

function sumUp(rows) {
  let input = 0; let output = 0; let cost = 0; let unpriced = 0;
  for (const r of rows) {
    input += r.input; output += r.output;
    if (r.cost == null) unpriced += 1; else cost += r.cost;
  }
  return { calls: rows.length, input, output, cost, unpriced };
}

function optionsOf(rows) {
  const crews = new Map(); const addons = new Map(); const modelsUsed = new Map();
  for (const r of rows) {
    const ck = r.crew || '';
    crews.set(ck, (crews.get(ck) || 0) + 1);
    const a = addons.get(r.addonId) || { id: r.addonId, name: r.addonName, type: r.addonType, crew: r.addonScope || r.crew, calls: 0 };
    a.calls += 1; addons.set(r.addonId, a);
    const m = modelsUsed.get(r.model) || { id: r.model, name: r.modelName, calls: 0, priced: r.cost != null || models.costOf(r.model, 0, 0) != null };
    m.calls += 1; modelsUsed.set(r.model, m);
  }
  const byName = (a, b) => String(a).localeCompare(String(b));
  return {
    crews: [...crews.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => byName(a.name, b.name)),
    addons: [...addons.values()].sort((a, b) => byName(a.crew || '', b.crew || '') || byName(a.name, b.name)),
    models: [...modelsUsed.values()].sort((a, b) => byName(a.name, b.name)),
  };
}

function conversationsOf(rows, convInfo) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.conversationId || '';
    const g = groups.get(k) || { id: r.conversationId, rows: [] };
    g.rows.push(r); groups.set(k, g);
  }
  const list = [...groups.values()].map(g => {
    const info = g.id ? convInfo.get(g.id) : null;
    const firstAt = Math.min(...g.rows.map(r => r.at));
    const lastAt = Math.max(...g.rows.map(r => r.at));
    return {
      id: g.id,
      kind: info?.kind || null,
      startedAt: info?.startedAt ?? firstAt,
      lastAt,
      interactions: g.id ? (new Set(g.rows.map(r => r.interaction).filter(n => n != null)).size || null) : null,
      ...sumUp(g.rows),
    };
  });
  // Most recent activity first; unlinked calls last.
  return list.sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || b.lastAt - a.lastAt);
}

/**
 * The screen's main read.
 * @returns null when the agent does not exist.
 */
async function report({ agentSlug, period, crew, addon, model, view, offset, limit }) {
  const p = normalizePeriod(period);
  const data = await loadPeriod(agentSlug, p);
  if (!data) return null;
  const filtered = applyFilters(data.rows, { crew, addon, model });
  const out = {
    agent: data.agent,
    period: p,
    timezone: TZ,
    days: data.days,
    capped: data.capped,
    options: optionsOf(data.rows),
    summary: {
      ...sumUp(filtered),
      conversations: new Set(filtered.map(r => r.conversationId).filter(Boolean)).size,
    },
  };
  if (view === 'conversations') {
    out.conversations = conversationsOf(filtered, data.convInfo);
  } else {
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    out.runs = filtered.slice(off, off + lim);
    out.offset = off;
    out.total = filtered.length;
  }
  return out;
}

/** One conversation's calls (or the unlinked ones), split by interaction. */
async function conversationDetail({ agentSlug, conversation, period, crew, addon, model }) {
  const p = normalizePeriod(period);
  const data = await loadPeriod(agentSlug, p);
  if (!data) return null;
  const want = conversation === 'unlinked' ? null : String(conversation);
  const rows = applyFilters(data.rows, { crew, addon, model })
    .filter(r => (r.conversationId || null) === want)
    .sort((a, b) => a.at - b.at || a.id - b.id);
  const groups = new Map();
  for (const r of rows) {
    const k = r.interaction ?? 0;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  return {
    conversationId: want,
    interactions: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([n, rs]) => ({
      interaction: n || null,
      ...sumUp(rs),
      runs: rs,
    })),
  };
}

module.exports = { report, conversationDetail, _internal: { describeProcess, instanceMap, normalizePeriod, conversationsOf, applyFilters, sumUp } };
