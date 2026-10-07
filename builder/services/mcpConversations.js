/**
 * Talking to an agent through the `/builder/mcp` door (task #894).
 *
 * The building blocks that let an outside AI simulate conversations BY
 * ITSELF — the server never runs a simulation, it only offers:
 *
 *   startConversation  a fresh conversation with an agent
 *   sendMessage        one user message in, the WHOLE reply out (no stream)
 *   readState          the conversation's fields / memory / current crew
 *   userReply          "what would this persona say next?" — a stateless
 *                      helper for scripts that run without a model
 *
 * ── Why it calls our own HTTP endpoints ────────────────────────────
 *
 * A turn is ~150 lines of route logic in runtimeRoute.js (persist the
 * message, auto-name, reserve the reply row, run the chain, offline
 * addons, triggers…). Re-implementing it here would give simulated
 * conversations a slightly different turn from real ones — the one thing
 * a test must never have. So `sendMessage` posts to the very endpoint the
 * live chat uses and collects its event stream into one answer. A
 * simulated conversation is therefore an ordinary conversation: same
 * logs, same addon trail, opens in the Builder like any other.
 *
 * ── What keeps it safe ─────────────────────────────────────────────
 *
 *   - Conversations born here are stamped `metadata.kind = 'simulation'`
 *     and belong to a synthetic user, so they never mix with real ones.
 *   - `sendMessage` only accepts a conversation with that stamp: this
 *     door can never put words into a real customer's conversation.
 *   - Only versions saved on the server run (active, or published) —
 *     never an unsaved working copy.
 *   - A daily cap on turns and on user-reply calls (shared counters in
 *     provider_config, so they hold across instances).
 */

const db = require('../../services/db.pg');
const { eq } = require('drizzle-orm');
const { conversations, users, providerConfig } = require('../../db/schema');
const builderProjects = require('./builderProjects');
const { exportConversation } = require('./conversationExport');
const llmService = require('../../services/llm');
const models = require('../../services/models.service');

const VERSIONS = ['active', 'published'];
const DAILY_TURN_CAP = Number(process.env.MCP_SIM_DAILY_TURNS) || 2000;
const DAILY_USER_REPLY_CAP = Number(process.env.MCP_SIM_DAILY_USER_REPLIES) || 2000;

function drizzle() {
  return db.getDrizzle();
}

/** A problem the caller can fix — carries the HTTP status and a sentence. */
function refuse(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Our own server, from inside it. */
function selfUrl(pathname) {
  return `http://127.0.0.1:${process.env.PORT || 3000}${pathname}`;
}

// ─── Daily caps ────────────────────────────────────────────────────

function todayKey() {
  return `mcp_sim_usage:${new Date().toISOString().slice(0, 10)}`;
}

/** Count one use of `kind`; throws 429 once today's cap is reached. */
async function countUse(kind, cap) {
  const d = drizzle();
  const key = todayKey();
  const [row] = await d.select().from(providerConfig).where(eq(providerConfig.key, key)).limit(1);
  let usage = {};
  try { usage = JSON.parse(row?.value || '{}') || {}; } catch { usage = {}; }
  const used = Number(usage[kind]) || 0;
  if (used >= cap) {
    throw refuse(429, `Today's limit for simulated ${kind === 'turns' ? 'conversation turns' : 'user replies'} (${cap}) is used up. It resets at midnight UTC — tell the person, and ask Shlomi if more is needed.`);
  }
  const value = JSON.stringify({ ...usage, [kind]: used + 1 });
  await d.insert(providerConfig).values({ key, value })
    .onConflictDoUpdate({ target: providerConfig.key, set: { value, updatedAt: new Date() } });
}

// ─── Start ─────────────────────────────────────────────────────────

/**
 * @param {object} a
 * @param {string} a.slug
 * @param {string} a.by        roster name of the person whose AI is asking
 * @param {string} [a.version] 'active' (default) | 'published'
 * @param {string} [a.label]   free text shown on the conversation
 * @param {string} [a.startCrew] crew id or name to begin in
 * @param {object} [a.fields]  { fieldName: value } the conversation is born with
 */
async function startConversation({ slug, by, version, label, startCrew, fields }) {
  const project = await builderProjects.hydrateProject({ agentSlug: slug });
  const agent = project && project.agents[0];
  if (!agent) throw refuse(404, `No agent with slug "${slug}". Fetch ../agents for the list.`);

  const ver = version == null || version === '' ? 'active' : String(version).toLowerCase();
  if (!VERSIONS.includes(ver)) {
    throw refuse(400, `"version" is "active" (the default — the version the Builder opens) or "published" (what customers get). Unsaved changes cannot be tested here; save them first.`);
  }

  let crew = null;
  if (startCrew) {
    const wanted = String(startCrew).trim().toLowerCase();
    crew = (agent.crews || []).find(c => c.id === startCrew || String(c.name || '').toLowerCase() === wanted);
    if (!crew) {
      const list = (agent.crews || []).map(c => `${c.name} (${c.id})`).join(', ');
      throw refuse(404, `No crew "${startCrew}" on this agent. Its crews: ${list}.`);
    }
  }

  let seedMemory;
  if (fields != null) {
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      throw refuse(400, '"fields" is an object of starting values, e.g. { "age": 19, "customer_type": "student" }.');
    }
    seedMemory = Object.entries(fields).map(([field, value]) => ({ field, value }));
  }

  // A fresh synthetic user per conversation: an agent's memory of a user
  // carries across that user's conversations, and a test should start clean.
  const tag = Math.random().toString(36).slice(2, 10);
  const ownerUserId = `sim-${String(by).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${tag}`;

  const res = await fetch(selfUrl(`/api/agents/${encodeURIComponent(slug)}/conversations`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUserId, source: 'simulation', ...(seedMemory ? { seedMemory } : {}) }),
  });
  const created = await res.json().catch(() => ({}));
  if (!res.ok || !created.conversationId) {
    throw new Error(created.error || `could not create the conversation (${res.status})`);
  }
  const conversationId = created.conversationId;

  const d = drizzle();
  const [conv] = await d.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  const cleanLabel = String(label || '').trim().slice(0, 80);
  await d.update(conversations).set({
    metadata: {
      ...(conv.metadata || {}),
      ...(cleanLabel ? { name: cleanLabel } : {}),
      ...(crew ? { currentCrewId: crew.id } : {}),
      simulation: { by, version: ver, ownerUserId, ...(cleanLabel ? { label: cleanLabel } : {}) },
    },
  }).where(eq(conversations.id, conversationId));
  // Shows as the owner in the admin Conversations list.
  await d.update(users).set({ name: `Simulated · ${by}` }).where(eq(users.id, conv.userId));

  return {
    conversationId,
    agent: slug,
    version: ver,
    crew: crew ? { id: crew.id, name: crew.name } : null,
    by,
  };
}

// ─── One turn ──────────────────────────────────────────────────────

async function loadSimulation(conversationId) {
  const id = Number(conversationId);
  if (!Number.isInteger(id) || id <= 0) throw refuse(400, 'The conversation id is a number.');
  const [conv] = await drizzle().select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!conv) throw refuse(404, `No conversation ${conversationId}.`);
  const meta = conv.metadata || {};
  if (meta.kind !== 'simulation' || !meta.simulation) {
    throw refuse(403, `Conversation ${conversationId} is a real conversation, not a simulation — it can be read, never written to. Start your own with POST ../agents/<slug>/conversations.`);
  }
  return { id, meta, sim: meta.simulation, slug: meta.agentSlug };
}

/** Read an SSE response to its end; hand each `data:` event to `onEvent`. */
async function readEvents(res, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive or partial */ }
      }
    }
  }
}

/**
 * Send one user message; resolve with the whole reply.
 *
 * @returns {{ conversationId, reply, messageId, crew?, transition?, fieldsWritten?, addons?, export }}
 */
async function sendMessage({ conversationId, text }) {
  const message = String(text || '').trim();
  if (!message) throw refuse(400, 'Send { "text": "what the user says" }.');
  const { id, sim, slug } = await loadSimulation(conversationId);
  await countUse('turns', DAILY_TURN_CAP);

  const res = await fetch(selfUrl(`/api/agents/${encodeURIComponent(slug)}/conversations/${id}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUserId: sim.ownerUserId, userMessage: message, version: sim.version }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`the agent did not accept the message (${res.status}) ${body.slice(0, 200)}`);
  }

  const replies = [];
  let messageId = null;
  let failure = null;
  let stopped = false;
  await readEvents(res, ev => {
    if (ev.type === 'assistant.message') {
      if (ev.text) replies.push(ev.text);
      if (ev.messageId) messageId = ev.messageId;
    } else if (ev.type === 'addon.error' && ev.instanceId == null) {
      failure = (ev.error && ev.error.message) || 'the turn failed';
    } else if (ev.type === 'turn.stopped') {
      stopped = true;
    }
  });
  if (failure) throw refuse(502, `The agent's turn failed: ${failure}. The conversation is intact — open it in the Builder, or fetch ../conversations/${id}, to see which addon broke.`);

  const out = {
    conversationId: id,
    reply: replies.join('\n\n'),
    messageId,
    ...(stopped ? { stopped: true } : {}),
  };

  // Everything below is a convenience on top of the reply text: what the
  // turn did, read from the same export the Builder's Export button uses.
  // Never let it fail the turn — the reply is already in the system.
  try {
    const data = await exportConversation({ conversationId: id, include: 'outputs' });
    const last = [...((data && data.messages) || [])].reverse().find(m => m.role === 'assistant');
    if (last) {
      if (last.crew) out.crew = last.crew;
      const runs = last.addonRuns || [];
      const written = runs.flatMap(r => r.fieldWrites || []);
      if (written.length) out.fieldsWritten = written;
      const moved = runs.map(r => r.transition).filter(Boolean);
      if (moved.length) out.transition = moved[moved.length - 1];
      out.addons = runs.map(r => ({ label: r.label, pluginId: r.pluginId, lane: r.lane, status: r.status }));
    }
  } catch (err) {
    console.warn('[builder-mcp] turn digest failed:', err.message);
  }
  return out;
}

// ─── State ─────────────────────────────────────────────────────────

/** Fields / memory / thinking and the current crew — any conversation. */
async function readState({ conversationId }) {
  const id = Number(conversationId);
  if (!Number.isInteger(id) || id <= 0) throw refuse(400, 'The conversation id is a number.');
  const d = drizzle();
  const [conv] = await d.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!conv) throw refuse(404, `No conversation ${conversationId}.`);
  const meta = conv.metadata || {};
  if (!meta.agentSlug) throw refuse(404, `Conversation ${conversationId} is not a Builder conversation.`);
  const [user] = await d.select().from(users).where(eq(users.id, conv.userId)).limit(1);
  if (!user || !user.externalId) throw new Error('the conversation has no owner');

  const version = (meta.simulation && meta.simulation.version) || 'active';
  const res = await fetch(selfUrl(
    `/api/agents/${encodeURIComponent(meta.agentSlug)}/conversations/${id}/memory`
    + `?ownerUserId=${encodeURIComponent(user.externalId)}&version=${version}`,
  ));
  const memory = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(memory.error || `could not read the memory (${res.status})`);

  let crew = null;
  const project = await builderProjects.hydrateProject({ agentSlug: meta.agentSlug });
  const agent = project && project.agents[0];
  if (agent) {
    const crewId = meta.currentCrewId || agent.defaultCrewId;
    const c = (agent.crews || []).find(x => x.id === crewId);
    if (c) crew = { id: c.id, name: c.name };
  }
  return { conversationId: id, agent: meta.agentSlug, kind: meta.kind || null, crew, ...memory };
}

// ─── The simulated user ────────────────────────────────────────────

const USER_PROMPT = `You are role-playing a PERSON who is chatting with a company's AI assistant. You are the customer / end user — never the assistant.

Write ONLY this person's next message in the chat.

Rules:
- Stay in character: their situation, knowledge, mood and way of writing.
- Write the way real people type in a chat: short, natural, in the language the persona would use (if the conversation is already in a language, keep it).
- Answer what the assistant asked the way this person would — including vague, partial or off-topic answers if that fits them.
- Pursue the person's goal, but do not volunteer everything at once.
- Never mention that you are an AI, a test or a simulation. Never write the assistant's lines.
- Set "done" to true when this person would naturally stop: the goal is reached, they got what they needed, they gave up, or the conversation is clearly over. Then "text" is their closing message (it may be an empty string if they would simply leave).

Return JSON only: {"text": "<the message>", "done": true|false}`;

/**
 * @param {object} a
 * @param {string} a.persona   who the user is
 * @param {string} [a.goal]    what they want out of the conversation
 * @param {number|string} [a.conversationId] take the transcript from here…
 * @param {Array<{role:string,text:string}>} [a.transcript] …or pass it
 * @param {string} [a.model]   any id from GET /api/models; default EVERYDAY_MODEL
 */
async function userReply({ persona, goal, conversationId, transcript, model }) {
  const who = String(persona || '').trim();
  if (!who) throw refuse(400, 'Send { "persona": "who the user is — age, situation, mood, how they write" }.');

  const modelId = model ? String(model).trim() : models.EVERYDAY_MODEL;
  if (!models.getModel(modelId)) {
    const ids = models.MODELS.map(m => m.id).join(', ');
    throw refuse(400, `Unknown model "${modelId}". Leave "model" out to use ${models.EVERYDAY_MODEL}, or pick one of: ${ids}.`);
  }

  let turns = [];
  if (conversationId != null && conversationId !== '') {
    const data = await exportConversation({ conversationId, include: 'messages' });
    if (!data) throw refuse(404, `No conversation ${conversationId}.`);
    turns = (data.messages || []).map(m => ({ role: m.role, text: m.text }));
  } else if (Array.isArray(transcript)) {
    turns = transcript.map(m => ({ role: m && m.role, text: m && (m.text ?? m.content) }));
  }
  turns = turns.filter(m => (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim());

  await countUse('userReplies', DAILY_USER_REPLY_CAP);

  const lines = turns.map(m => `${m.role === 'user' ? 'PERSON' : 'ASSISTANT'}: ${m.text}`).join('\n\n');
  const input = [
    `## The person you are playing\n${who}`,
    goal ? `## What they want\n${String(goal).trim()}` : '',
    lines ? `## The conversation so far\n${lines}` : '## The conversation so far\n(nothing yet — write the opening message)',
    'Write the PERSON\'s next message now.',
  ].filter(Boolean).join('\n\n');

  const raw = await llmService.sendOneShot(USER_PROMPT, input, {
    model: modelId,
    maxTokens: 600,
    jsonOutput: true,
    context: 'mcp_simulated_user',
  });
  const rawText = typeof raw === 'string' ? raw : (raw && (raw.text ?? raw.content)) ?? '';
  let parsed = null;
  try { parsed = typeof raw === 'object' && raw && 'done' in raw ? raw : JSON.parse(String(rawText).replace(/^```(?:json)?|```$/g, '').trim()); } catch { parsed = null; }
  if (!parsed || typeof parsed.text !== 'string') {
    // The model answered in prose — that prose is the message.
    const text = String(rawText).trim();
    if (!text) throw new Error('the model returned nothing');
    return { text, done: false, model: modelId };
  }
  return { text: parsed.text.trim(), done: parsed.done === true, model: modelId };
}

module.exports = { startConversation, sendMessage, readState, userReply, VERSIONS };
