# Investor deck review — "We are your AI"

**Reviewer:** gpt-5.6 · **Generated:** 2026-09-01T07:53:42.848Z · **Took:** 231s
**Extra instruction:** IMAGE BRIEF — and this time imagery is REQUIRED, so do not answer 'no imagery'.

CONTEXT. There are two builds of this deck. The real investor pitch has no imagery — that was your call and it stands, untouched. This brief is for a SECOND build that exists only to show a marketing colleague that AI can produce a finished slide end to end, artwork included. So on this variant the pictures have to be real, immersive and obviously photographs. My first attempt failed: I locked the prompts to the four flat colours and your no-illustration rule, and the generator returned exactly that — a bar, a wedge, a rectangle. On screen they read as more CSS lines, and the founder's reaction was 'I don't see any image'. Abstract geometry is dead. I need scenes.

WHAT THE FOUNDER ASKED FOR, in his words: images of the OLD BI SYSTEMS — the legacy world these customers live in — and something that ILLUSTRATES THE FOUNDATION IDEA, the architecture where the AI learns the business once and everything else is built on top of that same layer. He is unsure what those pictures should be and asked us to work it out.

THE SIX SLIDES: 1 'We are your AI' · 2 'Everything you need is a project' with a giant red WAITS. in the lower right · 3 'One foundation. Anything on top.' · 4 'Claude Code, for the business / So ask.' · 5 'Now, saying yes scales' with a giant green YES · 6 'Ask it for something it has never built.'

The audience is retail chains and distributors — stores, stockrooms, distribution centres, back offices, people who run on reports.

Give me:

(A) For EACH of the six slides, the scene. One sentence saying what it is and why it belongs to that slide's argument. If a slide is better with no picture at all, say so and say why.

(B) The two hard ones, in detail. How do you photograph THE OLD BI WORLD without a screenshot of a dashboard, without a screen, without a chart — something that makes a viewer feel the legacy reporting era physically? And how do you photograph A FOUNDATION WITH ANYTHING ON TOP without it becoming a diagram, a pyramid, a stack of blocks or a literal building?

(C) The full generation prompt for every approved scene, written for a literal-minded photographic model: subject, camera, lens, lighting, colour grade, texture, and an explicit negative list. Assume the type sits on the LEFT third of every frame, so that area must stay dark and uncluttered. These go into the generator unedited.

(D) The one test I apply to each rendered image before it ships.

Deck under review: `aspect-react-client/src/pages/WeAreYourAIPage.tsx` (route `/we-are-your-ai`).
Regenerate with `node scripts/investor-deck-review.js`.

---
## 6. Visual direction

Use full-bleed photography across all six slides. No image cards, masks, decorative lines or floating interface elements. The main type always occupies the dark left third; the physical business occupies the right two-thirds. That repeated handoff encodes the product: the customer asks on the left, the AI acts on the business to the right.

**Typographic system**

Use one grotesk family: Söhne if available, Neue Haas Grotesk or Inter Tight if not. Headlines are heavy, sentence case, 66–84 pt, with tight 0.95 leading. Body is regular, 22–26 pt, with no more than 30 words or four short lines. Eyebrows are 15–17 pt, medium weight, never tracked-out corporate capitals.

Set every main text block 8% from the left edge and keep it under 30% of the slide width. Do not put type in boxes. Build the darkness into the photograph, then add only a subtle black gradient if white type still fails contrast.

“WAITS.” and “YES” should occupy the exact same lower-right position, size and baseline. Set them at roughly 190–220 pt, partially cropped by the right edge. That visual reversal carries the argument before the founder explains it.

**Colour**

Use four colours with fixed jobs:

- Near-black `#101214`: shadows and image burn.
- Warm white `#F2F0E8`: all normal type.
- Signal red `#FF3B30`: “WAITS.” only.
- Electric green `#A7FF3F`: “YES” only.

Grade the photographs toward graphite, concrete grey and restrained skin tones. Keep bright red and green objects out of the scenes so the two signal words remain unique.

**Motion**

Use hard cuts. Everything arrives as a complete frame except “WAITS.” and “YES,” which snap on when the founder says the word—no fade, bounce or easing. Do not use morphs, camera pushes, parallax, animated particles, typing cursors, glowing data paths or video loops.

**(A) The scene for each slide**

1. **We are your AI.** A retail operations manager stands in a real stockroom and speaks toward an unseen colleague beside the camera; it makes the AI feel like someone inside the business whom the customer can address, without turning it into a robot or a screen. Keep the headline large on the left and the manager on the far right.

2. **Everything you need is a project.** A contemporary back office is physically buried in report packs, binders and in-trays while one employee waits; the scene turns reporting latency into something heavy and visible. Keep the lower right dark enough for the giant red “WAITS.”

3. **One foundation. Anything on top.** One continuous warehouse conveyor supports several visibly unrelated kinds of retail goods; the single surface is the learned foundation, while the different loads represent everything that can follow. The belt must remain clearly visible rather than disappearing beneath the objects.

4. **Claude Code, for the business / So ask.** One wide stockroom frame contains several unrelated kinds of work—returns, replenishment, dispatch and reporting—while a manager gestures across them; it makes “open-ended” physical without showing a catalogue. Set “Claude Code, for the business” small and “So ask.” large.

5. **Now, saying yes scales.** A distribution centre extends through repeated active lanes while one supervisor remains calm and stationary; volume increases without adding a crowd of people. Place the giant green “YES” in the same position occupied by “WAITS.”

6. **Ask it for something it has never built.** One irregular, unlabelled object sits under a hard light among distant rows of standard cartons; it is the visual equivalent of the request no catalogue anticipated. Make this slide nearly empty: at least 60% darkness and negative space, with only the object on the right and the challenge on the left.

Never show consultants, engineers or a team doing the customer’s work. Any visible person is the customer asking, waiting or supervising. The AI remains the implied actor.

**(B) The two hard images**

**The old BI world**

Do not photograph “old technology.” A CRT monitor or fax machine makes the problem look safely dead. Photograph a current business trapped in an old reporting ritual: thick monthly packs, ring binders, document trays, handwritten exceptions, date stamps and an office printer producing more paper than anyone can act on.

The emotional verb is not “obsolete.” It is “waits.” Keep the employee still, the lighting flat and the frame compressed so the paper feels as if it is closing in. Use contemporary clothing and furniture so the viewer understands that this is happening now. No legible report content is necessary; the accumulation is the argument.

**The foundation with anything on top**

Do not photograph a foundation literally. Do not use a building, pyramid, stack, platform diagram or Lego metaphor. Photograph one continuous operational surface—a real warehouse conveyor—carrying objects that clearly do not belong to one product category.

Shoot low enough that the belt dominates the frame and remains visibly unbroken. Place unlike loads asymmetrically: flowers, apparel, hardware, produce and a small appliance. The objects are not the architecture; the shared surface beneath them is. If the belt becomes background scenery, the image fails.

**(C) Generation prompts**

**Slide 1**

```text
Create a 16:9 landscape editorial documentary photograph inside a real retail stockroom before opening. An experienced retail operations manager stands in the far-right third of the frame, turning naturally toward an unseen colleague just beside the camera and speaking mid-sentence, with one hand in a small relaxed gesture. The person is clearly the customer, not a technician or consultant. Deep stockroom shelves, unbranded cartons and rolling retail cages recede behind them. Keep the entire left 36 percent of the frame dark, simple and uncluttered, using a shadowed wall and empty aisle as negative space for white typography. Full-frame camera at eye level, 50mm lens, f/2.8, realistic perspective and shallow but not extreme depth of field. Mixed cool fluorescent stockroom light with a faint warm dawn practical in the distance. Graphite and concrete-grey colour grade, restrained saturation, natural skin, deep black point, subtle photographic grain, tactile cardboard and worn concrete textures. The image must look like a physically plausible candid photograph, not a staged advertising portrait.

Negative list: no screen, monitor, laptop, phone, tablet, dashboard, chart, graph, interface, hologram, robot, humanoid AI, glowing orb, neon science fiction, circuitry, abstract geometry, illustration, 3D render, CGI, collage, visible brand logo, readable text, watermark, consultant, engineer, smiling team, handshake, corporate stock-photo pose, dominant red object, dominant bright green object, clutter in the left third, centered subject.
```

**Slide 2**

```text
Create a 16:9 landscape editorial documentary photograph of a current-day retail back office trapped in a physical reporting ritual. On the right half of the frame, show tall shelves of thick ring binders, stacked monthly report packets, overflowing document trays, loose continuous paper, handwritten exception notes and the paper-output side of a high-volume office printer with its control panel completely out of view. One contemporary back-office employee waits motionless at the far right, hands still, neither theatrical nor distressed. The furniture and clothing must look current, not retro. Keep the left 36 percent dark and uncluttered for white typography. Keep the lower-right area relatively plain and dark, using the blank face of a filing cabinet and shadowed floor, so a giant red word can be added later. Full-frame camera at seated eye level, 50mm lens, f/4, slightly compressed perspective that makes the paper feel dense and airless. Flat overhead fluorescent lighting with weak daylight from a distant internal window. Cool grey-green colour grade, low saturation, realistic paper fibres, scuffed metal, dusty plastic and subtle grain. The image should make waiting feel physical.

Negative list: no visible screen, monitor, laptop, phone, tablet, dashboard, chart, graph, pie chart, readable spreadsheet, legible report text, retro costume, sepia nostalgia, antique office comedy, fax-machine joke, robot, hologram, AI icon, abstract geometry, illustration, 3D render, CGI, collage, arrows, labels, visible brand logo, watermark, dramatic facial expression, smiling employee, corporate stock-photo pose, dominant red object, dominant bright green object, clutter in the left third, objects covering the lower-right typography area.
```

**Slide 3**

```text
Create a 16:9 landscape editorial documentary photograph inside a working retail distribution centre. One single continuous dark rubber warehouse conveyor begins at 40 percent of the frame and runs uninterrupted from the lower middle into the right background. The conveyor surface must be broad, clearly visible and visually dominant. It carries several naturally spaced, visibly unrelated unbranded retail loads: an open crate of fresh flowers, a soft tote containing folded apparel, a shallow tray holding irregular metal hardware, a plain boxed small appliance and a reusable produce crate. Do not stack the objects and do not arrange them with perfect symmetry. The different loads must all touch and share the same continuous conveyor surface. Keep the left 36 percent of the frame dark, empty and uncluttered for white typography. Camera positioned low, approximately 40 centimetres above the conveyor, full-frame camera, 28mm lens, f/5.6, strong foreground depth and realistic industrial scale. Use raking side light from high warehouse windows to reveal the worn rubber surface as one connected plane, with soft overhead industrial fill. Cool neutral graphite colour grade, restrained product colours, deep shadows, realistic dust, rubber, steel and cardboard texture, fine photographic grain. This must look like a real operational photograph, not a visual metaphor assembled in software.

Negative list: no diagram, flowchart, pyramid, stack of blocks, Lego, literal building foundation, architectural construction site, exploded view, cutaway, arrows, labels, connecting lines, isometric view, floating objects, duplicate objects, perfect symmetry, screen, dashboard, chart, interface, hologram, robot, glowing data, neon science fiction, abstract geometry, illustration, 3D render, CGI, collage, visible brand logo, readable text, watermark, people building or installing anything, dominant red object, dominant bright green object, clutter in the left third.
```

**Slide 4**

```text
Create a 16:9 landscape editorial documentary photograph of one real retail stockroom containing several different kinds of business work in the same coherent scene. On the right two-thirds, include an organised returns cage with mixed unbranded goods, replenishment totes ready for the shop floor, outgoing parcels beside a loading doorway and one closed paper report packet with no readable markings. An experienced operations manager stands at the far right, speaking toward someone just off camera and making one direct open-handed gesture across the different work areas, as if asking for an outcome rather than operating a tool. The scene should feel active and capable, not chaotic. Keep the entire left 36 percent dark and uncluttered using a shadowed doorway and plain wall for typography. Full-frame camera at eye level, 35mm lens, f/4, realistic documentary perspective with enough depth to read the different work areas. Mixed overhead warehouse lighting and directional daylight from the loading door, with the brightest detail on the work areas to the right. Graphite-grey grade, restrained natural colours, deep shadows, realistic cardboard, fabric, steel and concrete textures, subtle grain.

Negative list: no screen, monitor, laptop, phone, tablet, dashboard, chart, graph, interface, feature list, catalogue, floating panels, hologram, robot, humanoid AI, glowing circuitry, neon science fiction, abstract geometry, illustration, 3D render, CGI, collage, visible brand logo, readable text, watermark, consultant, engineer, developer, team building software, person typing, pointing at a screen, corporate meeting, handshake, exaggerated smiling, dominant red object, dominant bright green object, clutter in the left third.
```

**Slide 5**

```text
Create a 16:9 landscape editorial documentary photograph of a very large working retail distribution centre viewed from a low mezzanine. Repeating picking aisles and loading lanes extend deep into the right and upper background, carrying varied unbranded retail goods at substantial volume. Use subtle natural motion blur on a few moving cages and parcels, but keep one calm operations supervisor sharp in the upper-right middle distance, observing rather than manually doing the work. The scale should come from repeated active lanes, not from a crowd of employees. Keep the entire left 36 percent dark and uncluttered using a shadowed structural wall for white typography. Keep the lower-right area relatively plain and dark using an open section of concrete dispatch floor so a giant green word can be added later. Full-frame camera, 24mm lens, f/8, elevated viewpoint with long realistic depth and strong converging lines. Cool industrial overhead light with a restrained strip of daylight from distant loading doors. Neutral graphite colour grade, controlled highlights, deep black point, realistic concrete, steel, cardboard and dust texture, subtle photographic grain. The image must feel operational and physically plausible, not futuristic.

Negative list: no futuristic automated warehouse, robot arms, humanoid robots, drones, glowing conveyor, neon lighting, hologram, dashboard, screen, monitor, chart, graph, interface, AI icon, abstract geometry, illustration, 3D render, CGI, collage, perfect sterile symmetry, huge crowd of workers, consultants, engineers, visible brand logo, readable text, watermark, dominant red object, dominant bright green object, clutter in the left third, objects covering the lower-right typography area.
```

**Slide 6**

```text
Create a 16:9 landscape editorial documentary photograph of a dark warehouse inspection bay after hours. On the far right, place one unfamiliar irregularly shaped object wrapped in plain brown kraft paper and tape on a simple worn metal inspection table. Its shape should be unusual but physically believable, neither a standard carton nor a recognisable branded product. In the distant right background, show soft out-of-focus rows of uniform unbranded cartons, creating contrast between the one-off object and the standard inventory. Use a single hard overhead work light on the object, with the surrounding warehouse falling into deep shadow. Keep at least the entire left 45 percent completely dark, empty and uncluttered for white typography; the full frame should contain roughly 60 percent negative space. Full-frame camera at table height, 50mm lens, f/2.8, shallow depth of field, precise focus on the paper and tape texture. Cool graphite colour grade with a slight warm tone only on the kraft paper, deep blacks, restrained saturation, realistic steel, paper, dust and concrete texture, fine photographic grain. The result must look like a real photograph of an operational edge case, quiet and confrontational.

Negative list: no glowing mystery box, science-fiction object, robot, hologram, screen, monitor, phone, tablet, dashboard, chart, graph, interface, question mark, printed words, readable label, visible brand logo, watermark, magical light, smoke, sparks, abstract geometry, illustration, 3D render, CGI, collage, surrealism, horror scene, person opening the package, consultant, engineer, dominant red object, dominant bright green object, clutter in the left half, centered object.
```

**(D) The shipping test**

Hide all type and show the image for two seconds. If the viewer says “generic warehouse photo” instead of “someone to ask,” “waiting for reports,” “one base for many outcomes,” “many kinds of work,” “scale,” or “the one-off request,” reject it.
