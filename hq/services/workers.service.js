/**
 * HQ — employees: the roster, their conversations, and running one.
 *
 * A worker is data. Its behaviour is `role_definition` (a plain system prompt
 * anyone can edit) and `tools` (a list of names). Nothing about marketing lives
 * in this file — the second employee is an INSERT.
 */

const db = require('../../services/db.pg');
const loop = require('./agent-loop.service');
const toolbox = require('./worker-tools.service');
const media = require('./media.service');

// Runs live in-process so a stop request can reach one; a restart loses the
// registry, which is what reclaimStaleJobs is for.
const active = new Map();   // jobId -> { cancelled }

// ─── Roster ──────────────────────────────────────────────────────────────────

async function list() {
  const { rows } = await db.query(
    `SELECT w.*,
            (SELECT COUNT(*)::int FROM hq_jobs j
              WHERE j.worker_id = w.id AND j.status = 'running') AS running_jobs,
            (SELECT COUNT(*)::int FROM hq_worker_conversations c
              WHERE c.worker_id = w.id) AS conversations
       FROM hq_workers w WHERE enabled ORDER BY w.id`);
  return rows;
}

async function get(slug) {
  const { rows } = await db.query(`SELECT * FROM hq_workers WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

async function update(slug, patch = {}) {
  const allowed = {
    name: 'name', roleTitle: 'role_title', tagline: 'tagline', avatar: 'avatar',
    accent: 'accent', roleDefinition: 'role_definition', model: 'model',
  };
  // Both live in `settings`, and both are merged rather than replaced so
  // setting one knob cannot wipe the other. `null` is meaningful for
  // imageModel — it is how you go back to letting her choose per brief.
  const settingKeys = ['phrasingModel', 'imageModel'];
  if (settingKeys.some(k => patch[k] !== undefined)) {
    const current = await get(slug);
    patch.settings = { ...(current?.settings || {}) };
    for (const k of settingKeys) {
      if (patch[k] !== undefined) patch.settings[k] = patch[k] || null;
    }
  }
  const sets = [];
  const params = [slug];
  for (const [key, col] of Object.entries(allowed)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${col} = $${params.length}`);
  }
  if (patch.tools) { params.push(JSON.stringify(patch.tools)); sets.push(`tools = $${params.length}`); }
  if (patch.settings) { params.push(JSON.stringify(patch.settings)); sets.push(`settings = $${params.length}`); }
  if (!sets.length) return get(slug);

  const { rows } = await db.query(
    `UPDATE hq_workers SET ${sets.join(', ')}, updated_at = NOW() WHERE slug = $1 RETURNING *`, params);
  return rows[0];
}

// ─── Conversations ───────────────────────────────────────────────────────────

async function conversations(workerId, limit = 40) {
  const { rows } = await db.query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM hq_worker_messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT COUNT(*)::int FROM hq_media md WHERE md.conversation_id = c.id) AS media_count
       FROM hq_worker_conversations c
      WHERE c.worker_id = $1 ORDER BY c.updated_at DESC LIMIT $2`, [workerId, limit]);
  return rows;
}

async function createConversation(workerId, title = 'New conversation') {
  const { rows } = await db.query(
    `INSERT INTO hq_worker_conversations (worker_id, title) VALUES ($1,$2) RETURNING *`,
    [workerId, title]);
  return rows[0];
}

async function conversation(id) {
  const { rows } = await db.query(`SELECT * FROM hq_worker_conversations WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** `auto` and null both mean "she chooses"; store null so there is one falsy value. */
/**
 * Which models this conversation uses. Only the keys present are touched, so
 * setting one does not silently reset the other two.
 *
 * `auto` and null both mean "use her default"; stored as NULL so there is one
 * falsy value rather than two that have to be checked everywhere.
 */
async function setConversationModels(id, { model, phrasingModel, imageModel } = {}) {
  const clean = v => (v && v !== 'auto' && v !== 'default' ? v : null);
  const sets = [];
  const params = [id];
  const add = (col, value) => { params.push(clean(value)); sets.push(`${col} = $${params.length}`); };

  if (model !== undefined) add('model', model);
  if (phrasingModel !== undefined) add('phrasing_model', phrasingModel);
  if (imageModel !== undefined) add('image_model', imageModel);
  if (!sets.length) return conversation(id);

  const { rows } = await db.query(
    `UPDATE hq_worker_conversations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return rows[0] || null;
}

async function messages(conversationId) {
  const { rows } = await db.query(
    `SELECT * FROM hq_worker_messages WHERE conversation_id = $1 ORDER BY created_at`, [conversationId]);
  return rows;
}

async function addMessage(conversationId, role, content, metadata = {}) {
  const { rows } = await db.query(
    `INSERT INTO hq_worker_messages (conversation_id, role, content, metadata)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [conversationId, role, content, JSON.stringify(metadata)]);
  await db.query(`UPDATE hq_worker_conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
  return rows[0];
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

async function jobs({ workerId = null, conversationId = null, limit = 25 } = {}) {
  await reclaimStaleJobs().catch(() => {});
  const { rows } = await db.query(
    `SELECT j.*, w.name AS worker_name, w.avatar,
            (SELECT COUNT(*)::int FROM hq_media m WHERE m.job_id = j.id) AS media_count
       FROM hq_jobs j LEFT JOIN hq_workers w ON w.id = j.worker_id
      WHERE ($1::int IS NULL OR j.worker_id = $1)
        AND ($2::int IS NULL OR j.conversation_id = $2)
      ORDER BY j.started_at DESC LIMIT $3`,
    [workerId, conversationId, limit]);
  return rows.map(r => ({ ...r, live: active.has(r.id) }));
}

function cancelJob(jobId) {
  const handle = active.get(Number(jobId));
  if (!handle) return false;
  handle.cancelled = true;
  return true;
}

// Same lesson as every other fire-and-forget thing here: a run that only exists
// in memory needs a way to notice it died. Throttled — this is called on read.
let lastSweep = 0;
async function reclaimStaleJobs(staleMinutes = 15) {
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  await db.query(
    `UPDATE hq_jobs SET status='failed',
            error = COALESCE(error, 'Interrupted — the server restarted mid-job.'),
            finished_at = NOW(), updated_at = NOW()
      WHERE status = 'running' AND updated_at < NOW() - ($1 || ' minutes')::interval`,
    [String(staleMinutes)]);
}

/**
 * What a worker has actually cost, both kinds of money.
 *
 * Deliberately NOT merged into llm_usage. That table prices work by tokens
 * against a per-model rate; Leonardo bills per image and has no tokens at all,
 * so a row there would need invented token counts and would then be mispriced
 * by everything that reads it — the billing page and the daily budget included.
 * The image cost is already true in hq_media; this just adds the two up.
 */
async function spend(workerId, slug) {
  const [images, thinking] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(cost_usd), 0)::numeric(12,4) AS total,
              COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::numeric(12,4) AS month,
              COUNT(*)::int AS count
         FROM hq_media WHERE worker_id = $1 AND cost_usd > 0`, [workerId]),
    db.query(
      `SELECT model, SUM(input_tokens)::bigint inp, SUM(output_tokens)::bigint outp
         FROM llm_usage
        WHERE agent_name = 'hq' AND process IN ('hq_worker', 'hq_phrasing')
          AND crew_member = $1
        GROUP BY model`, [slug]),
  ]);

  const budget = require('./budget.service');
  const thinkingUsd = thinking.rows.reduce(
    (sum, r) => sum + budget.priceOf(r.model, Number(r.inp), Number(r.outp)), 0);

  const imagesUsd = Number(images.rows[0].total);
  return {
    imagesUsd: Number(imagesUsd.toFixed(4)),
    imagesThisMonthUsd: Number(Number(images.rows[0].month).toFixed(4)),
    imageCount: images.rows[0].count,
    thinkingUsd: Number(thinkingUsd.toFixed(4)),
    totalUsd: Number((imagesUsd + thinkingUsd).toFixed(4)),
  };
}

// ─── Running one ─────────────────────────────────────────────────────────────

/**
 * Craft notes a worker has recorded for itself.
 *
 * Capped, and newest first: an unbounded list would grow until it crowded out
 * the actual job description, and a worker with fifty rules follows none of
 * them. If the cap is ever hit regularly, that is a signal the lessons need
 * curating by a person, not a bigger number.
 */
const MAX_LESSONS = 25;

async function lessonsFor(workerId) {
  const { rows } = await db.query(
    `SELECT lesson FROM hq_worker_lessons
      WHERE worker_id = $1 AND active
      ORDER BY created_at DESC LIMIT $2`,
    [workerId, MAX_LESSONS]);
  return rows.map(r => r.lesson);
}

/** Everything, including switched-off ones, for the panel that manages them. */
async function allLessons(workerId) {
  const { rows } = await db.query(
    `SELECT * FROM hq_worker_lessons WHERE worker_id = $1 ORDER BY active DESC, created_at DESC`,
    [workerId]);
  return rows;
}

async function addLesson(workerId, lesson, learnedFrom = 'Added by hand') {
  const { rows } = await db.query(
    `INSERT INTO hq_worker_lessons (worker_id, lesson, learned_from) VALUES ($1,$2,$3) RETURNING *`,
    [workerId, lesson.trim(), learnedFrom]);
  return rows[0];
}

async function updateLesson(id, patch = {}) {
  const sets = [];
  const params = [id];
  if (patch.lesson !== undefined) { params.push(patch.lesson.trim()); sets.push(`lesson = $${params.length}`); }
  if (patch.active !== undefined) { params.push(!!patch.active); sets.push(`active = $${params.length}`); }
  if (!sets.length) return null;
  const { rows } = await db.query(
    `UPDATE hq_worker_lessons SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return rows[0];
}

async function removeLesson(id) {
  await db.query(`DELETE FROM hq_worker_lessons WHERE id = $1`, [id]);
}

/**
 * How the employee is told to behave: its own job description, what it has
 * learned, then the mechanics of working here.
 *
 * The mechanics live in code rather than the database because they are true of
 * every worker — when to open a job, how to report progress — and nobody
 * editing a role should have to re-type them.
 */
function systemPrompt(worker, lessons = []) {
  const learned = lessons.length
    ? [
        '',
        '── What you have learned here ──',
        'Written by you, from real work. Follow them unless the person says otherwise.',
        ...lessons.map(l => `• ${l}`),
      ].join('\n')
    : '';

  return `${worker.role_definition}${learned}

── How you work here ──
You are ${worker.name}, ${worker.role_title} at Lybi. Lybi is a 3-person company:
Shlomi, Noa and Hila.

Answer normally when someone asks you something. But when the request is real
work — several steps, or producing files — call start_job with a short plan
first, then work through it calling update_step as each step actually finishes,
then finish_job. People watch that plan; it is how they know you are working
and what you are doing. Never write the plan out as prose instead.

Before you state anything about Lybi — our colours, our positioning, our
pricing, what we decided — call search_hq. Guessing about our own company is
worse than saying you don't know.

Never write image markdown or invent a URL for something you made. Everything
you generate already appears beside the conversation and in Media — referring to
it as "the banner" is enough, and a made-up link only renders as broken.

Reply in the language you were addressed in. Hebrew for Hebrew, English for
English. Be concrete and brief.`;
}

/**
 * Handle one message. Returns when the exchange is done.
 *
 * The loop runs server-side and writes as it goes, so closing the tab loses the
 * live view but never the work.
 */
async function send({ worker, conversationId, message, onEvent = null }) {
  await addMessage(conversationId, 'user', message);

  // Name it now, from what was asked. Doing this after the reply meant the rail
  // said "New conversation" for the entire time the work was running — which is
  // exactly when you might go looking for it.
  await db.query(
    `UPDATE hq_worker_conversations SET title = $2
      WHERE id = $1 AND title = 'New conversation'`,
    [conversationId, message.slice(0, 80)]
  ).catch(() => {});

  // What she has been given: her briefcase plus anything attached to this
  // conversation. Injected as the first exchange rather than described in the
  // prompt — a document block IS the file; a prompt can only summarise one.
  const workerFiles = require('./worker-context.service');
  const brief = await workerFiles.briefing({
    workerId: worker.id, conversationId, workerName: worker.name,
  }).catch(err => {
    console.error('[workers] could not build the file briefing', err.message);
    return null;
  });

  const history = await messages(conversationId);
  const priorTurns = history
    .filter(m => m.content && m.content.trim())
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

  // In front of real history, so it reads as the briefing she was given when
  // she started rather than as something said mid-conversation.
  const opening = brief ? brief.messages : [];

  const tools = toolbox.resolve(worker.tools || []);
  // What this conversation overrides. NULL anywhere means "use her default",
  // so a changed default is picked up rather than frozen at the time of asking.
  const { rows: [conv] } = await db.query(
    `SELECT model, phrasing_model, image_model FROM hq_worker_conversations WHERE id = $1`,
    [conversationId]);

  // Three levels, most specific first: this conversation, then her standing
  // default, then null which genuinely means "she decides per brief".
  const imageModel =
    (conv?.image_model && conv.image_model !== 'auto' ? conv.image_model : null) ||
    worker.settings?.imageModel ||
    null;
  const thinkingModel = conv?.model || worker.model;

  // Overridden on a COPY: `worker` is the stored row, and mutating it here
  // would make one conversation's choice look like an edit to the employee.
  const effectiveWorker = conv?.phrasing_model
    ? { ...worker, settings: { ...(worker.settings || {}), phrasingModel: conv.phrasing_model } }
    : worker;

  const ctx = {
    workerId: worker.id, worker: effectiveWorker, conversationId, jobId: null,
    brief: message, onEvent, imageModel,
    // The voice model cannot read document blocks, so write_copy passes this
    // through as the facts its copy must be accurate to.
    materials: brief ? brief.digest : null,
  };

  // Tool handlers take (input, ctx) but the loop passes its own context, so
  // bind ours in — this is what lets start_job set ctx.jobId for later tools.
  const bound = tools.map(t => ({
    ...t,
    handler: (input) => t.handler(input, ctx),
  }));

  const lessons = await lessonsFor(worker.id).catch(() => []);

  // Say it in the prompt as well as enforcing it in the tool: enforcement alone
  // makes her narrate the wrong model in the reply she writes before the call.
  const pinned = imageModel
    ? `

FOR THIS CONVERSATION: every image must be generated with ` +
      `${require('./leonardo.service').labelFor(imageModel)} (${imageModel}). ` +
      `The person chose it. Do not use a different image model, and do not ask about it.`
    : '';

  const result = await loop.run({
    system: systemPrompt(worker, lessons) + pinned,
    messages: [...opening, ...priorTurns],
    tools: bound,
    model: thinkingModel,
    workerName: worker.slug,
    conversationId,
    onEvent,
    shouldStop: () => ctx.jobId && active.get(ctx.jobId)?.cancelled,
  });

  // Charge the token spend to the job, split by what it was for.
  //
  // Read back from llm_usage rather than from the loop's own usage: the loop
  // only knows what IT spent, so anything a tool sent to another provider —
  // every write_copy call to OpenAI — was recorded as free.
  if (ctx.jobId) {
    const budget = require('./budget.service');
    try {
      const { rows: [job] } = await db.query(
        `SELECT llm_usage_from_id FROM hq_jobs WHERE id = $1`, [ctx.jobId]);
      const { rows: turns } = await db.query(
        `SELECT process, model, SUM(input_tokens)::bigint inp, SUM(output_tokens)::bigint outp
           FROM llm_usage
          WHERE agent_name = 'hq' AND process IN ('hq_worker', 'hq_phrasing')
            AND conversation_id = $1 AND id > COALESCE($2, 0)
          GROUP BY process, model`,
        [conversationId, job?.llm_usage_from_id]);

      let thinking = 0, phrasing = 0, tokensIn = 0, tokensOut = 0;
      for (const t of turns) {
        const usd = budget.priceOf(t.model, Number(t.inp), Number(t.outp));
        if (t.process === 'hq_phrasing') phrasing += usd; else thinking += usd;
        tokensIn += Number(t.inp);
        tokensOut += Number(t.outp);
      }

      await db.query(
        `UPDATE hq_jobs
            SET llm_cost_usd = $2, phrasing_cost_usd = $3,
                llm_tokens_in = $4, llm_tokens_out = $5, updated_at = NOW()
          WHERE id = $1`,
        [ctx.jobId, thinking, phrasing, tokensIn, tokensOut]);
    } catch (err) {
      console.warn('[hq] job cost update skipped:', err.message);
    }
  }

  await addMessage(conversationId, 'assistant', result.text || '', {
    toolCalls: result.toolCalls.map(c => ({ name: c.name })),
    usage: result.usage,
    jobId: ctx.jobId,
  });

  return { text: result.text, jobId: ctx.jobId, toolCalls: result.toolCalls, usage: result.usage };
}

module.exports = {
  conversation, setConversationModels,
  list, get, update,
  conversations, createConversation, messages, addMessage,
  jobs, cancelJob, reclaimStaleJobs, spend,
  send, systemPrompt, lessonsFor, allLessons, addLesson, updateLesson, removeLesson,
  media,
  registerActive: (jobId) => active.set(Number(jobId), { cancelled: false }),
  clearActive: (jobId) => active.delete(Number(jobId)),
};
