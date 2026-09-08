# otto-centre-brief.md — answer from gpt-5.6

_2026-09-08T06:59:12.206Z · 138s_

---

## 1. Palette — complete and final

Use these token names directly. Do not introduce another brand colour.

```css
:root {
  /* Core */
  --label-stock: #F6F7F4;
  --ledger-ink: #18201B;
  --receiving-orange: #B54708;

  /* Surfaces */
  --paper: #FFFFFF;
  --field-stock: #ECEFEA;
  --pressed-stock: #E1E5E0;

  /* Text */
  --ink-muted: #566159;

  /* Rules */
  --rule: #C9D0CA;
  --rule-strong: #8E9991;

  /* Interaction only */
  --receiving-orange-hover: #913806;
  --receiving-orange-active: #712B05;
  --receiving-orange-wash: #FBEBDD;

  /* Operational outcomes */
  --success-ink: #25613D;
  --success-stock: #E8F2EC;
  --risk-ink: #A1262F;
  --risk-stock: #F9E9EB;
}
```

### Usage

- App background: `--label-stock`.
- Built screen surface: `--paper`.
- Primary text and current process state: `--ledger-ink`.
- Secondary text: `--ink-muted`.
- Inputs and inactive process segments: `--field-stock`.
- Borders: `--rule`.
- Buttons, links, selected controls and focus rings: `--receiving-orange`.
- Errors and blocked states: `--risk-ink`; never orange.
- Successful completion: `--success-ink`.
- Otto’s joints and chest band: `--ledger-ink`, not orange.
- Otto’s face panel: `--ledger-ink`.
- Otto’s horizontal indicator: `--label-stock`.

Orange on `--label-stock` has approximately **5.0:1** contrast. White text on orange has approximately **5.4:1**. `--ink-muted` on `--label-stock` is approximately **6.0:1**. `--risk-ink` and `--success-ink` both exceed **6:1** on their light surfaces.

Use **Noto Sans Hebrew**, available under the SIL Open Font License.

```css
font-family: "Noto Sans Hebrew", Arial, sans-serif;
```

---

## 2. Centre arrangement

### Geometry

Do **not** create a real third grid column. It would directly take width from the built screen, which is the wrong trade.

Keep the existing two-column grid and place Otto on the boundary as an absolutely positioned bridge. The centre zone has a visual width but zero layout allocation.

#### Desktop: 1280px and wider

- Canvas zone: `calc(100% - 360px)`.
- Conversation rail: `360px`.
- Allocated centre column: `0`.
- Visual centre zone: `72px`, extending `36px` into each side.
- Built screen: still capped at `1100px`; no width is subtracted for Otto.
- Otto PNG: `72 × 94px`.
- Otto’s horizontal centre: exactly on the canvas/rail boundary.
- Otto top: `150px`.
- Status surface: `228 × 124px`.
- Status surface top: `16px`.
- Status surface left edge: `16px` inside the conversation rail.
- Tail: bottom-left, pointing diagonally toward Otto.
- Remove the existing `280 × 112px` rail status card. Do not keep both.

Putting the status surface mostly inside the rail prevents it from covering the built screen. Only half of Otto overlaps the canvas edge.

```css
.workspace {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  grid-template-areas: "canvas conversation";
  min-width: 0;
  direction: ltr; /* geometry only */
  background: var(--label-stock);
}

.canvas {
  grid-area: canvas;
  min-width: 0;
  direction: rtl;
}

.conversation {
  grid-area: conversation;
  min-width: 0;
  direction: rtl;
  border-inline-start: 1px solid var(--rule);
}

.built-screen {
  width: 100%;
  max-width: 1100px;
}

.otto-centre {
  position: absolute;
  z-index: 20;
  top: 0;
  left: calc(100% - 360px);
  width: 0;
  pointer-events: none;
  direction: rtl;
}

.otto-character {
  position: absolute;
  top: 150px;
  left: -36px;
  width: 72px;
  height: 94px;
  object-fit: contain;
}

.otto-status {
  position: absolute;
  top: 16px;
  left: 16px;
  width: 228px;
  height: 124px;
}
```

The conversation rail must reserve the status surface’s vertical area, replacing the space previously occupied by the old status card:

```css
.conversation-scroll {
  padding-block-start: 152px;
}
```

Do not add canvas padding for Otto.

### Between 768px and 1279px

Keep the same two-column structure, but reduce the rail and Otto:

- Conversation rail: `320px`.
- Canvas: `calc(100% - 320px)`.
- Otto: `56 × 74px`.
- Status surface: `200 × 112px`.
- Otto top: `136px`.
- Status surface top: `14px`.
- Surface left edge: `12px` inside the rail.
- Conversation top reserve: `136px`.

```css
@media (max-width: 1279px) and (min-width: 768px) {
  .workspace {
    grid-template-columns: minmax(0, 1fr) 320px;
  }

  .otto-centre {
    left: calc(100% - 320px);
  }

  .otto-character {
    top: 136px;
    left: -28px;
    width: 56px;
    height: 74px;
  }

  .otto-status {
    top: 14px;
    left: 12px;
    width: 200px;
    height: 112px;
  }

  .conversation-scroll {
    padding-block-start: 136px;
  }
}
```

This breakpoint is less comfortable than desktop because the boundary is tighter, but the built screen still loses no width.

### Phone: below 768px

Do not display conversation and canvas side by side. Use a mode switch with Otto literally between the two modes:

```text
[ שיחה ]   [ Otto ]   [ מסך ]
```

Exact geometry:

- Mode switch row: `56px` high.
- Left and right mode controls: each `minmax(0, 1fr)`.
- Otto centre cell: `48px`.
- Otto image: `40 × 52px`.
- Status surface: full-width minus `32px`, fixed `92px` high.
- Status surface sits directly below the mode switch.
- Tail points upward to Otto.
- Active pane begins below the `148px` combined header.
- The built screen remains full phone width.

```css
@media (max-width: 767px) {
  .workspace {
    display: block;
  }

  .desktop-otto-centre {
    display: none;
  }

  .mobile-mode-switch {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 48px minmax(0, 1fr);
    align-items: center;
    height: 56px;
    border-bottom: 1px solid var(--rule);
    direction: rtl;
  }

  .mobile-otto {
    width: 40px;
    height: 52px;
    justify-self: center;
    align-self: end;
    object-fit: contain;
    pointer-events: none;
  }

  .mobile-otto-status {
    position: relative;
    width: calc(100% - 32px);
    height: 92px;
    margin: 0 16px;
  }

  .mobile-pane {
    width: 100%;
    min-width: 0;
  }
}
```

Only one pane is visible at a time. Preserve each pane’s scroll position when switching.

---

### Status surface

Use a restrained rectangular speech surface with a small CSS notch. Do **not** use an illustrated or curved cartoon tail. That would make Otto look like the product mascot rather than a quiet operational status indicator.

#### Desktop construction

- Size: `228 × 124px`.
- Background: `--paper`.
- Border: `1px solid --rule`.
- Radius: `8px`.
- Shadow: `0 2px 8px rgb(24 32 27 / 0.08)`.
- Internal padding: `12px`.
- Tail: `12 × 12px` rotated square, positioned `10px` from the physical left edge and `-7px` below the surface.
- Title: `14px`, `700`, line-height `20px`.
- Supporting line: `12px`, `400`, line-height `17px`.
- Process labels: `10px`, `600`, line-height `14px`.
- No orange anywhere in the status surface.

```css
.otto-status {
  box-sizing: border-box;
  padding: 12px;
  overflow: visible;
  color: var(--ledger-ink);
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgb(24 32 27 / 0.08);
  direction: rtl;
}

.otto-status::after {
  content: "";
  position: absolute;
  bottom: -7px;
  left: 10px;
  width: 12px;
  height: 12px;
  background: var(--paper);
  border-inline-end: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  transform: rotate(45deg);
}

.otto-status__title {
  height: 20px;
  overflow: hidden;
  color: var(--ledger-ink);
  font-size: 14px;
  font-weight: 700;
  line-height: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.otto-status__body {
  height: 34px;
  margin-block-start: 2px;
  overflow: hidden;
  color: var(--ink-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 17px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.otto-status__process {
  position: absolute;
  inset-inline: 12px;
  bottom: 10px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  height: 28px;
}
```

All text containers have fixed heights. New state content is placed in an absolutely positioned layer and crossfaded, so no text change can resize the surface or move Otto.

```css
.otto-status__state {
  position: absolute;
  inset: 12px 12px 42px;
  opacity: 0;
  transition: opacity 120ms linear;
}

.otto-status__state[data-active="true"] {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .otto-status__state {
    transition: none;
  }
}
```

Use `aria-live="polite"` on the title and supporting line container. Use `role="alert"` only for the error state.

---

### General status and process

Do not add a continuously running feed. It will imply that every generated line matters, create false urgency, and become exhausting during a forty-minute session.

Show three things only:

1. Current state title.
2. One supporting sentence explaining what Otto is doing or what is needed.
3. A fixed four-step process:
   - `שיחה`
   - `תכנון`
   - `אישור`
   - `בנייה`

The current step uses `--ledger-ink`; completed steps use `--ink-muted`; future steps use `--rule-strong`. Do not use orange because the process display is not an interaction.

```css
.process-step {
  color: var(--rule-strong);
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}

.process-step::after {
  content: "";
  display: block;
  height: 2px;
  margin-block-start: 4px;
  background: var(--field-stock);
  border-radius: 1px;
}

.process-step[data-state="complete"] {
  color: var(--ink-muted);
}

.process-step[data-state="complete"]::after {
  background: var(--rule-strong);
}

.process-step[data-state="current"] {
  color: var(--ledger-ink);
  font-weight: 700;
}

.process-step[data-state="current"]::after {
  background: var(--ledger-ink);
}
```

During building, subdivide only the final `בנייה` segment into three real stages. Do not display a percentage unless the backend can provide genuine progress.

```html
<div class="build-stage" aria-label="שלב 2 מתוך 3">
  <span data-state="complete"></span>
  <span data-state="current"></span>
  <span data-state="future"></span>
</div>
```

```css
.build-stage {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  margin-block-start: 4px;
}

.build-stage > span {
  height: 2px;
  background: var(--field-stock);
}

.build-stage > [data-state="complete"] {
  background: var(--rule-strong);
}

.build-stage > [data-state="current"] {
  background: var(--ledger-ink);
}
```

State changes must be tied to real application events, not timers.

---

### Exact Hebrew

| State | Current process | Title | Supporting line |
|---|---|---|---|
| Idle, no screen | שיחה | `מתחילים בשיחה` | `ספרו לי מה צריך להיות במסך.` |
| Idle, screen exists | שיחה | `מוכנים לשינוי הבא` | `ספרו מה לשנות. התוכנית הבאה תציג רק את ההבדל.` |
| Gathering requirements | שיחה | `מחדדים את הבקשה` | `אני אוסף מטרות, נתונים וכללים לפני התכנון.` |
| Data cannot answer request | שיחה | `אין מספיק נתונים` | `מקור הנתונים לא יכול לענות על הבקשה הזאת.` |
| Ready to plan | תכנון | `אפשר להכין תוכנית` | `יש מספיק מידע. אפשר לעבור לתכנון.` |
| Plan awaiting approval | אישור | `התוכנית מחכה לאישור` | `בדקו את השינויים ואשרו כדי להתחיל לבנות.` |
| Build stage 1 of 3 | בנייה, 1/3 | `מכין את המבנה` | `יוצר את האזורים והרכיבים של המסך.` |
| Build stage 2 of 3 | בנייה, 2/3 | `מחבר את הנתונים` | `ממפה שדות, סינון וחישובים.` |
| Build stage 3 of 3 | בנייה, 3/3 | `מרכיב את המסך` | `מחיל את העיצוב ובודק את התוצאה.` |
| Just built | בנייה complete | `המסך מוכן` | `אפשר לבדוק אותו ולבקש שינוי.` |
| Discussing a change | שיחה | `מגדירים את השינוי` | `התוכנית הבאה תכלול רק את ההבדל.` |
| Error | Current failed step | `הבנייה נעצרה` | `המסך הקודם נשמר. נסו שוב או שנו את התוכנית.` |

For `אין מספיק נתונים`, keep the title in `--ledger-ink`. It is a capability limitation, not necessarily a system error.

For `הבנייה נעצרה`, use `--risk-ink` for the title and a `3px` risk-coloured block-start indicator inside the fixed process segment. Do not change the bubble border thickness or dimensions.

Approval and retry buttons remain in the conversation rail, not inside the status surface.

---

### Whether Otto moves

No. Making him “the constructor” does not justify body animation.

Do not animate his arms, body, head, position or scale. That would turn a persistent operational indicator into a performance.

The minimum that reads as working is:

- Real transitions through the three build stages.
- The face indicator changes discretely at each stage:
  - Stage 1: line width `14px`.
  - Stage 2: line width `22px`.
  - Stage 3: line width `30px`.
  - Complete: line width `18px`.
  - Error: line width `10px`, using `--risk-ink`.
- Crossfade between indicator assets over `120ms`.
- No pulse, sweep, bounce or loop.

These face-line variants require four additional transparent PNG renders, or one separate SVG/HTML indicator layered over the existing face panel. Use the layered indicator; it avoids rerendering the entire character and remains free.

---

## What to change first

First, remove the existing rail status card and implement the boundary anchor, fixed `228 × 124px` status surface, and `72 × 94px` static Otto. Do that before wiring copy or build progress. If the geometry is wrong, every later state will compete with the built screen; the state machine cannot fix that.
