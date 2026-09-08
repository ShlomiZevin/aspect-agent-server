# otto-identity-brief.md — answer from gpt-5.6

_2026-09-08T05:50:39.678Z · 173s_

---

Keep the violet. Reject the robot and the factory-floor image.

## A. Direction

“Super techy but for an SMB retailer” means the **output looks like dependable retail software, while the building process looks visibly automated**.

### The two failure modes

1. **Enterprise-software bunker**  
   Dense gray toolbars, tiny type, nested panels, unexplained icons, internal jargon and twelve controls before the user sees their data.

   **Fix:** one primary screen, familiar tables and filters, 40px controls, 44px table rows, plain Hebrew labels and a visible approval step.

2. **Consumer AI toy**  
   Purple gradients, glowing chat bubbles, sparkles, a talking robot, oversized prompts and whimsical loading animation.

   **Fix:** keep Otto’s identity to one functional mark, restrained violet state indicators and precise process language. No anthropomorphic copy or decorative motion.

### Layout and emphasis

Keep the current structure:

```css
grid-template-columns: minmax(0, 1fr) 380px;
```

- Chat remains fixed at `380px`.
- Separate it from the canvas with a `1px solid #EAE3F3` border on its left.
- Canvas padding: `32px` when the viewport is at least `1440px`; otherwise `24px`.
- Built screen: `width: 100%`, `max-width: 1100px`, centered.
- Do not put an Otto logo, illustration or persistent pattern behind the built screen.

The current solid-violet plan card is too visually competitive. Violet should indicate decisions and active state, not occupy large surfaces.

### Palette

Keep `#6D28D9`. It connects Otto to the Intelligence Center, works well on white and is already distinctive enough. Do not introduce cyan, electric blue or another “technology” accent.

| Role | Colour | Use |
|---|---:|---|
| Canvas ground | `#F8F5FC` | Area around the built screen |
| Primary surface | `#FFFFFF` | Chat, cards, built screen |
| Primary ink | `#241A38` | Headings and body text |
| Muted ink | `#6E6584` | Secondary text, timestamps, placeholders |
| Accent | `#6D28D9` | Primary actions, active phase, focus, Otto mark |
| Accent hover | `#5B21B6` | Hover and pressed primary actions |
| Accent soft | `#F1EAFE` | User messages, selected rows, soft status areas |
| Decorative hairline | `#EAE3F3` | Card and table separators only |
| Control border | `#9A8EAA` | Inputs, selects and unchecked controls |
| Plan border | `#CDB7F3` | Approval card outline |
| Success surface | `#EAF7F0` | Success badges |
| Success text | `#176B45` | Success text |
| Warning surface | `#FFF4DD` | Warning and low-stock badges |
| Warning text | `#8A4B08` | Warning text |
| Error surface | `#FFF0EE` | Error badges |
| Error text | `#B42318` | Error text |

Checked contrast:

- `#241A38` on white: approximately `16.4:1`.
- `#6E6584` on white: approximately `5.45:1`.
- `#6D28D9` on white: approximately `7.1:1`.
- White on `#6D28D9`: approximately `7.1:1`.
- `#6D28D9` on `#F1EAFE`: approximately `6.1:1`.
- `#9A8EAA` against white: approximately `3.08:1`, suitable for control boundaries.
- The status text/background combinations above all exceed `5.8:1`.

`#EAE3F3` does not have enough contrast to define an input. Keep it for decorative separators only.

### Typography

Replace Public Sans with **Noto Sans Hebrew**, available free from Google Fonts. Public Sans does not provide a coherent native Hebrew interface; the current implementation is likely mixing it with a browser fallback.

```css
font-family: "Noto Sans Hebrew", Arial, sans-serif;
```

Use only weights `400`, `500`, `600` and `700`.

| Role | Size / line-height | Weight |
|---|---:|---:|
| Built-screen title | `22px / 30px` | `700` |
| Chat header title | `18px / 26px` | `700` |
| Section heading | `16px / 24px` | `700` |
| Body and chat messages | `14px / 22px` | `400` |
| Inputs | `14px / 20px` | `400` |
| Buttons and labels | `13px / 20px` | `600` |
| Table cells | `13px / 20px` | `400` |
| Table headings | `13px / 20px` | `600` |
| Metadata | `12px / 18px` | `500` |

Use:

```css
font-variant-numeric: tabular-nums;
```

for prices, quantities, percentages and dates.

### Spacing and components

Use a `4px` base grid:

- `4px`: icon-to-label details
- `8px`: compact internal gap
- `12px`: related controls
- `16px`: card padding and chat padding
- `24px`: section separation
- `32px`: canvas padding on large screens

Dimensions:

- Standard input and button height: `40px`
- Compact table action height: `32px`
- Table header height: `40px`
- Table row height: `44px`
- Chat header height: `56px`
- Phase strip height: `40px`
- Chat composer minimum height: `44px`; maximum expanded height: `144px`
- Chat bubble maximum width: `304px`

### Corner radius

- Built-screen frame: `12px`
- Cards and plan card: `10px`
- Inputs and buttons: `8px`
- User message bubbles: `10px`
- Status badges: `6px`
- Avatar: `8px`
- Only small categorical chips may use `999px`; do not make every control pill-shaped.

### Borders and shadows

Use borders for almost everything.

- Cards and tables: `1px solid #EAE3F3`
- Inputs: `1px solid #9A8EAA`
- Focus:

```css
outline: 2px solid #6D28D9;
outline-offset: 2px;
```

Use one shadow only, on the built-screen frame:

```css
box-shadow:
  0 1px 2px rgba(36, 26, 56, 0.06),
  0 8px 24px rgba(36, 26, 56, 0.07);
```

No shadows on chat messages, buttons, cards or the chat column.

### Phase and approval treatment

Replace the three filled chips with a flat three-column status strip:

- Labels, in RTL order: `שיחה`, `תוכנית`, `בנייה`
- Each cell takes one-third of the `380px` column.
- Active label: `#6D28D9`, `13px/20px`, weight `700`.
- Active indicator: `2px` line along the bottom of its cell.
- Completed label: `#241A38` with a `12px` SVG check icon.
- Inactive label: `#6E6584`.
- No chip backgrounds.

Change the plan card to:

```css
background: #FFFFFF;
border: 1px solid #CDB7F3;
border-inline-start: 3px solid #6D28D9;
border-radius: 10px;
padding: 16px;
```

Exact labels:

- Title: `תוכנית הבנייה`
- Introduction: `זה מה שאוטו יבנה:`
- Primary action: `אישור ובנייה`
- Secondary action: `שינוי התוכנית`

The primary action is violet. The card itself is not.

### Build state

Replace the generic indeterminate bar with three real build stages:

1. `מכין את מבנה המסך`
2. `מחבר את הנתונים`
3. `בודק ומסיים`

Each row is `32px` high. Completed stages use a `16px` SVG check icon and `#176B45`. The active stage uses a `16px` spinner in `#6D28D9`, rotating once every `900ms`. Future stages use `#6E6584`.

Do not display a fake percentage.

### Surface treatment

- No glass effects.
- No blurred colour blobs.
- No noise texture.
- No tonal gradients.
- No dark “command center” treatment.
- Tables use `#F8F5FC` headers, white rows and `#F7F2FD` hover.
- Selected rows use `#F1EAFE`.
- Do not use zebra striping.

Retail relevance should come from real nouns, examples, tables, stock states, dates and currency—not warehouse decoration.

---

## B. Otto does not get a figure

No. A futuristic robot would turn an approval-based operational tool into a consumer AI product. It would also compete with the screen being built and become irritating by the tenth session.

Otto’s presence should come from a **screen-building mark, precise state language and consistent placement**.

### Replace the “OT” avatar

Use a custom SVG mark built from basic shapes. No licensed asset is required.

At `30×30px`:

```svg
<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="30" height="30" rx="8" fill="#6D28D9"/>
  <rect x="7.25" y="7.25" width="15.5" height="15.5" rx="2.25"
        stroke="#FFFFFF" stroke-width="1.5"/>
  <path d="M7.5 11.75H22.5" stroke="#FFFFFF" stroke-width="1.5"/>
  <path d="M13.5 15.25H20" stroke="#FFFFFF" stroke-width="1.5"
        stroke-linecap="round"/>
  <path d="M15.5 18.5H20" stroke="#FFFFFF" stroke-width="1.5"
        stroke-linecap="round"/>
  <rect x="9.75" y="15" width="2.75" height="5.25" rx="0.75" fill="#FFFFFF"/>
</svg>
```

It reads as a screen with assembled content, not a generic chatbot.

Use it:

- `30px` in the chat header.
- `24px` beside Otto’s messages.
- Never inside the built screen.
- Never as a watermark.
- Never larger than `40px`, including the empty state.

Chat header:

- Title: `אוטו`
- Idle status: `מוכן לתכנון`
- Planning status: `מכין תוכנית`
- Build status: `בונה את המסך`

The mark remains static. State is communicated through text and the functional spinner, not character animation.

---

## C. Background

A factory-floor background would look cheap. It is too literal, excludes retailers that are not manufacturers, reduces text legibility and makes generated imagery part of a tool that needs to age well.

Use no environmental photography or illustration.

The only background treatment belongs in the canvas empty state, before the first screen exists. Use a restrained construction grid implemented in CSS:

```css
.empty-canvas {
  background-color: #FFFFFF;
  background-image:
    linear-gradient(rgba(109, 40, 217, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(109, 40, 217, 0.045) 1px, transparent 1px);
  background-size: 24px 24px;
  border: 1px solid #EAE3F3;
  border-radius: 12px;
  min-height: 420px;
}
```

Remove the grid as soon as building starts.

Center a content block no wider than `560px`:

- Otto mark: `40px`
- Heading: `כאן ייבנה המסך שלכם`
- Body: `תארו בצ׳אט איזה מסך אתם צריכים ואילו נתונים הוא צריך להציג.`

Add three `36px` outlined example buttons beneath it:

- `מלאי מתחת למלאי הביטחון`
- `השוואת מכירות בין סניפים`
- `המלצת רכש לפי ספק`

Clicking one should insert the text into the composer, not start building automatically.

---

## D. Generation prompts

No generated images are approved, so there are no generation prompts. The Otto mark and empty-state grid should be built directly in SVG and CSS.

---

## E. The five changes that matter most

### 1. Replace the Hebrew typography

Load **Noto Sans Hebrew** and apply the type scale above. Set body and chat text to `14px/22px`, screen titles to `22px/30px`, and table text to `13px/20px`.

This removes the fallback-font look across every screen.

### 2. Stop large violet surfaces from competing with the built screen

Change the plan card from solid violet to white with:

- `1px #CDB7F3` border
- `3px #6D28D9` inline-start border
- `10px` radius
- `16px` padding

Keep solid violet only for `אישור ובנייה`, active state and focus. Give the built-screen frame the specified shadow and retain its `1100px` maximum width.

### 3. Replace the “OT” placeholder with the screen-building SVG mark

Use it at `30px` in the header and `24px` beside assistant messages. Remove initials, robots and generic sparkle symbols.

### 4. Replace phase chips and the indeterminate bar with explicit process states

Use the `40px` three-column strip and the three build stages:

- `מכין את מבנה המסך`
- `מחבר את הנתונים`
- `בודק ומסיים`

This is the part that makes Otto look technologically credible rather than cosmetically “techy.”

### 5. Replace the empty canvas with the functional construction-grid state

Use the `24px` CSS grid, `420px` minimum-height panel, exact Hebrew copy and three retail-specific prompt buttons. Do not use factory imagery.
