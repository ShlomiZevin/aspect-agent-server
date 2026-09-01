/**
 * Generates the slide artwork for the ILLUSTRATED variant of the investor
 * pitch (client route /aspect/investors-pitch-visual).
 *
 * WHY THIS EXISTS. The real pitch (/aspect/investors-pitch) deliberately has
 * no imagery — GPT-5.6 was asked directly and said abstract AI imagery would
 * make it look like every other AI deck. That decision stands. This second
 * variant is a CAPABILITY DEMO: it exists to show a marketing colleague that
 * the whole slide — copy, layout and artwork — can be produced by AI end to
 * end. Do not merge the two.
 *
 * The prompts below are GPT-5.6's finished photographic brief, used verbatim
 * (docs/marketing/investor-deck-review-sections-6.md). Two rules are worth
 * knowing before editing any of them:
 *
 *   1. The left 36% of every frame is kept dark and empty on purpose. That
 *      is where the type sits, and it is why these run FULL BLEED with no
 *      scrim — the darkness is built into the photograph rather than painted
 *      over it afterwards.
 *   2. No dominant red or green object may appear in any scene. Red belongs
 *      to "WAITS." and green to "YES", and those two words only stay signals
 *      for as long as nothing else in the frame competes with them.
 *
 * An earlier version of this file asked for flat geometric shapes in the
 * deck's four colours, and got exactly that: a bar, a wedge, a rectangle. On
 * the page they read as more CSS lines than as pictures — "I don't see any
 * image". Scenes, not diagrams.
 *
 * THE SHIPPING TEST, from the same brief: hide the type and show the image
 * for two seconds. If the viewer says "generic warehouse photo" rather than
 * "someone to ask", "waiting for reports", "one base for many outcomes",
 * "many kinds of work", "scale" or "the one-off request" — reject it and
 * regenerate.
 *
 * Images are written straight into the client's public/ folder, which Vite
 * serves verbatim — so the page references them as plain absolute paths and
 * nothing has to be imported or bundled.
 *
 * Usage:
 *   cd aspect-agent-server
 *   node scripts/generate-pitch-images.js                 # all six
 *   node scripts/generate-pitch-images.js --only hero,ask # a subset
 *   node scripts/generate-pitch-images.js --model gpt-image-2
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
const OUT_DIR = path.join(__dirname, '..', '..', 'aspect-react-client', 'public', 'pitch');

// The brief calls for 16:9 and the service's SIZES map has no landscape pair,
// so the dimensions are passed explicitly. 1376x768 is 16:9 and both values are
// accepted (they are the story preset transposed); 1536x864 is rejected. It fails
// loudly per slide rather than silently returning squares.
const WIDTH = 1376;
const HEIGHT = 768;

const SLIDES = [
  {
    key: 'hero',
    about: 'Slide 1 — someone inside the business you can address.',
    prompt: 'Create a 16:9 landscape editorial documentary photograph inside a real retail stockroom before opening. An experienced retail operations manager stands in the far-right third of the frame, turning naturally toward an unseen colleague just beside the camera and speaking mid-sentence, with one hand in a small relaxed gesture. The person is clearly the customer, not a technician or consultant. Deep stockroom shelves, unbranded cartons and rolling retail cages recede behind them. Keep the entire left 36 percent of the frame dark, simple and uncluttered, using a shadowed wall and empty aisle as negative space for white typography. Full-frame camera at eye level, 50mm lens, f/2.8, realistic perspective and shallow but not extreme depth of field. Mixed cool fluorescent stockroom light with a faint warm dawn practical in the distance. Graphite and concrete-grey colour grade, restrained saturation, natural skin, deep black point, subtle photographic grain, tactile cardboard and worn concrete textures. The image must look like a physically plausible candid photograph, not a staged advertising portrait. Negative list: no screen, monitor, laptop, phone, tablet, dashboard, chart, graph, interface, hologram, robot, humanoid AI, glowing orb, neon science fiction, circuitry, abstract geometry, illustration, 3D render, CGI, collage, visible brand logo, readable text, watermark, consultant, engineer, smiling team, handshake, corporate stock-photo pose, dominant red object, dominant bright green object, clutter in the left third, centered subject.',
  },
  {
    key: 'wait',
    about: 'Slide 2 — the reporting ritual, not obsolete technology. Waiting made physical.',
    prompt: 'Create a 16:9 landscape editorial documentary photograph of a current-day retail back office trapped in a physical reporting ritual. On the right half of the frame, show tall shelves of thick ring binders, stacked monthly report packets, overflowing document trays, loose continuous paper, handwritten exception notes and the paper-output side of a high-volume office printer with its control panel completely out of view. One contemporary back-office employee waits motionless at the far right, hands still, neither theatrical nor distressed. The furniture and clothing must look current, not retro. Keep the left 36 percent dark and uncluttered for white typography. Keep the lower-right area relatively plain and dark, using the blank face of a filing cabinet and shadowed floor, so a giant red word can be added later. Full-frame camera at seated eye level, 50mm lens, f/4, slightly compressed perspective that makes the paper feel dense and airless. Flat overhead fluorescent lighting with weak daylight from a distant internal window. Cool grey-green colour grade, low saturation, realistic paper fibres, scuffed metal, dusty plastic and subtle grain. The image should make waiting feel physical. Negative list: no visible screen, monitor, laptop, phone, tablet, dashboard, chart, graph, pie chart, readable spreadsheet, legible report text, retro costume, sepia nostalgia, antique office comedy, fax-machine joke, robot, hologram, AI icon, abstract geometry, illustration, 3D render, CGI, collage, arrows, labels, visible brand logo, watermark, dramatic facial expression, smiling employee, corporate stock-photo pose, dominant red object, dominant bright green object, clutter in the left third, objects covering the lower-right typography area.',
  },
  {
    key: 'foundation',
    about: 'Slide 3 — one continuous surface carrying unlike loads. The belt IS the argument.',
    prompt: 'Create a 16:9 landscape editorial documentary photograph inside a working retail distribution centre. One single continuous dark rubber warehouse conveyor begins at 40 percent of the frame and runs uninterrupted from the lower middle into the right background. The conveyor surface must be broad, clearly visible and visually dominant. It carries several naturally spaced, visibly unrelated unbranded retail loads: an open crate of fresh flowers, a soft tote containing folded apparel, a shallow tray holding irregular metal hardware, a plain boxed small appliance and a reusable produce crate. Do not stack the objects and do not arrange them with perfect symmetry. The different loads must all touch and share the same continuous conveyor surface. Keep the left 36 percent of the frame dark, empty and uncluttered for white typography. Camera positioned low, approximately 40 centimetres above the conveyor, full-frame camera, 28mm lens, f/5.6, strong foreground depth and realistic industrial scale. Use raking side light from high warehouse windows to reveal the worn rubber surface as one connected plane, with soft overhead industrial fill. Cool neutral graphite colour grade, restrained product colours, deep shadows, realistic dust, rubber, steel and cardboard texture, fine photographic grain. This must look like a real operational photograph, not a visual metaphor assembled in software. Negative list: no diagram, flowchart, pyramid, stack of blocks, Lego, literal building foundation, architectural construction site, exploded view, cutaway, arrows, labels, connecting lines, isometric view, floating objects, duplicate objects, perfect symmetry, screen, dashboard, chart, interface, hologram, robot, glowing data, neon science fiction, abstract geometry, illustration, 3D render, CGI, collage, visible brand logo, readable text, watermark, people building or installing anything, dominant red object, dominant bright green object, clutter in the left third.',
  },
  {
    key: 'ask',
    about: 'Slide 4 — many kinds of work in one frame; open-ended without a catalogue.',
    prompt: 'Create a 16:9 landscape editorial documentary photograph of one real retail stockroom containing several different kinds of business work in the same coherent scene. On the right two-thirds, include an organised returns cage with mixed unbranded goods, replenishment totes ready for the shop floor, outgoing parcels beside a loading doorway and one closed paper report packet with no readable markings. An experienced operations manager stands at the far right, speaking toward someone just off camera and making one direct open-handed gesture across the different work areas, as if asking for an outcome rather than operating a tool. The scene should feel active and capable, not chaotic. Keep the entire left 36 percent dark and uncluttered using a shadowed doorway and plain wall for typography. Full-frame camera at eye level, 35mm lens, f/4, realistic documentary perspective with enough depth to read the different work areas. Mixed overhead warehouse lighting and directional daylight from the loading door, with the brightest detail on the work areas to the right. Graphite-grey grade, restrained natural colours, deep shadows, realistic cardboard, fabric, steel and concrete textures, subtle grain. Negative list: no screen, monitor, laptop, phone, tablet, dashboard, chart, graph, interface, feature list, catalogue, floating panels, hologram, robot, humanoid AI, glowing circuitry, neon science fiction, abstract geometry, illustration, 3D render, CGI, collage, visible brand logo, readable text, watermark, consultant, engineer, developer, team building software, person typing, pointing at a screen, corporate meeting, handshake, exaggerated smiling, dominant red object, dominant bright green object, clutter in the left third.',
  },
  {
    key: 'yes',
    about: 'Slide 5 — scale from repeated lanes, not from more people.',
    prompt: 'Create a 16:9 landscape editorial documentary photograph of a very large working retail distribution centre viewed from a low mezzanine. Repeating picking aisles and loading lanes extend deep into the right and upper background, carrying varied unbranded retail goods at substantial volume. Use subtle natural motion blur on a few moving cages and parcels, but keep one calm operations supervisor sharp in the upper-right middle distance, observing rather than manually doing the work. The scale should come from repeated active lanes, not from a crowd of employees. Keep the entire left 36 percent dark and uncluttered using a shadowed structural wall for white typography. Keep the lower-right area relatively plain and dark using an open section of concrete dispatch floor so a giant green word can be added later. Full-frame camera, 24mm lens, f/8, elevated viewpoint with long realistic depth and strong converging lines. Cool industrial overhead light with a restrained strip of daylight from distant loading doors. Neutral graphite colour grade, controlled highlights, deep black point, realistic concrete, steel, cardboard and dust texture, subtle photographic grain. The image must feel operational and physically plausible, not futuristic. Negative list: no futuristic automated warehouse, robot arms, humanoid robots, drones, glowing conveyor, neon lighting, hologram, dashboard, screen, monitor, chart, graph, interface, AI icon, abstract geometry, illustration, 3D render, CGI, collage, perfect sterile symmetry, huge crowd of workers, consultants, engineers, visible brand logo, readable text, watermark, dominant red object, dominant bright green object, clutter in the left third, objects covering the lower-right typography area.',
  },
  {
    key: 'dare',
    about: 'Slide 6 — the one-off request no catalogue anticipated.',
    prompt: 'Create a 16:9 landscape editorial documentary photograph of a dark warehouse inspection bay after hours. On the far right, place one unfamiliar irregularly shaped object wrapped in plain brown kraft paper and tape on a simple worn metal inspection table. Its shape should be unusual but physically believable, neither a standard carton nor a recognisable branded product. In the distant right background, show soft out-of-focus rows of uniform unbranded cartons, creating contrast between the one-off object and the standard inventory. Use a single hard overhead work light on the object, with the surrounding warehouse falling into deep shadow. Keep at least the entire left 45 percent completely dark, empty and uncluttered for white typography; the full frame should contain roughly 60 percent negative space. Full-frame camera at table height, 50mm lens, f/2.8, shallow depth of field, precise focus on the paper and tape texture. Cool graphite colour grade with a slight warm tone only on the kraft paper, deep blacks, restrained saturation, realistic steel, paper, dust and concrete texture, fine photographic grain. The result must look like a real photograph of an operational edge case, quiet and confrontational. Negative list: no glowing mystery box, science-fiction object, robot, hologram, screen, monitor, phone, tablet, dashboard, chart, graph, interface, question mark, printed words, readable label, visible brand logo, watermark, magical light, smoke, sparks, abstract geometry, illustration, 3D render, CGI, collage, surrealism, horror scene, person opening the package, consultant, engineer, dominant red object, dominant bright green object, clutter in the left half, centered object.',
  },
];

async function main() {
  if (!leonardo.isConfigured || !leonardo.isConfigured()) {
    console.error('LEONARDO_API_KEY is not set — run this from aspect-agent-server so .env is picked up.');
    process.exit(1);
  }

  const wanted = ONLY.length ? SLIDES.filter(s => ONLY.includes(s.key)) : SLIDES;
  if (wanted.length === 0) {
    console.error(`No slides matched --only "${ONLY.join(',')}". Known keys: ${SLIDES.map(s => s.key).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n  Generating ${wanted.length} image(s) with ${MODEL} at ${WIDTH}x${HEIGHT} into public/pitch/\n`);

  let spent = 0;
  const made = [];

  // Sequential on purpose: Pro routinely takes 20-40s and the account is
  // shared, so a burst of six parallel jobs just queues behind itself while
  // making a failure much harder to attribute.
  for (const slide of wanted) {
    process.stdout.write(`  ${slide.key} … `);
    try {
      const result = await leonardo.generate({
        prompt: slide.prompt, model: MODEL, width: WIDTH, height: HEIGHT, quantity: 1,
      });
      const url = result.images[0];
      if (!url) throw new Error('completed with no image');

      const buffer = await leonardo.download(url);
      fs.writeFileSync(path.join(OUT_DIR, `${slide.key}.png`), buffer);

      spent += Number(result.cost || 0);
      made.push(slide.key);
      console.log(`ok — ${(buffer.length / 1024).toFixed(0)}kb, ${result.width}x${result.height}`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  console.log(`\n  ${made.length}/${wanted.length} written to aspect-react-client/public/pitch/`);
  if (spent) console.log(`  Quoted cost: ${spent} credits`);
  console.log('  Referenced by the page as /pitch/<key>.png\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
