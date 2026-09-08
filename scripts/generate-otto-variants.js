/**
 * Otto, five ways — so there is something to choose between.
 *
 * The first render was approved as "not bad", with one note: it should feel
 * like a TECHY GUY. Shlomi's framing, which is the brief:
 *
 *   "The robot is the tech person you used to have to have — and now this
 *    is him."
 *
 * So these are not five styles of the same robot. Each is a different reading
 * of what a technical colleague looks like: the field technician, the analyst,
 * the engineer, the one who is almost a person, and the one who is barely a
 * body at all. Pick by which one you would want standing in your rail all day,
 * not by which renders prettiest.
 *
 * WHERE HE ENDS UP. A 72px portrait in a status well, and later in marketing.
 * At that size silhouette is everything and detail is noise — which is why
 * every prompt below fixes the pose, keeps the hands readable, and refuses
 * surface clutter.
 *
 * THE LINES NONE OF THEM CROSS. No face, no eyes, no mouth: a face invites
 * emotional response from a tool that reports status, and it is what makes a
 * mascot wear out. No glow, no neon, no holograms — the product's whole claim
 * is that it is checkable, and sci-fi lighting undercuts that. Nothing cute.
 *
 * Usage:
 *   cd aspect-agent-server
 *   node scripts/generate-otto-variants.js
 *   node scripts/generate-otto-variants.js --only technician,analyst
 *
 * Then cut the backgrounds:
 *   python scripts/cutout-figure.py ../aspect-react-client/public/otto/v-technician.png
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
 * Otto's accent, and the only place it is written down. Burnt orange #B54708 —
 * the colour of receiving labels and warehouse marking tape, per the palette in
 * docs/design/otto-palette-answer.md. It replaced violet because violet said
 * "AI" and this says "the work happened here".
 */
const ACCENT = arg('--accent', '#B54708');

/**
 * Pure white background is not a style choice — scripts/cutout-figure.py keys
 * it out by flooding in from the border, and a gradient or a shadow on the
 * floor is what makes that leave a halo.
 */
const LOOK = `
Clean 3D product render, soft even studio lighting, matte surfaces, no reflections.
Pure flat white #FFFFFF background, completely even, no gradient, no vignette, no floor shadow, no cast shadow.
Full figure, standing, centred, generous margin on all sides, nothing cropped.
Palette: white and light warm grey shell, burnt orange ${ACCENT} accents only, near-black #18201B details.
No text, no letters, no numbers, no logos, no watermark, no signature.
No human face, no eyes, no pupils, no mouth, no eyebrows, no facial expression.
No glow, no neon, no light bloom, no lens flare, no holograms, no floating particles, no circuit-board patterns, no energy effects.
No cyberpunk, no dystopia, no weapons, no armour, no muscles, no gendered body.
Not cute, not a toy, not a mascot, not chibi, not a children's character.
`.trim();

const VARIANTS = [
  {
    key: 'v-technician',
    about: 'The field technician. The one who actually fixes things.',
    prompt: `A professional service robot standing squarely, three-quarter view. Sturdy white matte shell with visible panel seams and hex fasteners, burnt orange ${ACCENT} shoulder joints and an orange band low on the torso like a utility belt. Head is a wide rounded rectangle with a dark seamless panel and one calm slim horizontal burnt orange ${ACCENT} indicator line. A compact tool module clipped to its hip. Broad shoulders, planted stance, capable and unglamorous. Two articulated arms, hands relaxed and clearly readable in silhouette. Simple flat base. ${LOOK}`,
  },
  {
    key: 'v-analyst',
    about: 'The BI person. Holds the report, waits for you to ask.',
    prompt: `A professional service robot standing calmly, three-quarter view, holding a plain flat tablet panel in one hand at chest height, blank and unmarked. Slim white matte shell, narrow torso, burnt orange ${ACCENT} at the elbows and one thin orange line down the centre of the chest. Head is a tall rounded rectangle with a dark seamless panel and one calm slim horizontal burnt orange ${ACCENT} indicator line, tilted very slightly as if listening. Composed and attentive posture. Simple flat base. ${LOOK}`,
  },
  {
    key: 'v-engineer',
    about: 'The builder. Structural, mechanical, obviously makes things.',
    prompt: `A professional service robot standing, three-quarter view, arms slightly forward and open as if mid-explanation. White matte shell over a visible dark grey articulated frame at the joints and midsection, so the mechanism reads as engineered rather than moulded. Burnt orange ${ACCENT} accents on the shoulder and hip joints only. Head is a compact rounded rectangle with a dark seamless panel and one calm slim horizontal burnt orange ${ACCENT} indicator line. Precise, mechanical, well made. Simple flat base. ${LOOK}`,
  },
  {
    key: 'v-colleague',
    // CHOSEN, 2026-09-08. Shlomi picked this one. It is the only variant that
    // reads as STAFF rather than equipment — a suit, a lanyard, legs instead of
    // a base — which is the whole point: "the tech person you used to have to
    // have, and now this is him." Re-render it in the final palette accent
    // once that is settled; everything else about it stays.
    about: 'CHOSEN. Almost a person. Reads as staff rather than equipment.',
    prompt: `A professional service robot with humanlike proportions standing relaxed, three-quarter view, one hand at its side and the other holding a slim blank panel. Smooth white matte shell shaped like a simple collared uniform, with a burnt orange ${ACCENT} band across the chest like a lanyard and orange at the wrists. Head is a softly rounded rectangle with a dark seamless panel and one calm slim horizontal burnt orange ${ACCENT} indicator line. Upright, easy, approachable but professional. Legs and feet rather than a base. ${LOOK}`,
  },
  {
    key: 'v-minimal',
    about: 'Barely a body. The most restrained thing that still reads as him.',
    prompt: `A very simple professional service robot, front view, reduced to essential forms: a rounded rectangular head with a dark seamless panel and one calm slim horizontal burnt orange ${ACCENT} indicator line, a smooth white capsule body with no visible seams, two short simple arms, and a rounded base. One thin burnt orange ${ACCENT} ring around the neck. Extremely clean and minimal, like a well-designed appliance. Nothing decorative anywhere. ${LOOK}`,
  },
];

async function main() {
  if (!leonardo.isConfigured || !leonardo.isConfigured()) {
    console.error('LEONARDO_API_KEY is not set — run this from aspect-agent-server so .env is picked up.');
    process.exit(1);
  }

  const wanted = ONLY.length ? VARIANTS.filter(v => ONLY.some(o => v.key.includes(o))) : VARIANTS;
  if (!wanted.length) {
    console.error(`No variant matched --only "${ONLY.join(',')}". Known: ${VARIANTS.map(v => v.key).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n  Generating ${wanted.length} variant(s) with ${MODEL}\n`);

  let spent = 0;
  const made = [];
  for (const v of wanted) {
    process.stdout.write(`  ${v.key.padEnd(14)} `);
    try {
      const result = await leonardo.generate({ prompt: v.prompt, model: MODEL, size: 'square', quantity: 1 });
      const url = result.images[0];
      if (!url) throw new Error('completed with no image');
      const buffer = await leonardo.download(url);
      fs.writeFileSync(path.join(OUT_DIR, `${v.key}.png`), buffer);
      spent += Number(result.cost || 0);
      made.push(v.key);
      console.log(`ok — ${(buffer.length / 1024).toFixed(0)}kb`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  console.log(`\n  ${made.length}/${wanted.length} written to public/otto/`);
  if (spent) console.log(`  Quoted cost: ${spent.toFixed(3)} credits`);
  if (made.length) {
    console.log('\n  Cut the backgrounds:');
    console.log(`    ${made.map(k => `python scripts/cutout-figure.py ../aspect-react-client/public/otto/${k}.png`).join('\n    ')}\n`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
