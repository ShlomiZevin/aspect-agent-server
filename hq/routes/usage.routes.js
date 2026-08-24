/**
 * HQ — what our own workers cost. Mounted at /api/hq/usage.
 *
 * Separate from /api/admin/usage on purpose. That page answers "what do our
 * customer agents cost", and HQ is internal tooling — leaving it in inflated
 * every per-agent figure with our own spending. So the admin endpoints now
 * exclude agent_name='hq', and this is where it lives instead.
 *
 * Two kinds of money are reported together, because only one of them is in
 * llm_usage: tokens (Claude for thinking, OpenAI for phrasing) and images
 * (Leonardo, billed per picture and recorded in hq_media).
 */

const express = require('express');
const router = express.Router();
const db = require('../../services/db.pg');
const budget = require('../services/budget.service');
const leonardo = require('../services/leonardo.service');
const models = require('../../services/models.service');

function fail(res, err) {
  console.error('[hq/usage]', err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message });
}

/** Named for a person, not for a process key. */
/**
 * Not every spender is an employee. `ask` and `scribe` are HQ's own machinery —
 * the question box and the thing that summarises a source as it is indexed.
 * Shown under their real names so a column headed "Worker" is never a slug.
 */
const SYSTEM_NAMES = {
  ask: 'Ask HQ',
  scribe: 'Indexing',
  'hq-worker': 'HQ itself',
};

const PROCESS_LABELS = {
  hq_worker: 'Thinking',
  hq_phrasing: 'Voice',
  'hq-ask': 'Ask HQ',
  'hq-ask-expand': 'Ask HQ · rephrasing the question',
  'hq-scribe': 'Summarising a source',
  'hq-title': 'Naming a conversation',
};

router.get('/', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30', 10), 365);
    const since = `NOW() - INTERVAL '${days} days'`;

    const [byProcess, byModel, byWorker, daily, images, imagesByWorker, recentImages, recent] =
      await Promise.all([
      db.query(
        `SELECT process, model, SUM(input_tokens)::bigint inp, SUM(output_tokens)::bigint outp,
                COUNT(*)::int calls
           FROM llm_usage WHERE agent_name = 'hq' AND created_at >= ${since}
          GROUP BY process, model ORDER BY 5 DESC`),
      db.query(
        `SELECT model, provider, SUM(input_tokens)::bigint inp, SUM(output_tokens)::bigint outp,
                COUNT(*)::int calls
           FROM llm_usage WHERE agent_name = 'hq' AND created_at >= ${since}
          GROUP BY model, provider ORDER BY 5 DESC`),
      db.query(
        // Join the roster so this says "Maya", not "maya". Rows with no crew
        // member are HQ's own machinery — Ask, the scribe — not an employee.
        `SELECT COALESCE(w.name, u.crew_member, 'HQ itself') AS who_raw, u.model,
                SUM(u.input_tokens)::bigint inp, SUM(u.output_tokens)::bigint outp,
                COUNT(*)::int calls
           FROM llm_usage u
           LEFT JOIN hq_workers w ON w.slug = u.crew_member
          WHERE u.agent_name = 'hq' AND u.created_at >= ${since}
          GROUP BY 1, 2 ORDER BY 5 DESC`),
      db.query(
        `SELECT DATE(created_at) AS day, model,
                SUM(input_tokens)::bigint inp, SUM(output_tokens)::bigint outp
           FROM llm_usage WHERE agent_name = 'hq' AND created_at >= ${since}
          GROUP BY 1, 2 ORDER BY 1`),
      db.query(
        `SELECT DATE(created_at) AS day, COUNT(*)::int n,
                SUM(cost_usd)::numeric(12,4) usd, model
           FROM hq_media WHERE cost_usd > 0 AND created_at >= ${since}
          GROUP BY 1, 4 ORDER BY 1`),
      // Per employee, so "who spent it" counts their pictures too — for Maya
      // that is most of her bill, and tokens alone would halve it.
      db.query(
        `SELECT COALESCE(w.name, 'HQ itself') AS who, m.model,
                COUNT(*)::int n, SUM(m.cost_usd)::numeric(12,4) usd
           FROM hq_media m
           LEFT JOIN hq_workers w ON w.id = m.worker_id
          WHERE m.cost_usd > 0 AND m.created_at >= ${since}
          GROUP BY 1, 2 ORDER BY 4 DESC`),
      // Every picture as its own line, so the recent list is what HQ actually
      // spent rather than only the half of it that happens to be tokens.
      db.query(
        `SELECT m.id, COALESCE(w.name, 'HQ itself') AS who, m.model, m.title,
                m.cost_usd, m.created_at
           FROM hq_media m
           LEFT JOIN hq_workers w ON w.id = m.worker_id
          WHERE m.cost_usd > 0
          ORDER BY m.id DESC LIMIT 60`),
      db.query(
        `SELECT u.id, COALESCE(w.name, u.crew_member, 'HQ itself') AS who_raw,
                u.process, u.model, u.provider, u.input_tokens, u.output_tokens,
                u.duration_ms, u.created_at
           FROM llm_usage u
           LEFT JOIN hq_workers w ON w.slug = u.crew_member
          WHERE u.agent_name = 'hq'
          ORDER BY u.id DESC LIMIT 60`),
    ]);

    /** A slug only ever reaches the UI through here. */
    const named = who => SYSTEM_NAMES[who] || who;

    /**
     * A raw model id does not say which model it is. `gpt-5.6` is Sol and
     * `gpt-5.6-terra` is Terra — same family, different model, half the price —
     * and you cannot tell from the id which one answered. Both are sent: the
     * name to read, the id to act on.
     */
    const modelName = id => models.getModel?.(id)?.name || id;

    const priced = rows => rows.map(r => ({
      ...r,
      who: r.who_raw ? named(r.who_raw) : r.who,
      modelName: modelName(r.model),
      inp: Number(r.inp), outp: Number(r.outp),
      usd: Number(budget.priceOf(r.model, Number(r.inp), Number(r.outp)).toFixed(4)),
    }));

    const tokenRows = priced(byProcess.rows);
    const tokensUsd = tokenRows.reduce((s, r) => s + r.usd, 0);
    const imagesUsd = images.rows.reduce((s, r) => s + Number(r.usd), 0);
    const imageCount = images.rows.reduce((s, r) => s + r.n, 0);

    // One row per day, both kinds of money side by side.
    // node-pg hands DATE back as either a string or a Date depending on the
    // parser, and this endpoint saw both. When it is a Date it is LOCAL
    // midnight, so toISOString() would report the previous day everywhere east
    // of UTC — read the local parts instead.
    const dayKey = d => {
      if (typeof d === 'string') return d.slice(0, 10);
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    const byDay = new Map();
    for (const r of daily.rows) {
      const key = dayKey(r.day);
      const at = byDay.get(key) || { day: key, tokensUsd: 0, imagesUsd: 0 };
      at.tokensUsd += budget.priceOf(r.model, Number(r.inp), Number(r.outp));
      byDay.set(key, at);
    }
    for (const r of images.rows) {
      const key = dayKey(r.day);
      const at = byDay.get(key) || { day: key, tokensUsd: 0, imagesUsd: 0 };
      at.imagesUsd += Number(r.usd);
      byDay.set(key, at);
    }

    res.json({
      days,
      totals: {
        tokensUsd: Number(tokensUsd.toFixed(4)),
        imagesUsd: Number(imagesUsd.toFixed(4)),
        totalUsd: Number((tokensUsd + imagesUsd).toFixed(4)),
        imageCount,
        calls: tokenRows.reduce((s, r) => s + r.calls, 0),
      },
      byProcess: tokenRows.map(r => ({ ...r, label: PROCESS_LABELS[r.process] || r.process })),
      byModel: priced(byModel.rows),
      byImageModel: (() => {
        const per = new Map();
        for (const r of images.rows) {
          const at = per.get(r.model) || { model: r.model, label: leonardo.labelFor(r.model), n: 0, usd: 0 };
          at.n += r.n;
          at.usd += Number(r.usd);
          per.set(r.model, at);
        }
        return [...per.values()]
          .map(m => ({ ...m, usd: Number(m.usd.toFixed(4)), each: Number((m.usd / (m.n || 1)).toFixed(4)) }))
          .sort((a, b) => b.usd - a.usd);
      })(),
      // One row per person per model, whichever kind of model it is. A picture
      // has no tokens and a thought has no picture count, so both columns are
      // nullable and the table shows a dash rather than a misleading zero.
      byWorker: [
        ...priced(byWorker.rows).map(r => ({
          who: r.who, model: r.model, kind: 'tokens',
          calls: r.calls, inp: r.inp, outp: r.outp, pictures: null, usd: r.usd,
        })),
        ...imagesByWorker.rows.map(r => ({
          who: r.who, model: r.model, modelName: r.model, kind: 'images',
          calls: r.n, inp: null, outp: null, pictures: r.n, usd: Number(Number(r.usd).toFixed(4)),
        })),
      ].sort((a, b) => b.usd - a.usd),
      byDay: [...byDay.values()]
        .map(d => ({
          ...d,
          tokensUsd: Number(d.tokensUsd.toFixed(4)),
          imagesUsd: Number(d.imagesUsd.toFixed(4)),
          totalUsd: Number((d.tokensUsd + d.imagesUsd).toFixed(4)),
        }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      // Tokens and pictures interleaved by time. Two separate lists would make
      // you reconcile them by eye to answer "what did that job cost".
      recent: [
        ...recent.rows.map(r => ({
          key: `t${r.id}`, kind: 'tokens', who: named(r.who_raw),
          label: PROCESS_LABELS[r.process] || r.process,
          model: r.model, modelName: modelName(r.model), provider: r.provider,
          input_tokens: r.input_tokens, output_tokens: r.output_tokens,
          created_at: r.created_at,
          usd: Number(budget.priceOf(r.model, r.input_tokens, r.output_tokens).toFixed(5)),
        })),
        ...recentImages.rows.map(r => ({
          key: `i${r.id}`, kind: 'images', who: r.who,
          label: 'Generating an image',
          model: r.model, modelName: r.model, provider: 'leonardo',
          input_tokens: null, output_tokens: null, title: r.title,
          created_at: r.created_at,
          usd: Number(Number(r.cost_usd).toFixed(5)),
        })),
      ]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 80),
      budget: await budget.budgetStatus().catch(() => null),
    });
  } catch (err) { fail(res, err); }
});

module.exports = router;
