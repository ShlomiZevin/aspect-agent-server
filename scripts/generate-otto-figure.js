/**
 * Otto's figure — the character customers meet.
 *
 * WHY IT EXISTS, AND WHY IT IS A DELIBERATE OVERRIDE. GPT-5.6 was asked
 * whether Otto should have a character and said no: a robot turns an
 * approval-based operational tool into a consumer AI product and gets
 * irritating by the tenth session (docs/design/otto-identity-answer.md §B).
 * That argument is about the WORKING interface and it is why the figure is
 * kept small and confined to the empty state, never beside every message and
 * never inside a built screen. Shlomi overrode the rejection for a different
 * reason: Otto is the customer's AI colleague — their dev, their BI person,
 * their IT — and a face for that is worth having, in the product and later in
 * marketing.
 *
 * So: a figure exists, and the restraint stays.
 *
 * WHAT IT MUST NOT BE. Not a cute mascot, not a toy, not a glowing sci-fi
 * android, not a humanoid with a face. It reads as a competent technical
 * colleague — the same register as the product: calm, precise, unremarkable in
 * the way good tools are.
 *
 * Usage:
 *   cd aspect-agent-server
 *   node scripts/generate-otto-figure.js
 *   node scripts/generate-otto-figure.js --only portrait --model gpt-image-2
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const leonardo = require('../hq/services/leonardo.service');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MODEL = arg('--model', 'nano-banana-pro');
const ONLY = arg('--only', '').split(',').map(s => s.trim()).filter(Boolean);
const OUT_DIR = path.join(__dirname, '..', '..', 'aspect-react-client', 'public', 'otto');

/**
 * The shared tail. The palette lock matters more here than it did for the
 * pitch photography: this figure sits inside a live interface built on
 * #6D28D9, and a character in the wrong purple looks like a sticker someone
 * pasted on.
 */
const LOOK = `
Clean 3D render, soft studio lighting, matte surfaces, no reflections, gentle ambient occlusion.
Palette: white and light warm grey body, deep violet #6D28D9 accents only, near-black #241A38 details, background pure white #FFFFFF.
Centred, full figure visible with generous margin, nothing cropped.
No text, no letters, no numbers, no logos, no watermark, no signature, no UI, no screens showing charts.
No human face, no eyes with pupils, no mouth, no teeth, no cartoon expression, no smile.
No glowing edges, no neon, no lens flare, no holograms, no circuit-board patterns, no sparks, no energy effects.
No cyberpunk, no dystopian, no weapons, no armour, no muscles, no gendered body.
Not cute, not a toy, not a mascot, not chibi, not a children's character.
`.trim();

const FIGURES = [
  {
    key: 'otto',
    about: 'The primary figure. Used small in the empty state, and in marketing.',
    prompt: `A friendly, professional service robot standing calmly, three-quarter view, facing slightly to the left. Smooth rounded white shell, matte, with a single deep violet band across the chest and violet joints at the shoulders. Its head is a simple rounded rectangle with a dark seamless panel where a face would be — a soft slim violet horizontal light bar across it, calm and steady, indicating attention rather than emotion. Proportions are grounded and adult: a capable colleague, not a pet. One arm relaxed at its side, the other holding a plain flat panel like a clipboard, blank and unmarked. Simple stable base instead of detailed feet. ${LOOK}`,
  },
  {
    key: 'otto-portrait',
    about: 'Head and shoulders. For an avatar crop if the figure ever needs one.',
    prompt: `Head and shoulders of a friendly professional service robot, front view, centred. Smooth rounded white matte shell. The head is a simple rounded rectangle with a dark seamless panel where a face would be, crossed by one calm slim horizontal deep violet light bar. A single violet band across the top of the shoulders. Nothing else. Plenty of white space around the head. ${LOOK}`,
  },
  {
    key: 'otto-working',
    about: 'The build state, if the empty-state figure ever gains a second pose.',
    prompt: `A friendly professional service robot in profile, leaning slightly forward and working with both hands on a plain flat blank panel held in front of it, as if assembling something. Smooth rounded white matte shell, deep violet joints and one violet chest band. Head is a rounded rectangle with a dark seamless panel and one calm slim horizontal violet light bar. Focused and unhurried posture. ${LOOK}`,
  },
];

async function main() {
  if (!leonardo.isConfigured || !leonardo.isConfigured()) {
    console.error('LEONARDO_API_KEY is not set — run this from aspect-agent-server so .env is picked up.');
    process.exit(1);
  }

  const wanted = ONLY.length ? FIGURES.filter(f => ONLY.includes(f.key)) : FIGURES;
  if (!wanted.length) {
    console.error(`No figure matched --only "${ONLY.join(',')}". Known: ${FIGURES.map(f => f.key).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n  Generating ${wanted.length} figure(s) with ${MODEL} into public/otto/\n`);

  let spent = 0;
  for (const fig of wanted) {
    process.stdout.write(`  ${fig.key} … `);
    try {
      // Square: the figure is centred and gets cropped to whatever the surface
      // needs, so a fixed aspect would only throw pixels away.
      const result = await leonardo.generate({ prompt: fig.prompt, model: MODEL, size: 'square', quantity: 1 });
      const url = result.images[0];
      if (!url) throw new Error('completed with no image');
      const buffer = await leonardo.download(url);
      fs.writeFileSync(path.join(OUT_DIR, `${fig.key}.png`), buffer);
      spent += Number(result.cost || 0);
      console.log(`ok — ${(buffer.length / 1024).toFixed(0)}kb, ${result.width}x${result.height}`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  console.log(`\n  written to aspect-react-client/public/otto/`);
  if (spent) console.log(`  Quoted cost: ${spent} credits`);
  console.log('  Referenced by the page as /otto/<key>.png\n');
}

main().catch(err => { console.error(err); process.exit(1); });
