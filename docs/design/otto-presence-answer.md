# otto-presence-brief.md — answer from gpt-5.6

_2026-09-08T06:10:45.178Z · 266s_

---

## 1. Otto’s presence

### Decision

Otto lives in the **right workflow rail**, not in the empty-state canvas and never inside the generated screen.

Use a static, compact status card throughout the workflow:

- Workflow rail: `304px` wide.
- Otto card: `280px × 112px`.
- Placement: first item in the rail, `12px` from the top and sides.
- Position: sticky within the rail scroller.
- Robot render: `72px × 104px`, anchored to the card’s bottom-left.
- The generated screen remains in the main canvas and never sits behind Otto.

Otto is persistent while the workflow rail is open. He disappears when the user deliberately collapses that rail. Do not automatically pop him open, float him over the iframe or put him back in the central empty state.

That resolves the wear-out problem: the **status surface persists**, but the character stays small, static and outside the work product. He does not greet, congratulate, wave or initiate conversation.

Do not call him “manager” in the interface. The user is the approval authority. Otto reports status as the technical employee. There should be no `מנהל` label anywhere.

### Replace the phase chips

Remove the three phase chips.

The Otto card shows only:

1. Current phase as a small label.
2. One current-status line.
3. A `1 מתוך 3` indicator during building.

Showing Otto plus the complete chip strip is redundant. Approval buttons remain on the plan card, not inside Otto’s status card.

### Exact Hebrew strings

| State | Phase label | Status line |
|---|---|---|
| Idle, no screen yet | `שיחה` | `מוכן. מה בונים עכשיו?` |
| Idle, existing screen | `שיחה` | `מוכן לשינוי הבא.` |
| Gathering requirements | `שיחה` | `מחדד את הדרישות.` |
| Request unsupported by the data | `שיחה` | `הנתונים לא יכולים לענות על זה.` |
| Ready to create a plan | `שיחה` | `אפשר לעבור לתוכנית.` |
| Plan awaiting approval | `תוכנית` | `התוכנית מחכה לאישור שלך.` |
| Building, stage 1 | `בנייה · 1 מתוך 3` | `מכין את מבנה המסך.` |
| Building, stage 2 | `בנייה · 2 מתוך 3` | `מחבר את הנתונים.` |
| Building, stage 3 | `בנייה · 3 מתוך 3` | `מסיים ובודק.` |
| Just built | `בדיקה` | `המסך מוכן לבדיקה.` |
| Discussing a change | `שיחה · שינוי` | `מגדיר את השינוי הבא.` |
| Error | `נדרשת פעולה` | `הפעולה נעצרה. אפשר לנסות שוב.` |

Show `המסך מוכן לבדיקה.` for eight seconds, then change to `מוכן לשינוי הבא.` unless the user has already started a change.

The generic error line must not replace the actual diagnostic. Put the diagnostic immediately below the failed operation with these controls:

- Primary action: `נסה שוב`
- Secondary action: `הצג פרטים`

### Image treatment

Do not use `mix-blend-mode: multiply`. It will dirty the white shell, alter the violet and make the dark face panel dependent on the surface behind it.

Key the white background to transparency and export a new asset:

- Select the background contiguously from the four corners.
- White threshold: RGB channels `248–255`.
- Edge feather: `0.75px`.
- Manually restore any white shell pixels removed by the key.
- Remove white edge contamination by `1px`.
- Export as lossless WebP with alpha.
- Minimum asset size: `216px × 312px`, displayed at `72px × 104px`.
- Do not add a new rendered glow or drop shadow.

The card’s portrait well is `#F4F5F7`, which separates the white shell from the surface. Crop the stable base `2px` below the lower edge of the card. That bottom anchoring, transparent background and dedicated portrait well are what stop it looking like a square photograph pasted into the interface.

### Exact card construction

Visual order from left to right:

- `84px` portrait well.
- Status copy on the right.
- Hebrew copy remains RTL.

```css
.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 304px;
  grid-template-areas: "canvas rail";
  min-height: 100%;
}

.workspace__canvas {
  grid-area: canvas;
  min-width: 0;
}

.workflow-rail {
  grid-area: rail;
  width: 304px;
  background: #F7F8FA;
  border-left: 1px solid #D9DCE3;
  overflow-y: auto;
}

.otto-status {
  position: sticky;
  top: 12px;
  z-index: 2;

  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  direction: ltr;

  width: 280px;
  height: 112px;
  margin: 12px;
  overflow: hidden;

  background: #FFFFFF;
  border: 1px solid #D9DCE3;
  border-radius: 12px;
  box-shadow: none;
}

.otto-status__portrait {
  position: relative;
  overflow: hidden;
  background: #F4F5F7;
  border-right: 1px solid #D9DCE3;
}

.otto-status__portrait img {
  position: absolute;
  left: 50%;
  bottom: -2px;
  width: 72px;
  height: 104px;
  object-fit: contain;
  object-position: center bottom;
  transform: translateX(-50%);
}

.otto-status__copy {
  direction: rtl;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: 12px 14px;
  text-align: right;
}

.otto-status__phase {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 4px;

  color: #5B6472;
  font: 700 12px/16px "Noto Sans Hebrew", sans-serif;
}

.otto-status__message {
  margin: 0;
  color: #171A21;
  font: 600 14px/20px "Noto Sans Hebrew", sans-serif;
}

.otto-status__activity {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: #6D28D9;
}

.otto-status[data-active="true"] .otto-status__activity {
  animation: otto-activity 1.4s ease-in-out infinite;
}

.otto-status[data-state="error"] .otto-status__activity {
  background: #B42318;
  animation: none;
}

@keyframes otto-activity {
  0%,
  100% { opacity: 0.42; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .otto-status__activity {
    animation: none !important;
  }
}
```

Use:

```html
<aside
  class="otto-status"
  data-active="true"
  data-state="building"
  role="status"
  aria-live="polite"
  aria-atomic="true"
  aria-label="מצב אוטו"
>
  <div class="otto-status__portrait">
    <img src="/assets/otto-status.webp" alt="">
  </div>

  <div class="otto-status__copy">
    <div class="otto-status__phase">
      <span class="otto-status__activity" aria-hidden="true"></span>
      <span>בנייה · 2 מתוך 3</span>
    </div>
    <p class="otto-status__message">מחבר את הנתונים.</p>
  </div>
</aside>
```

For errors, change `role="status"` to `role="alert"`.

### Animation

Do not animate the robot.

No head movement, body bobbing, clipboard movement, light-bar scanning, blinking or waving. The status role does not justify mascot animation.

The only continuous motion is the `6px` activity dot during requirement processing and building. It changes opacity without glow. State-copy changes may use a `120ms` opacity crossfade. Nothing slides or bounces.

---

## 2. Colour

### Decision

Keep `#6D28D9`.

Changing Otto’s brand colour while generated screens open inside the violet Intelligence Center would make the same screen appear to belong to two products. The problem is not the hue; it is using violet as atmosphere.

Use violet only for:

- Primary actions.
- Links.
- Focus outlines.
- Checked controls.
- The current active selection.
- Otto’s existing joints and chest band.
- One chart series, but not the first series.

Do not use violet for:

- Page backgrounds.
- Header backgrounds.
- General cards.
- Table headers.
- KPI numbers.
- Loading skeletons.
- Generic status badges.
- Decorative gradients.
- Shadows or glows.
- Large empty-state illustrations.

Set the robot’s 3D material base to `#6D28D9`; normal lighting variation in the render is expected.

### Contrast checks

These pairs meet WCAG AA:

- `#171A21` on `#FFFFFF`: approximately `17:1`.
- `#5B6472` on `#FFFFFF`: approximately `6:1`.
- `#6D28D9` on `#FFFFFF`: approximately `7.1:1`.
- `#FFFFFF` on `#6D28D9`: approximately `7.1:1`.
- `#6D28D9` on `#F5F3FF`: approximately `6.5:1`.
- `#8A93A1` against `#FFFFFF`: approximately `3.1:1`; use it for control boundaries, not body text.
- Semantic badge text/background pairs below are all above `6:1`.

### Finished token set

```css
:root {
  color-scheme: light;

  /* Typography */
  --otto-font-sans:
    "Noto Sans Hebrew",
    "Noto Sans",
    Arial,
    sans-serif;

  /* Neutral surfaces */
  --otto-canvas: #F7F8FA;
  --otto-surface: #FFFFFF;
  --otto-surface-subtle: #F4F5F7;
  --otto-surface-hover: #ECEFF3;
  --otto-surface-disabled: #F1F2F4;

  /* Text */
  --otto-text: #171A21;
  --otto-text-secondary: #5B6472;
  --otto-text-placeholder: #667085;
  --otto-text-disabled: #5B6472;

  /* Borders */
  --otto-border: #D9DCE3;
  --otto-border-strong: #AEB4C0;
  --otto-border-control: #8A93A1;

  /* Brand accent */
  --otto-accent: #6D28D9;
  --otto-accent-hover: #5B21B6;
  --otto-accent-active: #4C1D95;
  --otto-accent-subtle: #F5F3FF;
  --otto-accent-border: #C4B5FD;

  /* Semantic colours */
  --otto-success-text: #166534;
  --otto-success-bg: #F0FDF4;
  --otto-success-border: #86EFAC;

  --otto-warning-text: #854D0E;
  --otto-warning-bg: #FFFBEB;
  --otto-warning-border: #FDE68A;

  --otto-danger-text: #B42318;
  --otto-danger-bg: #FEF3F2;
  --otto-danger-border: #FDA29B;

  --otto-info-text: #075985;
  --otto-info-bg: #F0F9FF;
  --otto-info-border: #7DD3FC;

  --otto-neutral-status-text: #374151;
  --otto-neutral-status-bg: #F3F4F6;
  --otto-neutral-status-border: #D1D5DB;

  /* Data visualisation: first series is not violet */
  --otto-chart-1: #2563EB;
  --otto-chart-2: #0F766E;
  --otto-chart-3: #B45309;
  --otto-chart-4: #7C3AED;
  --otto-chart-5: #BE123C;
  --otto-chart-6: #4B5563;

  /* Dimensions */
  --otto-radius-sm: 6px;
  --otto-radius-md: 8px;
  --otto-radius-lg: 10px;

  --otto-control-height: 36px;
  --otto-row-height: 44px;

  --otto-space-1: 4px;
  --otto-space-2: 8px;
  --otto-space-3: 12px;
  --otto-space-4: 16px;
  --otto-space-5: 24px;
  --otto-space-6: 32px;
}
```

Noto Sans Hebrew is free under the SIL Open Font License 1.1. The iframe does not inherit font loading from the parent document. Serve the already-shipped WOFF2 asset to the iframe; do not call Google Fonts at runtime.

```css
@font-face {
  font-family: "Noto Sans Hebrew";
  src: url("/assets/fonts/NotoSansHebrew-Variable.woff2") format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}
```

### Base stylesheet for generated apps

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  direction: rtl;
  min-height: 100%;
  background: var(--otto-canvas);
  color: var(--otto-text);
  font-family: var(--otto-font-sans);
  font-size: 14px;
  line-height: 1.5;
  text-rendering: optimizeLegibility;
}

body {
  min-height: 100%;
  margin: 0;
  background: var(--otto-canvas);
  color: var(--otto-text);
}

button,
input,
select,
textarea {
  font: inherit;
}

button,
a,
input,
select,
textarea {
  -webkit-tap-highlight-color: transparent;
}

a {
  color: var(--otto-accent);
  font-weight: 600;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

a:hover {
  color: var(--otto-accent-hover);
}

a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
[tabindex]:focus-visible {
  outline: 3px solid var(--otto-accent);
  outline-offset: 2px;
}

/* Application frame */

.app-shell {
  min-height: 100%;
  padding: 24px;
}

.app-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-block-end: 20px;
}

.app-header__copy {
  min-width: 0;
}

.app-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

h1,
h2,
h3,
p {
  margin-block-start: 0;
}

h1 {
  margin-block-end: 4px;
  color: var(--otto-text);
  font-size: 24px;
  font-weight: 700;
  line-height: 32px;
}

h2 {
  margin-block-end: 12px;
  color: var(--otto-text);
  font-size: 18px;
  font-weight: 700;
  line-height: 26px;
}

h3 {
  margin-block-end: 8px;
  color: var(--otto-text);
  font-size: 15px;
  font-weight: 700;
  line-height: 22px;
}

.app-subtitle,
.text-secondary {
  color: var(--otto-text-secondary);
  font-size: 14px;
  line-height: 20px;
}

/* Surfaces */

.card {
  background: var(--otto-surface);
  border: 1px solid var(--otto-border);
  border-radius: var(--otto-radius-lg);
  box-shadow: none;
}

.card__header {
  padding: 16px 16px 12px;
  border-block-end: 1px solid var(--otto-border);
}

.card__body {
  padding: 16px;
}

/* Filters */

.filter-bar {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-block-end: 16px;
  padding: 12px;

  background: var(--otto-surface);
  border: 1px solid var(--otto-border);
  border-radius: var(--otto-radius-lg);
}

.field {
  display: grid;
  gap: 5px;
  min-width: 160px;
}

.field--grow {
  flex: 1 1 240px;
}

.field__label {
  color: var(--otto-text-secondary);
  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
}

.input,
.select,
.textarea {
  width: 100%;
  color: var(--otto-text);
  background: var(--otto-surface);
  border: 1px solid var(--otto-border-control);
  border-radius: var(--otto-radius-sm);
}

.input,
.select {
  height: var(--otto-control-height);
  padding-inline: 10px;
}

.textarea {
  min-height: 88px;
  padding: 9px 10px;
  resize: vertical;
}

.input::placeholder,
.textarea::placeholder {
  color: var(--otto-text-placeholder);
  opacity: 1;
}

.input:hover,
.select:hover,
.textarea:hover {
  border-color: var(--otto-text-secondary);
}

.input:disabled,
.select:disabled,
.textarea:disabled {
  color: var(--otto-text-disabled);
  background: var(--otto-surface-disabled);
  border-color: var(--otto-border);
  cursor: not-allowed;
  opacity: 1;
}

input[type="checkbox"],
input[type="radio"] {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--otto-accent);
}

input[type="number"],
input[type="date"],
input[type="time"],
.ltr-value {
  direction: ltr;
  unicode-bidi: isolate;
}

/* Buttons */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;

  min-height: var(--otto-control-height);
  padding: 0 14px;

  color: var(--otto-text);
  background: var(--otto-surface);
  border: 1px solid var(--otto-border-control);
  border-radius: var(--otto-radius-sm);

  font-weight: 700;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}

.btn:hover {
  background: var(--otto-surface-subtle);
}

.btn:active {
  background: var(--otto-surface-hover);
}

.btn--primary {
  color: #FFFFFF;
  background: var(--otto-accent);
  border-color: var(--otto-accent);
}

.btn--primary:hover {
  color: #FFFFFF;
  background: var(--otto-accent-hover);
  border-color: var(--otto-accent-hover);
}

.btn--primary:active {
  background: var(--otto-accent-active);
  border-color: var(--otto-accent-active);
}

.btn--danger {
  color: #FFFFFF;
  background: var(--otto-danger-text);
  border-color: var(--otto-danger-text);
}

.btn--danger:hover {
  color: #FFFFFF;
  background: #912018;
  border-color: #912018;
}

.btn--quiet {
  padding-inline: 10px;
  color: var(--otto-text-secondary);
  background: transparent;
  border-color: transparent;
}

.btn--quiet:hover {
  color: var(--otto-text);
  background: var(--otto-surface-hover);
}

.btn:disabled,
.btn[aria-disabled="true"] {
  color: var(--otto-text-disabled);
  background: var(--otto-surface-disabled);
  border-color: var(--otto-border);
  cursor: not-allowed;
  opacity: 1;
}

/* Metrics and operational numbers */

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-block-end: 16px;
}

.metric {
  min-width: 0;
  padding: 16px;
  background: var(--otto-surface);
  border: 1px solid var(--otto-border);
  border-radius: var(--otto-radius-lg);
}

.metric__label {
  margin-block-end: 6px;
  color: var(--otto-text-secondary);
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}

.metric__value,
.num {
  direction: ltr;
  unicode-bidi: isolate;
  font-variant-numeric: tabular-nums lining-nums;
}

.metric__value {
  color: var(--otto-text);
  font-size: 32px;
  font-weight: 700;
  line-height: 40px;
}

.metric__delta {
  margin-block-start: 6px;
  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
}

.metric__delta--positive {
  color: var(--otto-success-text);
}

.metric__delta--negative {
  color: var(--otto-danger-text);
}

/* Tables */

.table-frame {
  width: 100%;
  overflow: auto;
  background: var(--otto-surface);
  border: 1px solid var(--otto-border);
  border-radius: var(--otto-radius-lg);
}

.data-table {
  width: 100%;
  min-width: 640px;
  border-spacing: 0;
  border-collapse: separate;
  color: var(--otto-text);
  background: var(--otto-surface);
}

.data-table th,
.data-table td {
  height: var(--otto-row-height);
  padding: 8px 12px;
  text-align: start;
  vertical-align: middle;
}

.data-table th {
  position: sticky;
  top: 0;
  z-index: 1;

  color: #3B4350;
  background: var(--otto-surface-subtle);
  border-block-end: 1px solid var(--otto-border);

  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
  white-space: nowrap;
}

.data-table td {
  border-block-end: 1px solid var(--otto-border);
  font-size: 14px;
  line-height: 20px;
}

.data-table tbody tr:last-child td {
  border-block-end: 0;
}

.data-table tbody tr:hover td {
  background: #F8F9FB;
}

.data-table th.num,
.data-table td.num {
  direction: ltr;
  text-align: right;
  unicode-bidi: isolate;
  font-variant-numeric: tabular-nums lining-nums;
}

.data-table .cell-secondary {
  color: var(--otto-text-secondary);
}

/* Status badges */

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;

  min-height: 24px;
  padding: 2px 8px;

  border: 1px solid;
  border-radius: 999px;

  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
  white-space: nowrap;
}

.status-badge::before {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: currentColor;
  content: "";
}

.status-badge--success {
  color: var(--otto-success-text);
  background: var(--otto-success-bg);
  border-color: var(--otto-success-border);
}

.status-badge--warning {
  color: var(--otto-warning-text);
  background: var(--otto-warning-bg);
  border-color: var(--otto-warning-border);
}

.status-badge--danger {
  color: var(--otto-danger-text);
  background: var(--otto-danger-bg);
  border-color: var(--otto-danger-border);
}

.status-badge--info {
  color: var(--otto-info-text);
  background: var(--otto-info-bg);
  border-color: var(--otto-info-border);
}

.status-badge--neutral {
  color: var(--otto-neutral-status-text);
  background: var(--otto-neutral-status-bg);
  border-color: var(--otto-neutral-status-border);
}

.status-badge--accent {
  color: var(--otto-accent-hover);
  background: var(--otto-accent-subtle);
  border-color: var(--otto-accent-border);
}

/* Empty state */

.empty-state {
  display: grid;
  place-items: center;
  min-height: 220px;
  padding: 32px;

  text-align: center;
  background: var(--otto-surface);
  border: 1px solid var(--otto-border);
  border-radius: var(--otto-radius-lg);
}

.empty-state__content {
  max-width: 400px;
}

.empty-state__mark {
  width: 40px;
  height: 40px;
  margin: 0 auto 14px;

  background-color: #FFFFFF;
  background-image:
    linear-gradient(#D9DCE3 1px, transparent 1px),
    linear-gradient(90deg, #D9DCE3 1px, transparent 1px);
  background-size: 8px 8px;

  border: 1px solid var(--otto-border-control);
  border-radius: var(--otto-radius-sm);
}

.empty-state__title {
  margin: 0 0 4px;
  color: var(--otto-text);
  font-size: 16px;
  font-weight: 700;
  line-height: 24px;
}

.empty-state__description {
  margin: 0;
  color: var(--otto-text-secondary);
  font-size: 14px;
  line-height: 20px;
}

/* Loading */

.loading-state {
  display: grid;
  place-items: center;
  min-height: 180px;
  color: var(--otto-text-secondary);
  text-align: center;
}

.spinner {
  width: 20px;
  height: 20px;
  margin-block-end: 10px;

  border: 2px solid var(--otto-border);
  border-top-color: var(--otto-accent);
  border-radius: 50%;

  animation: otto-spin 800ms linear infinite;
}

.skeleton {
  overflow: hidden;
  background:
    linear-gradient(
      90deg,
      #ECEFF3 0%,
      #F7F8FA 45%,
      #ECEFF3 90%
    );
  background-size: 200% 100%;
  border-radius: 4px;
  animation: otto-skeleton 1.4s ease-in-out infinite;
}

@keyframes otto-spin {
  to { transform: rotate(360deg); }
}

@keyframes otto-skeleton {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .spinner,
  .skeleton {
    animation: none;
  }
}

/* Responsive iframe layout */

@media (max-width: 720px) {
  .app-shell {
    padding: 16px;
  }

  .app-header {
    display: grid;
    gap: 12px;
  }

  .filter-bar {
    align-items: stretch;
  }

  .field,
  .field--grow {
    width: 100%;
    min-width: 100%;
  }

  .app-actions {
    width: 100%;
  }
}
```

Use these exact generic state strings in built apps:

```html
<section class="empty-state">
  <div class="empty-state__content">
    <div class="empty-state__mark" aria-hidden="true"></div>
    <h2 class="empty-state__title">אין נתונים להצגה</h2>
    <p class="empty-state__description">
      שנו את המסננים או את טווח התאריכים.
    </p>
  </div>
</section>
```

```html
<section class="loading-state" role="status" aria-live="polite">
  <div>
    <div class="spinner" aria-hidden="true"></div>
    <div>טוען נתונים…</div>
  </div>
</section>
```

Do not place Otto inside generated-app empty or loading states. The construction-grid mark is the shared product device there; the character belongs to the workflow rail.

## Ranked implementation order

1. **Remove the central square PNG and phase chips.** Install the `280px × 112px` Otto status card in the right rail.
2. **Produce the transparent Otto asset.** Key the white background, restore the white shell edges and export the `216px × 312px` lossless WebP.
3. **Wire the status card to the workflow state machine.** Use the exact phase labels, Hebrew lines, three building stages and eight-second post-build transition.
4. **Inject the finished token set and base stylesheet into every generated iframe.** This is what makes the built output belong to the Intelligence Center without becoming violet-tinted.
5. **Restrict violet usage.** Remove violet page surfaces, generic cards, KPI numbers, table headers, skeletons, glows and decorative gradients.
6. **Add only the activity-dot animation and reduced-motion handling.** Do not animate the robot.
7. **Run RTL and contrast QA** on plan approval, errors, tables with long Hebrew labels, numeric columns, filters, empty states and loading states.
