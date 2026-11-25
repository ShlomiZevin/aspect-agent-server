/**
 * The mock bank's API, mounted under /api/gate/mock-bank. Called by Lybi Gate
 * over real HTTP, exactly like a bank's own API would be.
 *
 *   GET  /public-key            the bank's public key (PEM) — what Lybi encrypts with
 *   POST /customers/lookup      Bearer <secret> · { ref, fields } → an invented customer answer
 *   POST /handoff               Bearer <secret> · { ref, fields } → which fields arrived and opened
 *   (both answer { ok: true } to { ping: true })
 */

const express = require('express');
const bank = require('./bank');

const router = express.Router();

function guard(handler) {
  return async (req, res) => {
    try {
      if (!(await bank.authorized(req.get('authorization')))) return res.status(401).json({ error: 'bad bank secret', code: 'unauthorized' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (body.ping) return res.json({ ok: true, bank: 'Lybi mock bank' });
      if (!body.fields || typeof body.fields !== 'object') return res.status(400).json({ error: 'send { ref, fields }', code: 'bad_request' });
      res.json(await handler(body));
    } catch (err) {
      console.error('[gate mock bank]', err.message);
      res.status(500).json({ error: 'mock bank error' });
    }
  };
}

router.get('/public-key', async (_req, res) => {
  try {
    const { publicKeyPem } = await bank.ensure();
    res.type('text/plain').send(publicKeyPem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/customers/lookup', guard(bank.lookup));
router.post('/handoff', guard(bank.handoff));

module.exports = router;
