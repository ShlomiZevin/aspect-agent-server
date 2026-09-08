/**
 * Re-render the approved Otto in new colours, holding his design.
 *
 * WHY THIS EXISTS. Asking the generator for "the same robot but orange" does
 * not produce the same robot. It produced a different one: the collared suit
 * became a plain tunic, the pose changed, the legs read as mechanical rather
 * than as staff. Text prompts do not recolour; they re-imagine.
 *
 * So this passes the APPROVED render back in as an image reference and asks
 * only for the colour change. `referenceStrength: 'MID'` is the whole trick —
 * leonardo.service.js documents that LOW keeps a reference as a colour hint
 * while MID and above make the model actually redraw it, which is backwards
 * from what we want in every other case and exactly right here: we want the
 * drawing preserved and the colour replaced.
 *
 * IT WILL STILL DRIFT SOMEWHAT. Compare against the reference before shipping,
 * and re-run rather than accepting a figure that is merely close.
 *
 * Usage:
 *   cd aspect-agent-server
 *   node scripts/recolour-otto.js
 *   node scripts/recolour-otto.js --strength HIGH --out v-colleague-orange.png
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const leonardo = require('../hq/services/leonardo.service');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OTTO_DIR = path.join(__dirname, '..', '..', 'aspect-react-client', 'public', 'otto');
const REFERENCE = arg('--ref', path.join(OTTO_DIR, 'v-colleague-approved.jpg'));
const OUT = path.join(OTTO_DIR, arg('--out', 'v-colleague.png'));
const STRENGTH = arg('--strength', 'MID');
const MODEL = arg('--model', 'nano-banana-pro');
// Otto wears INK, not the accent. GPT-5.6's rule: burnt orange marks
// interaction — buttons, links, focus, the current selection — and Otto is an
// indicator, not a control. A character dressed in the interaction colour
// quietly says "click me". See docs/design/otto-centre-answer.md.
const ACCENT = arg('--accent', '#18201B');
const INDICATOR = arg('--indicator', '#F6F7F4');

const PROMPT = `Recreate this exact character with one change: every accent that is currently purple, violet or orange becomes near-black ${ACCENT}.

Keep everything else identical — the same pose, the same three-quarter stance, the same proportions, the same collared uniform with its lapels and collar, the same lanyard around the neck with the blank card hanging from it, the same cuffs, the same blank panel held in the hand, the same legs and shoes, the same head shape.

The lanyard, the cuffs and any trim are near-black ${ACCENT}. The shell stays white and light warm grey. The face panel is near-black ${ACCENT}, and the single slim horizontal indicator line across it is LIGHT off-white ${INDICATOR} so it reads clearly against the dark panel.

Clean 3D product render, soft even studio lighting, matte surfaces, no reflections.
Pure flat white #FFFFFF background, completely even, no gradient, no vignette, no floor shadow, no cast shadow.
Full figure, centred, generous margin on all sides, nothing cropped.
No text, no letters, no numbers, no logos, no watermark.
No human face, no eyes, no pupils, no mouth, no facial expression.
No glow, no neon, no light bloom, no holograms, no energy effects.
No orange, no purple, no violet, no coloured accents of any kind.
Not cute, not a toy, not a mascot.`;

async function main() {
  if (!leonardo.isConfigured || !leonardo.isConfigured()) {
    console.error('LEONARDO_API_KEY is not set — run this from aspect-agent-server.');
    process.exit(1);
  }
  if (!fs.existsSync(REFERENCE)) {
    console.error(`Reference not found: ${REFERENCE}`);
    process.exit(1);
  }

  const ext = path.extname(REFERENCE).slice(1).toLowerCase() || 'png';
  console.log(`\n  Reference: ${path.basename(REFERENCE)} · strength ${STRENGTH} · accent ${ACCENT}\n`);

  process.stdout.write('  uploading reference … ');
  const referenceImageId = await leonardo.uploadReference(fs.readFileSync(REFERENCE), ext === 'jpg' ? 'jpg' : ext);
  console.log('ok');

  process.stdout.write('  generating … ');
  const result = await leonardo.generate({
    prompt: PROMPT,
    model: MODEL,
    size: 'square',
    quantity: 1,
    referenceImageId,
    referenceStrength: STRENGTH,
  });

  const url = result.images[0];
  if (!url) throw new Error('completed with no image');
  const buffer = await leonardo.download(url);
  fs.writeFileSync(OUT, buffer);
  console.log(`ok — ${(buffer.length / 1024).toFixed(0)}kb, ${result.width}x${result.height}`);
  console.log(`\n  written to public/otto/${path.basename(OUT)}`);
  if (result.cost) console.log(`  Quoted cost: ${Number(result.cost).toFixed(3)} credits`);
  console.log(`\n  Then cut the background:\n    python scripts/cutout-figure.py ../aspect-react-client/public/otto/${path.basename(OUT)}\n`);
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
