# Errors tab — design study and what was built (2026-10-22)

**Asked:** make Admin → Errors as convenient as possible to read and act on;
consult Leonardo, only GPT Image 2.5 **flare** and **sunburst**, Lybi's key
(`lybi-website/tools/leo.mjs`).

**Brief:** `brief-01-full-screen.txt`, with the previous screen as a LOW-strength
style reference. Two mockups, $0.12 each:

| File | Model |
|---|---|
| `v1-flare.jpg` | openai/gpt-image-2.5-flare |
| `v1-sunburst.jpg` | openai/gpt-image-2.5-sunburst |

Both arrived at the same structure. Built from them (sunburst's compact
cards + header, flare's red customer edge), then adjusted on real data:

1. **Strip on top** — groups per status as one-click filters (Needs attention
   = new + back), customer conversations hit in 24 h, errors per day (14 d).
2. **List** — one search box + one Filters window (who / where / kind /
   order) instead of four dropdowns. Cards: title (2 lines), where-chip
   (area + add-on / model / trigger), the most important "who" + "+n";
   ×count, time, status in a fixed right column. Red edge = hit customers
   and not handled. Most urgent first.
3. **Opened problem** — status as one-click buttons in a fixed place (no
   window); Note in a window (saving a note never changes the status — a
   "Back" group stays back); "What happened" in one sentence; Kind / First /
   Last seen tiles; errors per day; occurrences with **Open conversation**
   (opens Admin → Conversations on it); the conversation preview; technical
   details folded at the very bottom.

Checked in Chromium (`built-*.png`): status buttons, header and facts do not
move on any click; filter + strip combine; note keeps status; "Open
conversation" lands on the conversation; no page errors.
