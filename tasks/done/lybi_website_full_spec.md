# Lybi.ai — Complete Website Specification
*Full implementation spec — all copy and design included*

---

## Design System

### Colors
- Primary background: `#FAF7F7` (warm off-white)
- Secondary background: `#F3EFF0` (light warm gray — used for alternating sections)
- Primary text: `#1C1917` (near black)
- Secondary text: `#57534E` (medium warm gray — used for body paragraphs)
- Muted text: `#9C9489` (light warm gray — used for labels, footer small text)
- Brand purple: `#6B21A8` (buttons, accent elements, bullet points, label text)
- Brand pink: `#C2185B` (used as accent on the letter "i" in logo only)
- Hover purple: `#581C87` (button hover state)

### Typography
- Heading font: **Playfair Display** (serif) — used for all section headings and hero titles
- Body font: **DM Sans** (sans-serif) — used for all body text, nav, buttons, labels
- Import from Google Fonts:
  ```
  https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap
  ```

### Font sizes
- Hero headline (h1): 56px, Playfair Display, weight 400, line-height 1.15, letter-spacing -0.5px
- Section heading (h2): 42px, Playfair Display, weight 400, line-height 1.2, letter-spacing -0.3px
- Card heading (h3): 20–22px, Playfair Display, weight 400, line-height 1.3
- Body paragraph: 16px, DM Sans, weight 400, line-height 1.75, color: secondary text
- Hero subtitle: 18px, DM Sans, weight 400, line-height 1.6, color: secondary text
- Label (eyebrow): 11px, DM Sans, weight 500, letter-spacing 0.12em, uppercase, color: brand purple
- Nav links: 14px, DM Sans, weight 400
- Button text: 14–15px, DM Sans, weight 500
- Footer small: 12px, DM Sans, color: muted text
- Bullet items: 14px, DM Sans, color: secondary text, line-height 1.5

### Spacing
- Page horizontal padding: 48px (desktop)
- Section vertical padding: 96px top and bottom
- Hero section top padding: 120px, bottom: 100px
- Max content width for text sections: 780px
- Max content width for grid sections: 1000px
- Gap between cards/columns: 40–48px
- Paragraph margin bottom: 20px

### Buttons
**Primary button:**
- Background: brand purple `#6B21A8`
- Text: white
- Padding: 14px 28px
- Border-radius: 6px
- Font: DM Sans 15px weight 500
- Hover: background `#581C87`
- Include arrow "→" after text with 8px gap

**Nav button (Let's talk):**
- Same as primary button but smaller
- Padding: 10px 22px
- Font size: 14px

**Text link (underline style):**
- No background, no border
- Text color: primary text
- Border-bottom: 1px solid primary text
- Font: DM Sans 15px
- Used for secondary CTAs within pages

### Section backgrounds
- Sections alternate between primary background (`#FAF7F7`) and secondary background (`#F3EFF0`)
- Home page order: white → gray → white → white → gray → gray → gray
- Dividers between sections: none (background color change is the divider)

### Bullets
- No default list styling
- Custom bullet: filled circle 6px × 6px, color brand purple, margin-top 6px, flex-shrink 0
- Item display: flex, align-items flex-start, gap 10px

### Logo
- Text-based: "Lybi" 
- Font: Playfair Display
- "Lyb" in brand purple, "i" in brand pink
- Nav size: 28px (prominent — this is intentionally larger than typical nav logos)
- Followed by a small decorative dot element: 8px circle, brand pink, positioned top-right of the "i"

### Navigation
- Sticky top, background: primary background
- Border-bottom: 1px solid rgba(0,0,0,0.06)
- Padding: 20px 48px
- Layout: logo left, links + CTA button right
- Links color: secondary text, hover: primary text
- Gap between links: 36px

### Footer
- Background: secondary background `#F3EFF0`
- Border-top: 1px solid rgba(0,0,0,0.06)
- Padding: 40px 48px
- Layout: logo + copyright left, nav links center, utility links right
- All footer links: 13px, DM Sans, color secondary text

---

## Site Structure

4 pages:
1. **Home** (`/`)
2. **Our Belief** (`/belief`)
3. **What We Enable** (`/enable`)
4. **About** (`/about`)

---

## Global: Navigation (all pages)

```
Logo: Lybi  [sticky top-left]

Nav links [top-right]:
Our Belief → /belief
What We Enable → /enable
About → /about

CTA Button [rightmost]:
"Let's talk"  → mailto:hello@lybi.ai
```

---

## Global: Footer (all pages)

```
Left:
[Logo: Lybi]
© 2026 LYBI.AI. All rights reserved.

Center:
Our Belief | What We Enable | About

Right:
LinkedIn | Privacy | Terms

LinkedIn URL: https://linkedin.com/company/lybi-ai [placeholder]
```

---

---

# Page 1: Home (`/`)

## Section 1 — Hero
*Background: primary (`#FAF7F7`)*
*Padding: 120px 48px 100px*
*Max-width: 860px*

```
[H1 — hero headline]
The Intelligent Relationship System

[Subtitle — 18px body]
Built for organizations that can't afford to lose 
the connection with their customers.

[Primary button]
See how we think →
Link: /belief
```

---

## Section 2 — What's broken
*Background: secondary (`#F3EFF0`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
What's broken

[Body paragraph]
The assumption underlying most engagement is flawed: that relationships 
can be managed like processes. That trust can be designed like interfaces. 
That connection can be optimized like conversion funnels.

[Body paragraph]
This has led us to treat engagement as a feature — something to be bolted 
on and measured in clicks. We've reduced human relationships to "journeys" 
that can be mapped and "touchpoints" that can be optimized.

[Body paragraph]
The result: experiences that feel engineered, communications that feel 
automated, relationships that feel hollow.
```

---

## Section 3 — Engagement at scale
*Background: primary (`#FAF7F7`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
Engagement at scale

[Body paragraph]
Digital platforms were built to manage processes, not relationships. 
They handle transactions, workflows, and data — but struggle to hold 
a relationship over time.

[Body paragraph]
Meanwhile, people's expectations have shifted completely. In two years, 
the way individuals relate to technology changed more than in the previous 
twenty. Conversational. Personal. Intelligent. Always present.

[Body paragraph]
The gap between what customers now expect — and what organizations can 
actually deliver — is growing faster than any platform can patch.

[Body paragraph — bold, color: primary text]
Engagement requires a system. Not an interface, not a journey, not a feature.
```

---

## Section 4 — What we believe
*Background: primary (`#FAF7F7`)*
*Padding: 96px 48px*
*Layout: heading centered, then 3-column grid below*
*Grid max-width: 1000px, centered, gap: 40px*

```
[H2 — centered]
What we believe

[Card 1]
Title (H3): Engagement is not a feature
Body: It cannot be bolted on, optimized through A/B tests, or measured 
in clicks. True engagement emerges from systemic design.

[Card 2]
Title (H3): Connection erodes gradually
Body: Small, well-timed interactions build trust over time. The absence 
of the right action at the right moment is what slowly breaks a relationship.

[Card 3]
Title (H3): Judgment over automation
Body: The value is in knowing when to act, how to respond, and what matters. 
Good systems enable good decisions — fast.
```

---

## Section 5 — Banner
*Background: secondary (`#F3EFF0`)*
*Padding: 80px 48px*
*Text centered*
*Max content width: 700px, centered*

```
[Body text — 20px, color: secondary text, centered]
Lybi enables organizations to operate engagement as a living system — 
adaptive, intelligent, and built for the complexity of real relationships.

[Text link — centered]
Read our belief →
Link: /belief
```

---

## Section 6 — Final CTA
*Background: secondary (`#F3EFF0`)*
*Padding: 80px 48px*
*Text centered*

```
[H2 — centered, 30px]
Your customers already live in the AI era.

[H2 — centered, 30px, color: secondary text]
Their relationship with your organization doesn't have to stay behind.

[Primary button — centered]
Let's talk →
Link: mailto:hello@lybi.ai
```

---

---

# Page 2: Our Belief (`/belief`)

## Section 1 — Hero
*Background: primary (`#FAF7F7`)*
*Padding: 120px 48px 100px*
*Max content width: 780px*

```
[Label — eyebrow]
OUR BELIEF

[H1]
Rethinking digital engagement

[Subtitle]
A manifesto for building trust-driven relationships 
in a world optimized for transactions.
```

---

## Section 2 — The current reality
*Background: secondary (`#F3EFF0`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
The current reality

[Body paragraph]
Organizations invest heavily in engagement — customer experience, 
employee programs, stakeholder relationships. Yet satisfaction declines. 
Trust erodes. Interactions feel increasingly hollow.

[Body paragraph]
The platforms built to manage these relationships were designed for 
efficiency, not connection. For transactions, not trust.
```

---

## Section 3 — What's broken
*Background: primary (`#FAF7F7`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
What's broken

[Body paragraph]
The assumption underlying most engagement is flawed: that relationships 
can be managed like processes. That trust can be designed like interfaces. 
That connection can be optimized like conversion funnels.

[Body paragraph]
This has led us to treat engagement as a feature — something to be bolted 
on and measured in clicks. We've reduced human relationships to "journeys" 
that can be mapped and "touchpoints" that can be optimized.

[Body paragraph]
The result: experiences that feel engineered, communications that feel 
automated, relationships that feel hollow.

[Body paragraph]
The assumption is that more technology will fix this. It won't — unless 
the thinking behind it changes first.
```

---

## Section 4 — Engagement as a system
*Background: secondary (`#F3EFF0`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
Engagement as a system

[Body paragraph]
There is another way. Instead of treating engagement as a feature, 
we can approach it as a system — a living, adaptive architecture that 
operates with intelligence and speed.

[Body paragraph]
Systems think differently. They don't optimize for individual interactions; 
they optimize for relationship health over time. They don't maximize 
short-term metrics; they build conditions for long-term trust.

[Body paragraph]
A good system enables movement, not delay. It creates leverage through 
well-timed micro-interactions — small, purposeful actions that compound 
into meaningful change.
```

---

## Section 5 — Trust through action
*Background: primary (`#FAF7F7`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
Trust through action

[Body paragraph]
Trust is not something that can be manufactured or demanded. It accumulates 
through consistent, intelligent interaction — knowing when to act, 
how to respond, what matters.

[Body paragraph]
This requires judgment: the ability to understand context, anticipate needs, 
and respond with genuine relevance. Speed matters. Precision matters. 
The right action at the right moment creates disproportionate impact.

[Body paragraph — bold]
We believe the future belongs to organizations that understand this — 
that invest in systems that enable fast, intelligent, trust-building 
engagement at scale.

[Horizontal rule divider]

[Text link]
What we enable →
Link: /enable
```

---

---

# Page 3: What We Enable (`/enable`)

## Section 1 — Hero
*Background: primary (`#FAF7F7`)*
*Padding: 120px 48px 100px*
*Max content width: 780px*

```
[Label — eyebrow]
WHAT WE ENABLE

[H1]
Intelligent Relationships

[Subtitle]
Lybi enables organizations to build and sustain high-stakes, ongoing 
relationships with their customers — at the speed and scale that 
modern organizations demand.
```

---

## Section 2 — Three pillars
*Background: secondary (`#F3EFF0`)*
*Padding: 96px 48px*
*Layout: 3-column grid, max-width 1000px, gap 48px*

```
[Column 1]
Title (H3): Systemic engagement
Bullets:
• Continuous, not campaign-based
• Driven by empathy, not just rules
• Responsive to context, not just triggers
• Relational, not transactional

[Column 2]
Title (H3): Built for complexity
Bullets:
• Scales from thousands to millions
• Operates in regulated environments
• Integrates with existing operations
• Works across channels and stakeholders

[Column 3]
Title (H3): One system, many expressions
Bullets:
• Customer engagement
• Customer communication
• Customer relationships
• Customer-facing journeys
```

---

## Section 3 — How we think
*Background: primary (`#FAF7F7`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
How we think

[Body paragraph]
We believe that meaningful change happens through leverage — small, 
well-placed actions that compound into significant impact. Systems don't 
have to be heavy to be powerful.

[Body paragraph]
The best engagement is responsive and intelligent: it reads context, makes 
good decisions in real time, and creates momentum. Depth comes from 
precision, not from slowness.

[Body paragraph]
We work with organizations that understand this — that see engagement as 
a source of strategic advantage, not as overhead. Organizations ready to 
move with intention and speed.
```

---

## Section 4 — Banner
*Background: secondary (`#F3EFF0`)*
*Padding: 80px 48px*
*Text centered*

```
[H2 — centered, 30px]
Products evolve. Systems endure.

[Primary button — centered]
Learn more about us →
Link: /about
```

---

---

# Page 4: About (`/about`)

## Section 1 — Hero
*Background: primary (`#FAF7F7`)*
*Padding: 120px 48px 100px*
*Max content width: 780px*

```
[Label — eyebrow]
ABOUT LYBI

[H1]
Operating engagement at scale

[Subtitle]
We help organizations rebuild trust with their customers — through systems 
that understand context, hold memory, and act with judgment.
```

---

## Section 2 — Who we are
*Background: secondary (`#F3EFF0`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
Who we are

[Body paragraph]
LYBI approaches engagement as a discipline — one that requires judgment, 
operating rigor, and a deep understanding of how trust accumulates over time.

[Body paragraph]
We work with organizations navigating complexity: large-scale operations, 
high-stakes decisions, and relationships that matter. Our focus is on 
enabling these organizations to engage meaningfully — at speed and at scale.

[Body paragraph]
Our team brings experience from leading complex organizations, operating 
under constraints, and making decisions with real consequences. We understand 
what it means to be accountable for long-term outcomes.
```

---

## Section 3 — How we think
*Background: primary (`#FAF7F7`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
How we think

[Body paragraph]
We believe that meaningful change happens through leverage — small, 
well-placed actions that compound into significant impact. Systems don't 
have to be heavy to be powerful.

[Body paragraph]
The best engagement is responsive and intelligent: it reads context, makes 
good decisions in real time, and creates momentum. Depth comes from 
precision, not from slowness.

[Body paragraph]
We work with organizations that see engagement as a source of strategic 
advantage — not as overhead. Organizations ready to move with intention 
and speed.
```

---

## Section 4 — Our Team
*Background: secondary (`#F3EFF0`)*
*Padding: 96px 48px*
*Max content width: 780px*

```
[H2]
Our Team

[Layout: 3-column grid, gap 40px]

[Horizontal rule above each card]

[Team member card — repeated 3 times]
Structure per card:
- Profile photo: circular, 72px diameter
  Placeholder: circle with background color #E5DFF0
- Horizontal rule divider (1px, rgba(0,0,0,0.08))
- Name: 17px, DM Sans, weight 500
- Role: 13px, brand purple
- Bio: 14px, secondary text, line-height 1.6
- LinkedIn icon: small, links to # (placeholder)

Card 1:
Name: Noa Assouline
Role: Founder
Bio: [placeholder — to be added]

Card 2:
Name: Hila Carmel
Role: Founder
Bio: [placeholder — to be added]

Card 3:
Name: Shlomi Zevin
Role: Chief Technology Officer
Bio: [placeholder — to be added]
```

```
[Text link — below grid]
Read our belief →
Link: /belief
```

---

---

## Implementation Notes

1. **Contact email** — replace `hello@lybi.ai` with the correct founders' email before publishing
2. **LinkedIn URL** — replace placeholder with actual Lybi company LinkedIn page URL
3. **Team photos** — replace circular placeholders with actual photos when ready
4. **Team bios** — replace placeholder text with actual bios when ready
5. **Team LinkedIn links** — add individual LinkedIn profile URLs when ready
6. **Mobile** — ensure all sections stack to single column on mobile, maintain padding consistency
