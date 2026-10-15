/**
 * Plain, readable download URLs for data files a client's BI loads from us:
 *
 *   https://aspect-agents.web.app/<client>/intelligence/data/<name>
 *
 * Open on purpose - no key (Shlomi, 2026-10-15): Reut found the tokenised
 * /zolstock/creative-stock/<token>/... link too hard to work with. Anyone who
 * knows the address can download the file, so only register data here that
 * the client is fine to have readable that way. The tokenised link keeps
 * working alongside it.
 *
 * Each entry returns a short-lived signed storage URL and the route answers
 * with a 302 to it: the files are ~1 GB, past Hosting's 60s proxy limit.
 * A trailing ".csv" on the name is accepted, for tools that want an extension.
 *
 * Mounted at the root (one line in server.js); Hosting proxies the path from
 * aspect-agents.web.app (scripts/firebase-aspect-config.cjs in the client).
 */

const express = require('express');

const router = express.Router();

const DATA = {
  zolstock: {
    // Creative daily store inventory (tasks #106 / #107), rebuilt nightly.
    'creative-stock': () => require('../services/creative-inventory-export.service').signedDownloadUrl(),
  },
};

router.get('/:client/intelligence/data/:name', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const name = req.params.name.replace(/\.csv$/i, '');
  const source = Object.hasOwn(DATA, req.params.client) && Object.hasOwn(DATA[req.params.client], name)
    ? DATA[req.params.client][name]
    : null;
  if (!source) return res.status(404).type('text/plain').send('No such data file.');
  try {
    const url = await source();
    if (!url) return res.status(503).type('text/plain').send('This file is not built yet. Try again later.');
    res.redirect(302, url);
  } catch (err) {
    console.error(`❌ intelligence data ${req.params.client}/${name} error:`, err.message);
    res.status(500).type('text/plain').send('Could not serve this file right now.');
  }
});

module.exports = router;
