/**
 * HQ — the brand kit, read from the codebase.
 *
 * The colours and the logo are already the single source of truth in
 * `aspect-react-client/src/hq/hq.css` and `public/img/`. Nobody is going to
 * remember to paste them into Notion, and a copy in a prompt goes stale the
 * first time a token changes — so a worker reads the real files instead.
 *
 * Assets are uploaded to Leonardo once and the reference id cached, so a
 * generation can take actual colour cues from our logo rather than being told
 * about it in words.
 */

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', '..', '..', 'aspect-react-client');
const TOKENS_FILE = path.join(CLIENT, 'src', 'hq', 'hq.css');
const IMG_DIR = path.join(CLIENT, 'public', 'img');

/** Logos worth handing an image model, in the order they'd normally be reached for. */
const ASSETS = [
  { key: 'logo', file: 'lybi-logo-transparent.png', about: 'The Lybi wordmark, transparent background' },
  { key: 'spiral', file: 'lybi-spiral.png', about: 'The Lybi spiral mark on its own' },
];

/**
 * Pull the palette straight out of the stylesheet.
 *
 * Parsed rather than copied so the two can never disagree: change a token in
 * the CSS and the next generation uses the new colour with no other edit.
 */
function palette() {
  const wanted = {
    '--mag': 'magenta', '--pur': 'purple', '--pur2': 'purple-mid',
    '--ink': 'ink', '--grad': 'gradient',
  };
  const out = {};
  try {
    const css = fs.readFileSync(TOKENS_FILE, 'utf8');
    for (const [token, name] of Object.entries(wanted)) {
      const hit = css.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
      if (hit) out[name] = hit[1].trim();
    }
  } catch {
    // A missing stylesheet must not take the worker down; it just loses colour.
  }
  return out;
}

function assets() {
  return ASSETS
    .map(a => ({ ...a, path: path.join(IMG_DIR, a.file) }))
    .filter(a => fs.existsSync(a.path));
}

function assetBuffer(key) {
  const found = assets().find(a => a.key === key);
  if (!found) throw new Error(`No brand asset called "${key}"`);
  return fs.readFileSync(found.path);
}

/** Leonardo reference ids, cached — uploading the same logo every time is wasteful. */
const uploaded = new Map();

async function referenceId(key) {
  if (uploaded.has(key)) return uploaded.get(key);
  const leonardo = require('./leonardo.service');
  const id = await leonardo.uploadReference(assetBuffer(key), 'png');
  uploaded.set(key, id);
  return id;
}

/** Everything a worker needs to stay on-brand, as plain readable text. */
function summary() {
  const colours = palette();
  const available = assets();
  return {
    colours,
    fonts: ["Assistant (Hebrew and Latin)", "JetBrains Mono (code, labels)"],
    assets: available.map(a => ({ key: a.key, about: a.about })),
    notes:
      'These come from the live stylesheet and image folder, so they are current by ' +
      'definition. Pass an asset key to generate_image as brand_reference to let the ' +
      'model take real colour cues from the logo instead of being described it.',
  };
}

module.exports = { palette, assets, assetBuffer, referenceId, summary };
