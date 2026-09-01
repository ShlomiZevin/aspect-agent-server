# Marketing playbook — how the investor pitch was built

Everything from the first positioning question to the finished decks: what we
decided, what we got wrong on the way and why, and exactly how the two AI tools
were driven. Written so the next marketing project can be run without starting
over.

Built 2026-08-31 → 2026-09-01.

---

## 1. What exists now

| | URL | What it is |
|---|---|---|
| **The pitch** | `/aspect/investors-pitch` | Six slides, no imagery. The real one. |
| **The demo** | `/aspect/investors-pitch-visual` | Same six slides with generated photography. Built to show a marketing colleague that AI can produce a finished slide end to end. **Not a replacement.** |

| File | What it holds |
|---|---|
| `aspect-react-client/src/pages/WeAreYourAIPage.tsx` | The pitch. Copy lives here. |
| `aspect-react-client/src/pages/WeAreYourAIPage.module.css` | The whole design system. Read its header first. |
| `aspect-react-client/src/pages/WeAreYourAIVisualPage.tsx` | The illustrated variant. Imports the same stylesheet. |
| `aspect-react-client/src/pages/WeAreYourAIVisual.module.css` | Only the photograph layers. |
| `aspect-react-client/public/pitch/*.png` | Six generated photographs, 1376×768. |
| `aspect-agent-server/scripts/investor-deck-review.js` | Sends the deck to GPT-5.6 for review. |
| `aspect-agent-server/scripts/generate-pitch-images.js` | Generates the artwork through Leonardo. |
| `aspect-agent-server/docs/marketing/investor-deck-review*.md` | Every review GPT-5.6 returned. |

---

## 2. The positioning, and how it was found

The final idea did not arrive first. It took four wrong turns, and the wrong
turns are the useful part — each one is a trap worth recognising early.

### Turn 1 — "we market ourselves as AI enablers, tailor-made"

**Why it failed:** "we'll build you anything, custom" reads to a buyer as a dev
shop. Unbounded scope, no price, all the risk on them. To an investor it caps
the valuation at a services multiple.

**What survived:** custom is the *output*, not the *offer*. The offer needs a
spine.

### Turn 2 — "brand myself as *the* AI, not another AI company"

**Why it half-failed:** "I am the AI" said plainly is key-man risk, and
investors are trained to discount it.

**What survived:** the defensible version — *an unfair rate of production, with
receipts* — and the observation that the founder is the existence proof, not the
product.

### Turn 3 — the Intelligence Center as a container

Read the actual product (`docs/features/insights.md`,
`tasks/pending/aspect-modules.md`) and found the real architecture: three
surfaces — a screen, the chat, a report — and a module slot, where a new
capability lands on all three at once.

**Why it was still not it:** true, but it described the machine rather than the
promise.

### Turn 4 — the actual idea

> **We are your AI.** Not a tool you learn — an AI that works for you. You tell
> it what the business needs and it builds it: a report, a screen, an
> automation, a whole internal system. On your data.

The analogy that makes it land in one sentence: **Claude Code, for the
business.** Developers got an open-ended builder for their code; the business
gets one for its data.

### The four corrections that finished it

1. **The AI is the actor, never us.** If *we* build what the customer asks for,
   an investor prices a services firm within thirty seconds of slide one and
   nothing later undoes it. The AI is the employee that does the work; we make
   it capable. Passive voice ("it gets built") quietly breaks the same rule.
2. **The analogy belongs on the solution side.** It was first used to describe
   the *problem* ("developers got Claude, business got a menu") and read as a
   good thing that happened to somebody else. Moved to the offer slide, it
   became the category shorthand.
3. **The audience must be visible, without becoming a ceiling.** Named in the
   eyebrow/body, never in a headline: *"Retail first. The same wait exists
   anywhere a business runs on reports."* Said on slides 1 and 2 and never
   again.
4. **"AI OS" is an overclaim — but the idea underneath is right.** An operating
   system implies third-party builders and distribution that do not exist yet.
   The true version carries the same architecture: **"One foundation. Anything
   on top."**

---

## 3. The finished argument

Six slides. Declaration → collision → preparation → release → expansion → dare.

| # | Eyebrow | Headline |
|---|---|---|
| 1 | Who we are | **We are your AI.** |
| 2 | The old rule | **Everything your business needs becomes a project.** |
| 3 | The foundation | **One foundation. Anything on top.** |
| 4 | The idea | **So ask.** / Claude Code, for the business. |
| 5 | Why now | **Now, saying yes scales.** |
| 6 | The test | **Ask it for something it has never built.** |

### Lines that carry weight

- Not a tool you learn. An AI that works for you.
- You bought BI. You paid to customise software. So you stopped asking.
- We make it capable. **It does the work.**
- No catalog. No roadmap. Just: what do you need?
- Every other vendor sells you what they already built. Yours builds what you ask for.
- Bring one real question to the next meeting. It will answer on your data, in the room.

### The answers to the three questions that follow

- *"Isn't this still a services business?"* — "A services company scales
  requests by adding people; we scale them by reusing what the system has
  already learned. The outputs are custom. The machinery is shared."
- *"Why won't Microsoft or Anthropic do this?"* — "None of them arrives knowing
  how this business defines a sale across all the systems it already runs."
- *"How can you safely say yes to anything?"* — "Saying yes means yes to doing
  the work — not yes to inventing the answer."
- *"So you're claiming an AI operating system?"* — "I am not claiming an app
  ecosystem today. The AI learns the business once, then builds on that same
  foundation. Opening that layer to others is a direction, not the claim."

### Deliberate omissions

No metrics, no logos, no customer names, no screenshots, no product tour, no
team slide, no pricing, no competitive matrix. The deck presents **who we are
and what the idea is**. Proof is what the live demo is for.

---

## 4. The design system

Read `WeAreYourAIPage.module.css`'s header before changing anything; the reasons
are recorded there.

**Four colours, fixed jobs.** `#090909` ink · `#F2EFE6` bone · `#FF3B30` signal
red (delay and the old rule — slide 2 only) · `#B7FF2A` electric green (AI
agency and "yes"). Red and green never share a slide. Muted text is ink or bone
at low alpha, never a fifth colour.

**One grotesk, two weights.** Inter Tight, 400 and 700/900. Type is the image —
no illustrations, icons, charts or mockups anywhere. Where an argument needs a
picture, one word is set enormous and becomes it: **WAITS.** on slide 2, **YES**
on slide 5.

**No shared grid.** Only the outer margin is constant; weight and position
change aggressively slide to slide. One headline and one body block each.

**The repeating device** is the capability line: 6px, above the bottom edge,
starting at the left margin. Short and green on 1, **red with a hard stop cap**
on 2, half the slide on 3, past the right edge from 4 onward. It encodes one
true thing — *traditional software has a boundary; this AI does not*.

**Hard cuts.** No fades, parallax, typewriter or word-by-word reveals. Every
slide arrives complete; the argument supplies the momentum. The deck must stay
effective as a static PDF.

**Single theme, stated outright.** It gets presented from someone else's laptop
and a dark-mode OS must not repaint the pitch mid-sentence.

---

## 5. Working with GPT-5.6 Sol as the reviewer

`node scripts/investor-deck-review.js` — sends the whole brief (who we are, the
lines that already work, the deck verbatim) to GPT-5.6 and asks for a hostile
review, rewritten copy, writing rules and art direction.

```bash
cd aspect-agent-server
node scripts/investor-deck-review.js
node scripts/investor-deck-review.js --sections 3,6
node scripts/investor-deck-review.js --model gpt-5.6-terra
node scripts/investor-deck-review.js --ask "slide 2 does not read as the problem…"
```

Output lands in `docs/marketing/investor-deck-review*.md`.

**Why a different model at all.** Same reason the insights pipeline runs VERIFY
as its own call: the model that wrote the thing cannot audit it. Sol has no
stake in the copy sounding good.

### What made the reviews useful

- **Hard constraints in the system prompt.** Six slides, no metrics, investor
  audience, English spoken by a non-native, "must feel electric". Without them
  it returns a generic SaaS deck.
- **"Never write a note like *make it punchier* without immediately writing the
  punchier version."** This single instruction is what turns advice into
  shippable copy.
- **Give it the lines that already work and tell it to protect or beat them.**
  Otherwise it quietly discards good material.
- **Describe failures in the founder's own words.** "we is your vendor — what is
  it talking about?" produced a far better fix than "the headline is ambiguous".
- **`--sections`** to re-ask one part. A full pass at `effort: high` can spend
  its budget on reasoning and get cut off mid-answer; the script now detects
  truncation and says so.

### What it gets wrong, so check every time

- **It contradicts itself between runs.** Orange in one pass, acid green the
  next; caret device in one, capability line in the next. The latest is usually
  sharper, but do not flip a working system on every review — take the fix that
  addresses the actual failure and leave the rest.
- **It specifies unbuildable things.** Söhne and Diatype are commercial faces;
  it also asked for green type on a bone ground (contrast ratio ≈1.03:1 — the
  word would be invisible). Deviate, and record the deviation in the stylesheet
  header.
- **It will refuse when refusing is right.** Asked whether the deck should have
  generated imagery it said no, plainly: *"Production capability is not a
  creative reason. Abstract imagery would make this look like every other AI
  deck."* That answer was correct and is why the real pitch has no pictures.

---

## 6. Working with Leonardo for imagery

`node scripts/generate-pitch-images.js` — writes straight into
`aspect-react-client/public/pitch/`.

```bash
cd aspect-agent-server
node scripts/generate-pitch-images.js
node scripts/generate-pitch-images.js --only wait,yes
node scripts/generate-pitch-images.js --model gpt-image-2
```

Models available on the account: `nano-banana-pro` (best, ~25s), `gpt-image-2`
(very graphic), `nano-banana-2` (fast, cheap). Six images cost ≈1.26 credits.

**Sizes are a fixed allowlist.** Arbitrary dimensions are rejected with a bare
`VALIDATION_ERROR`. `1536×864` fails; **`1376×768` works and is 16:9** (the
`story` preset transposed). The error message lists the legal values — read it.

### The two failures, in order

**1. Abstract shapes are not images.** The first prompts were locked to the
deck's four flat colours and its no-illustration rule. Leonardo did exactly as
asked and returned a bar, a wedge and a rectangle. On the page they read as more
CSS lines — *"I don't see any image"*. **A palette lock plus a minimalism rule
produces geometry, not photography.**

**2. Scenes, briefed properly, work immediately.** The fix was a real
photographic brief: subject, camera, lens, lighting, colour grade, texture, and
an explicit negative list. Ask GPT-5.6 to write these — it is good at them.

### The rules that made the photographs usable

- **Compose the darkness into the frame.** "Keep the entire left 36% dark and
  uncluttered for white typography." That is why the images can run full bleed
  with only a thin gradient rather than a scrim that kills them.
- **Keep the signal colours out of the scenes.** No dominant red or green
  object, so `WAITS.` and `YES` stay unique.
- **Photograph the ritual, not the technology.** For the legacy-BI slide: *"A
  CRT monitor makes the problem look safely dead."* Contemporary furniture and
  clothing, thick report packs, a printer producing more paper than anyone can
  act on. The verb is *waits*, not *obsolete*.
- **Photograph the shared surface, not a diagram.** For "one foundation,
  anything on top": one continuous conveyor carrying flowers, apparel,
  hardware, an appliance and produce. *"The objects are not the architecture;
  the shared surface beneath them is."* No pyramid, stack or building.
- **Any visible person is the customer** asking, waiting or supervising — never
  a consultant or engineer doing the work. The AI stays the implied actor.
- **A long negative list is load-bearing.** No text, letters, signage, logos,
  screens, dashboards, charts, holograms, robots, neon, 3D render or stock-photo
  look. An early render still slipped an illuminated EXIT sign in.

### The shipping test

Hide the type and show the image for two seconds. If the viewer says "generic
warehouse photo" instead of the thing that slide is about, reject and
regenerate. Cost per retry is one image.

---

## 7. Two build traps that cost real time

**A promoted sibling breaks absolute positioning.** To paint type over an
`<img>` the first version gave every child of the slide `position: relative`.
That also hit the capability line (which fell into the flex flow and struck
through the copy) and the giant `WAITS.` (which stopped being pinned and pushed
the slide taller than the viewport, so it showed different content depending on
which direction you scrolled in from). **Fix: the photograph is a CSS
`background-image` on the section.** No stacking contest, nothing to promote.

**Global element selectors beat inherited colour.** `styles/global.css` sets
`h1..h6 { color: var(--text-primary) }`. A page that only inherits its colour
down from a container renders dark-navy headlines on a dark ground. Every text
rule in these stylesheets sets `color` explicitly.

---

## 8. Running the next marketing project

1. **Write the idea in your own words first.** Every good line in this deck came
   from a sentence Shlomi said, not from a model. The model sharpens; it does
   not originate.
2. **Read the product before writing about it.** The Intelligence Center turn
   only happened after reading `docs/features/insights.md` and
   `tasks/pending/aspect-modules.md`.
3. **Decide the audience and the one job of the page** before any design.
4. **Build it as a real route in the app**, not a slide file — it can be linked,
   iterated and versioned. Follow the `<Name>Page.tsx` + `.module.css` +
   `pages/index.ts` + `App.tsx` convention.
5. **Review with Sol using the constraint pattern above.** Feed failures back in
   the founder's own words.
6. **Only then decide about imagery**, and let the reviewer say no.
7. **Record every deliberate deviation in the stylesheet header**, so the next
   session does not "fix" it back.
