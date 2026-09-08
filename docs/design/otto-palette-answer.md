# otto-palette-brief.md — answer from gpt-5.6

_2026-09-08T06:50:41.092Z · 186s_

---

## Thesis

This palette is derived from the physical language of retail operations: off-white stock labels, dark barcode and ledger ink, and the burnt orange used on receiving labels and warehouse marking tape. It says that Otto works with real goods and checkable records—the orange marks where work happens; it never implies prediction or magic.

## Token set

### Foundation and interaction

| Token | Hex | Use |
|---|---:|---|
| `canvas` | `#F6F7F4` | Application ground |
| `surface` | `#FFFFFF` | Screens, tables, panels and controls |
| `subtle-surface` | `#EEF1ED` | Secondary regions and neutral selected areas |
| `hover` | `#E9EDE9` | Neutral row and control hover |
| `disabled` | `#647066` | Disabled text and icons; use `subtle-surface` behind it |
| `text` | `#18201B` | Primary text |
| `secondary-text` | `#4F5D54` | Supporting text and metadata |
| `placeholder` | `#647066` | Input placeholder text |
| `border` | `#D3DAD3` | Passive separators only |
| `strong-border` | `#A7B2AA` | Section and table boundaries |
| `control-border` | `#7B887F` | Inputs, dropdowns and unchecked controls |
| `accent` | `#B54708` | Primary interaction orange |
| `accent-hover` | `#963A06` | Hovered accent control or link |
| `accent-active` | `#7A2E05` | Pressed accent control |
| `accent-subtle` | `#FFF1E6` | Current selection and accent-tinted control state |
| `accent-border` | `#C56625` | Border on `accent-subtle` |
| `on-accent` | `#FFFFFF` | Text and icons on filled accent controls |

### Status colours

| Status | Text | Background | Border |
|---|---:|---:|---:|
| Success | `#166534` | `#ECFDF3` | `#4E9465` |
| Warning | `#7A4A00` | `#FFF8E1` | `#B77900` |
| Danger | `#A12A2A` | `#FFF1F0` | `#CB5A52` |
| Info | `#1557A0` | `#EDF6FF` | `#4E86C2` |
| Neutral | `#4F5D54` | `#EEF1ED` | `#7B887F` |

Orange does not encode warning. Warning always uses the complete warning triple and an explicit Hebrew status label.

### Chart series

The first series is blue, not the product accent.

| Series | Hex |
|---|---:|
| Series 1 | `#1D4ED8` |
| Series 2 | `#B54708` |
| Series 3 | `#0F766E` |
| Series 4 | `#BE123C` |
| Series 5 | `#4D7C0F` |
| Series 6 | `#475569` |

## Contrast

Ratios use WCAG 2.x relative luminance. These are the approved text/background combinations; do not create additional combinations without testing them.

### Text pairs

| Text | Background | Ratio |
|---|---|---:|
| `text` `#18201B` | `surface` `#FFFFFF` | 16.65:1 |
| `text` `#18201B` | `canvas` `#F6F7F4` | 15.48:1 |
| `text` `#18201B` | `subtle-surface` `#EEF1ED` | 14.62:1 |
| `text` `#18201B` | `hover` `#E9EDE9` | 14.08:1 |
| `text` `#18201B` | `accent-subtle` `#FFF1E6` | 15.05:1 |
| `secondary-text` `#4F5D54` | `surface` `#FFFFFF` | 6.94:1 |
| `secondary-text` `#4F5D54` | `canvas` `#F6F7F4` | 6.45:1 |
| `secondary-text` `#4F5D54` | `subtle-surface` `#EEF1ED` | 6.09:1 |
| `secondary-text` `#4F5D54` | `hover` `#E9EDE9` | 5.87:1 |
| `placeholder` `#647066` | `surface` `#FFFFFF` | 5.18:1 |
| `placeholder` `#647066` | `canvas` `#F6F7F4` | 4.82:1 |
| `disabled` `#647066` | `subtle-surface` `#EEF1ED` | 4.55:1 |
| `accent` `#B54708` | `surface` `#FFFFFF` | 5.43:1 |
| `accent` `#B54708` | `canvas` `#F6F7F4` | 5.05:1 |
| `accent` `#B54708` | `subtle-surface` `#EEF1ED` | 4.77:1 |
| `accent` `#B54708` | `hover` `#E9EDE9` | 4.59:1 |
| `accent` `#B54708` | `accent-subtle` `#FFF1E6` | 4.90:1 |
| `on-accent` `#FFFFFF` | `accent` `#B54708` | 5.43:1 |
| `on-accent` `#FFFFFF` | `accent-hover` `#963A06` | 7.23:1 |
| `on-accent` `#FFFFFF` | `accent-active` `#7A2E05` | 9.46:1 |
| Success text `#166534` | Success background `#ECFDF3` | 6.76:1 |
| Warning text `#7A4A00` | Warning background `#FFF8E1` | 7.04:1 |
| Danger text `#A12A2A` | Danger background `#FFF1F0` | 6.63:1 |
| Info text `#1557A0` | Info background `#EDF6FF` | 6.62:1 |
| Neutral text `#4F5D54` | Neutral background `#EEF1ED` | 6.09:1 |

### Non-text checks

| Pair | Ratio |
|---|---:|
| `control-border` against `surface` | 3.70:1 |
| `control-border` against `canvas` | 3.44:1 |
| `accent-border` against `accent-subtle` | 3.58:1 |
| Success border against success background | 3.46:1 |
| Warning border against warning background | 3.44:1 |
| Danger border against danger background | 3.73:1 |
| Info border against info background | 3.49:1 |
| Neutral border against neutral background | 3.25:1 |

`border` and `strong-border` are passive separators and do not reach 3:1. Never use either as the sole outline of an input, checked control or other meaningful interactive boundary; use `control-border`.

All six chart series exceed 4.6:1 against `canvas` and 4.9:1 against `surface`.

## Intelligence Center migration

The Intelligence Center adopts this palette. Do not maintain a permanent violet Intelligence Center around an orange Otto screen; that would make one product look like an embedded product from another company.

1. Introduce these semantic tokens at the shared product root. Generated screens must store token references such as `accent`, `surface` and `text`, never resolved hex values.
2. Switch Otto and the Intelligence Center’s generated-screen viewer to this palette in the same release. The viewer’s surrounding controls also switch, so violet never frames the built screen.
3. In the following release, replace Intelligence Center mappings for primary actions, links, focus, checked controls and current selection with the new accent tokens.
4. Map legacy `#6D28D9` accent backgrounds to `#B54708`, violet hover to `#963A06`, violet active to `#7A2E05`, and violet subtle fills to `#FFF1E6`.
5. Do not replace violet chart data with orange indiscriminately. Reassign legacy chart series by order to the six chart tokens above.
6. Keep a compatibility alias for one release, then remove the violet tokens and reject hard-coded `#6D28D9` in linting.

The final system has one palette. The generated output remains predominantly neutral, but its real interactions use the same orange accent in Otto and the Intelligence Center.

## What this palette is worse at

- Orange sits closer to warning than violet or blue, so careless use will blur interaction and operational risk. The fix is absolute separation: accent never represents late suppliers, low stock, exceptions or alerts; those use the status triples and explicit Hebrew labels.
- Repeated orange buttons become loud faster than repeated blue buttons. Permit only one filled accent action per action group; render other actions with `surface`, `text` and `control-border`.
- It reads as back-of-house retail and logistics rather than luxury storefront software. Do not correct that with black, gold or gradients; the product is an operational tool, and the physical stockroom reference is intentional.

## Accent-usage rule

### Allowed

- Filled primary actions: `accent` with `on-accent`; hover and active use the corresponding tokens.
- Text links: `accent`, changing to `accent-hover` on hover. Links receive a 1px underline with a 2px offset so colour is not the only identifier.
- Keyboard focus: a 2px `accent` ring outside a 2px `surface` gap.
- Checked checkboxes, selected radio controls and enabled switch tracks.
- The current selection: `accent-subtle` background with `accent` text or icon and `accent-border` where a boundary is required.
- An actively selected chart mark or data point.
- Active progress or workflow steps.

### Banned

- Canvas, page backgrounds, headers, sidebars, cards or large panel fills.
- Decorative gradients, glows, illustrations or ambient colour.
- Body text, metadata, passive icons and generic borders.
- Warning, danger, success, low-stock, late-supplier or exception states.
- KPI numbers merely because they are important.
- Every action in an action group; only the primary action may be filled.
- The first chart series or all chart series by default.
- Colouring the generated screen’s surrounding shell to “brand” Otto. The built screen remains the hero.
