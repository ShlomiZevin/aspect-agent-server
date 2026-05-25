/**
 * Alfred — chat CRUD + streaming endpoint.
 *
 * Mounted at /api/builder/alfred.
 *
 * Endpoints (P5.1 — brainstorm only):
 *   POST   /chats                                       create chat
 *   GET    /chats?agentSlug&ownerUserId                 list chats
 *   PATCH  /chats/:chatId                               rename
 *   DELETE /chats/:chatId                               delete
 *   GET    /chats/:chatId/messages                      history
 *   POST   /chats/:chatId/messages   (SSE)              send message
 *
 * P5.2 will add /chats/:chatId/messages/:msgId/apply (proposal apply).
 * P5.3 will add agent spec + change log endpoints.
 */

const express = require('express');
const alfredChats = require('../services/alfredChats');
const alfredRunner = require('../services/alfredRunner');

const router = express.Router();

// ─── Chat CRUD ────────────────────────────────────────────────────

router.post('/chats', async (req, res) => {
  try {
    const { agentSlug, ownerUserId } = req.body || {};
    if (!agentSlug)   return res.status(400).json({ error: 'Missing agentSlug' });
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const created = await alfredChats.createChat({ agentSlug, ownerUserId });
    res.json({ chatId: created.id });
  } catch (err) {
    console.error('[alfred] POST /chats failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/chats', async (req, res) => {
  try {
    const { agentSlug, ownerUserId } = req.query;
    if (!agentSlug)   return res.status(400).json({ error: 'Missing agentSlug' });
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const chats = await alfredChats.listChats({
      agentSlug:   String(agentSlug),
      ownerUserId: String(ownerUserId),
    });
    res.json({ chats });
  } catch (err) {
    console.error('[alfred] GET /chats failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/chats/:chatId', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (typeof name !== 'string') return res.status(400).json({ error: 'Missing name' });
    const updated = await alfredChats.renameChat(req.params.chatId, name);
    if (updated === null) return res.status(404).json({ error: 'Chat not found' });
    res.json({ ok: true, name: updated });
  } catch (err) {
    console.error('[alfred] PATCH /chats/:id failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/chats/:chatId', async (req, res) => {
  try {
    await alfredChats.deleteChat(req.params.chatId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[alfred] DELETE /chats/:id failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Messages ─────────────────────────────────────────────────────

router.get('/chats/:chatId/messages', async (req, res) => {
  try {
    const chat = await alfredChats.getChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const messages = await alfredChats.listMessages(req.params.chatId);
    res.json({ messages });
  } catch (err) {
    console.error('[alfred] GET messages failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/chats/:chatId/messages', async (req, res) => {
  const { chatId } = req.params;
  const { ownerUserId, userMessage, agentSlug } = req.body || {};

  if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
  if (!userMessage) return res.status(400).json({ error: 'Missing userMessage' });
  if (!agentSlug)   return res.status(400).json({ error: 'Missing agentSlug' });

  // SSE headers — same shape the runtime route uses.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write(':ok\n\n');
  if (res.flush) res.flush();

  const emit = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    const chat = await alfredChats.getChat(chatId);
    if (!chat) {
      emit('alfred.error', { error: { code: 'chat_not_found', message: 'Chat not found' } });
      return res.end();
    }

    // Persist the user's turn first so we have an id to emit and so
    // the runner sees it when it loads history.
    const userMsg = await alfredChats.appendMessage({
      chatId,
      role:    'user',
      content: userMessage,
    });

    // Auto-name the chat on its first user message — reads better in
    // the history list than "Chat #N". Mirrors the user-chat behaviour.
    await alfredChats.setChatNameIfBlank(chatId, userMessage);

    emit('conversation', { chatId: Number(chatId), messageId: userMsg.id });

    // Signal the client to open an empty assistant bubble. The real
    // server-side id arrives in `alfred.message` after the run.
    emit('alfred.start', {});

    // Run the brainstorm turn. The runner reads history from the DB —
    // the last row is the user message we just inserted, exactly what
    // it wants.
    const { assistantText } = await alfredRunner.runBrainstormTurn({
      chatId:         Number(chatId),
      agentSlug,
      ownerUserId,
      emit,
    });

    // Persist the assistant message only when there's content. Empty
    // replies (network drop, refusal, etc.) leave nothing behind — no
    // ghost rows to clean up.
    if (assistantText && assistantText.trim().length > 0) {
      const asstMsg = await alfredChats.appendMessage({
        chatId,
        role:    'assistant',
        content: assistantText,
      });
      emit('alfred.message', { messageId: asstMsg.id, text: assistantText });
    }

    emit('done', { totalMs: 0 });
    res.end();
  } catch (err) {
    console.error('[alfred] POST messages failed:', err);
    emit('alfred.error', { error: { code: 'runtime_failed', message: err.message } });
    res.end();
  }
});

module.exports = router;
