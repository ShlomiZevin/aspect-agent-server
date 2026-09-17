/**
 * aiBundleRoute — the platform's own source, served to an AI assistant
 * running on the user's machine.
 *
 * WHY THIS EXISTS. Someone building agents with their own AI needs that
 * assistant to read how the platform actually behaves — the prompt
 * assembler, the validator, the plugin implementations, the real types.
 * Handing it only a written summary reproduces Alfred's limitation: an
 * assistant reasoning about a description of the system instead of the
 * system.
 *
 * WHY NOT GIT. A repository cannot be granted per-path; whoever can clone
 * it gets all of it, and sparse-checkout is a client-side convenience the
 * user can switch off. Serving a declared list of files is the only way
 * to make "only the Builder V2 parts" an actual boundary rather than a
 * convention — and it removes git, a GitHub account and a clone step from
 * a non-developer's setup.
 *
 * WHY NOT A ZIP. The whole set is ~1.3 MB of text. The client already
 * holds a File System Access handle to the user's folder (see
 * folderDrafts.ts), so it writes the files straight in with their real
 * paths — nothing to unzip, and no chance of the paths being flattened,
 * which would break every pointer in the instructions file.
 *
 * The version is a hash of the contents, so it maintains itself: deploy
 * new code and every existing copy reads as stale with nobody having to
 * remember to bump anything.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

const ROOT = path.join(__dirname, '..', '..');

/**
 * What goes in. Deliberately a declared list, not a directory sweep:
 * every addition is a decision about what someone outside this codebase
 * may read.
 *
 * Excluded on purpose — server routes, `services/` (customer data, LLM
 * keys, billing), `hq/`, every other product, and the internal process
 * notes in docs/guides that describe how we work rather than how the
 * product works.
 */
const MANIFEST = [
  // How an agent actually runs.
  { dir: 'builder/runtime',  match: /\.js$/,            recursive: true },
  { dir: 'builder/plugins',  match: /\.js$/,            recursive: true },
  { dir: 'builder/triggers', match: /\.(js|json)$/,     recursive: true },
  // What an agent is made of.
  { dir: 'builder/addons',   match: /\.addon\.json$/ },
  { dir: 'builder/types',    match: /\.ts$/ },
  { dir: 'builder/services', match: /\.js$/ },
  // The endpoints an assistant actually calls — better it reads the real
  // handler than trusts a description of it.
  { dir: 'builder/routes',   match: /\.js$/ },
  { file: 'builder/promptPlaceholders.json' },
  // The rules that decide whether a body is legal, and the single best
  // prose description of the platform (Alfred's own system prompt).
  { dir: 'alfred/services',  match: /\.js$/ },
  // Background and worked examples.
  // `BUILDER_V2.*` sweeps in three internal process notes that describe
  // how WE work rather than how the product works — and which the
  // instructions file already tells an assistant to ignore. Named here
  // so the exclusion is visible rather than hidden in a cleverer regex.
  {
    dir: 'docs/guides',
    match: /^(BUILDER_V2.*|AGENT_BUILDING_GUIDE|AGENT_BUILDING_INSTRUCTIONS)\.md$/,
    exclude: /^(BUILDER_V2_BACKLOG|BUILDER_V2_NEXT_SESSION_PROMPT|BUILDER_V2_PHASE_B_ALFRED_HANDOFF)\.md$/,
  },
];

/** Recursively collect files under one manifest entry. */
function collectDir(relDir, match, recursive, out, exclude) {
  const abs = path.join(ROOT, relDir);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch { return; } // a folder that does not exist is not fatal
  for (const e of entries) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      if (recursive) collectDir(rel, match, recursive, out);
      continue;
    }
    if (match && !match.test(e.name)) continue;
    if (exclude && exclude.test(e.name)) continue;
    try { out.push({ path: rel, content: fs.readFileSync(path.join(ROOT, rel), 'utf8') }); }
    catch { /* unreadable file — skip rather than fail the bundle */ }
  }
}

function collect() {
  const out = [];
  for (const entry of MANIFEST) {
    if (entry.file) {
      try { out.push({ path: entry.file, content: fs.readFileSync(path.join(ROOT, entry.file), 'utf8') }); }
      catch { /* skip */ }
    } else {
      collectDir(entry.dir, entry.match, !!entry.recursive, out, entry.exclude);
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  const hash = crypto.createHash('sha256');
  for (const f of out) hash.update(f.path).update('\0').update(f.content).update('\0');
  return { version: hash.digest('hex').slice(0, 12), files: out };
}

/**
 * Cached because the version endpoint is polled and the files cannot
 * change under a running container — the image is immutable. Short TTL
 * so local development still reflects edits without a restart.
 */
let cache = null;
const TTL_MS = 60 * 1000;

function bundle() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = collect();
  cache = { at: Date.now(), value };
  return value;
}

/**
 * GET /api/builder/ai-bundle/version
 *   Just the hash. What the Builder compares against the stamp in the
 *   user's folder to tell them their copy has gone stale.
 */
router.get('/version', (_req, res) => {
  try {
    res.json({ version: bundle().version });
  } catch (err) {
    console.error('[ai-bundle] version failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/builder/ai-bundle
 *   Every file, with its repo-relative path. The client writes these
 *   into the user's folder verbatim — the paths matter, because the
 *   instructions file refers to files by exactly these names.
 */
router.get('/', (_req, res) => {
  try {
    const { version, files } = bundle();
    res.json({
      version,
      generatedAt: new Date().toISOString(),
      fileCount: files.length,
      files,
    });
  } catch (err) {
    console.error('[ai-bundle] build failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
