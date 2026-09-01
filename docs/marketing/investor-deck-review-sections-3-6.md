# Investor deck review — "We are your AI"

**Reviewer:** gpt-5.6 · **Generated:** 2026-09-01T05:50:46.325Z · **Took:** 131s
**Extra instruction:** THE AUDIENCE IS NOT ON THE SLIDES, AND IT MUST BE.

Right now the deck could be about any company anywhere. It reads as general-purpose AI. It is not. Here is who this is actually for, in the founder's words:

Retailers and small-to-mid businesses that already live in their data. Chains, stores, distributors. People who run on reports. They already bought a BI tool, and they already paid to have off-the-shelf software customised for them. Every time they needed a new report, a new screen or a new bit of automation, they filed a request with a vendor or an analyst and waited. That is the world they are in TODAY. The change is that now they can have all of it themselves, on demand, without asking anyone — because their AI does it.

Two things I need from you, and they pull against each other, so resolve the tension explicitly rather than picking one:

(A) The deck must make it UNMISTAKABLE within the first two slides who this is for and what world they are in — retail, business operations, data, BI, reports, the customisation treadmill. A viewer must never think 'this is a general AI product'.

(B) It is an INVESTOR deck. Naming a narrow vertical too hard reads as a market ceiling, and 'retail reporting tool' is a much smaller company than what this actually is. Say plainly how to be concrete about the beachhead without capping the story — and whether the audience belongs in the headline, the eyebrow, the body, or a place I have not thought of.

Also handle the before/after directly: they used BI and customised shelf products; now they do it all themselves. That contrast is the sharpest thing the founder said and it is nowhere on the slides. Where does it go, and in whose words?

Deliver: the full six-slide rewrite with the audience properly present (section 3), and in section 6 say exactly what changes visually — if naming the audience needs a typographic treatment, a position, or a new element, specify it. Do not add a seventh slide.

Deck under review: `aspect-react-client/src/pages/WeAreYourAIPage.tsx` (route `/we-are-your-ai`).
Regenerate with `node scripts/investor-deck-review.js`.

---
## 3. The rewrite

### Slide 1

**Eyebrow:** STARTING WITH RETAIL CHAINS AND DISTRIBUTORS

**Headline A:** We are your AI.  
**SHIP — it names the category in four words.**

**Headline B:** Your business gets its own AI.

**Body:**  
Not a tool you learn. An AI that works for you. You talk to it. It builds the next report, screen, automation or internal system your operation needs—on your data.

---

### Slide 2

**Eyebrow:** THE CUSTOMISATION TREADMILL

**Headline A:** Before, a vendor. Now, your AI.  
**SHIP — it puts the entire before-and-after on one line.**

**Headline B:** Everything you need is a project.

**Body:**  
Retailers already bought BI. They already paid to customise off-the-shelf software. Still, every new need meant asking a vendor or analyst. A scope. A quote. A quarter. So they stopped asking. Now they ask their AI.

---

### Slide 3

**Eyebrow:** THE FOUNDATION

**Headline A:** Before you ask, it knows your business.  
**SHIP — it turns data context into business capability.**

**Headline B:** It already knows your data.

**Body:**  
We connect your AI to the business and teach it how your data works: your tables, your language, your exceptions, the way you actually count. Once, up front. We make it capable. It does the work.

---

### Slide 4

**Eyebrow:** THE IDEA

**Headline A:** No catalog. Just ask.  
**SHIP — it breaks the old software model in four words.**

**Headline B:** Claude Code, for the business.

**Body:**  
Claude Code gave developers an open-ended builder for their code. Your business gets one for its data. Ask it for something it has never built. It builds it. No roadmap. Just: what do you need?

---

### Slide 5

**Eyebrow:** WHY NOW

**Headline A:** Now, saying yes scales.  
**SHIP — it kills the services objection directly.**

**Headline B:** Saying yes is software now.

**Body:**  
Saying yes to everything used to be a services business. More requests meant more people, more months, less margin. The AI does the building now. Each thing it builds makes the next one faster.

---

### Slide 6

**Eyebrow:** THE TEST

**Headline A:** Ask it for something it has never built.  
**SHIP — it turns the claim into a live challenge.**

**Headline B:** Bring the request everyone else refused.

**Body:**  
Every other vendor sells you what they already built. Yours builds what you ask for. Bring one real question to the next meeting. It will answer on your data, in the room.

## 6. Visual direction

### The audience treatment

Name the beachhead in the **eyebrow and opening body**, not the hero headline. The headline should own the category; the eyebrow should establish where it starts.

On slide one, set the eyebrow as a two-level tag:

**STARTING WITH**  
**RETAIL CHAINS + DISTRIBUTORS**

“Starting with” appears smaller and muted. “Retail chains + distributors” appears larger and white. That makes the entry market concrete without presenting it as the market ceiling.

On slide two, pull **“Retailers already bought BI.”** out of the body and give it its own line in heavier type. After slide two, stop repeating “retail.” The first two slides establish the beachhead; slides three through six open into the larger business category.

### Typographic system

Use one sans-serif family with a wide weight range: Söhne, Neue Haas Grotesk or Inter. Do not introduce a display font. The force should come from scale, line breaks and contrast.

- Eyebrow: 16–18 pt, uppercase, medium weight.
- Headline: 72–88 pt, tight leading, maximum three lines.
- Body: 26–30 pt, maximum 45 words.
- Keep text within seven columns of a twelve-column grid.
- Use a 7–8% outer margin.
- Left-align everything. Never centre body copy.

The repeating structural device is an **agency lock**: old intermediaries and waiting language appear in low-contrast white; the direct operator–AI relationship appears in electric colour. The accent can mark **“your AI,” “it knows,” “it builds,” “just ask,”** and **“it does the work.”** It must never highlight “we.” Visually, the AI always owns the action.

Use hard line breaks to create the turn:

> Before, a vendor.  
> **Now, your AI.**

That same setup/turn rhythm should appear across all six slides.

### Colour

Use three colours only:

1. Near-black background: `#0A0A0B`
2. Warm white type: `#F2F0EA`
3. Electric acid green: `#B9FF2C`

Create muted text with warm white at reduced opacity; do not add another grey. The green has one job: mark the new direct relationship between the operator and its AI. Never use it decoratively.

No gradients. No glowing orbs. No blue-purple “AI” palette. No stock retail photography. No robot imagery. No dashboard fragments.

### Motion

Use hard cuts between slides, around 150–200 milliseconds. Each slide may have one internal reveal: the old rule appears first, then the AI clause lands.

Do not use:

- Typewriter animation
- Blinking cursors
- Loading dots
- Fake terminal windows
- Morph transitions
- Parallax
- Words flying in from different directions

The deck should feel fast because the argument moves fast, not because the slides perform.

### Slide-by-slide execution

**Slide 1 — Hero**  
Keep roughly 65% of the slide empty. Place the two-level audience tag at the top left. Put the headline below it at maximum scale. Set **“your AI”** in green. The body sits low on the left in four short lines. No image, diagram or decorative mark.

**Slide 2 — Before and after**  
Split the headline across two lines. Set **“Before, a vendor.”** in muted white and **“Now, your AI.”** in green. Below it, isolate **“Retailers already bought BI.”** in heavier white type. The rest of the body follows beneath at normal weight. Keep “A scope. A quote. A quarter.” on one line so it lands as a single beat.

**Slide 3 — Foundation**  
Break the headline after “ask”:

> Before you ask,  
> **it knows your business.**

Keep the data-specific body compact. Give the final two sentences their own block with extra space above:

> We make it capable.  
> **It does the work.**

“We” stays white. The AI action turns green. No database iconography and no connection diagram.

**Slide 4 — Idea**  
Make this the biggest headline in the deck:

> No catalog.  
> **Just ask.**

Place the Claude Code analogy beneath it in smaller type, without a Claude logo or terminal treatment. Put **“Ask it for something it has never built. It builds it.”** on separate lines. Do not turn reports, screens or automations into cards; that would make an open-ended idea look like a feature catalogue.

**Slide 5 — Why now**  
Set “Now,” small and white above a very large green **“saying yes scales.”** In the body, keep “more people, more months, less margin” muted. Switch to full white for **“The AI does the building now.”** Highlight only “does the building” in green. The typography should visibly move from declining economics to compounding capability.

**Slide 6 — Test**  
This should be the emptiest slide: roughly 75–80% negative space. Put the headline high and large, with **“it has never built”** in green. Place the vendor contrast beneath it in two lines. Put the final invitation alone near the bottom left:

> Bring one real question to the next meeting.  
> **It will answer on your data, in the room.**

No button, QR code, demo frame or closing animation. End on the full stop.
