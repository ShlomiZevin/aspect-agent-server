# Otto stands in the centre

Placement is decided. Your job is to make it good, not to reopen it. The palette is now settled — see docs/design/otto-palette-answer.md, which you wrote. It is
derived from retail operations: off-white label stock `#F6F7F4`, ledger ink `#18201B`, and a
burnt orange accent `#B54708` taken from receiving labels and warehouse marking tape. Use
those tokens by name. Remember your own rule: the accent is for interaction only and must
never encode operational risk, so Otto's status display cannot use orange to mean "attention".


Placement is decided, in the founder's words:

> "Otto is **in the middle, between the writing chat and the building arena**. He is the one
> who constructs. So it shows you general status and process while you talk, plan, approve
> and build."

That is the arrangement. Your job is to make it good, not to reopen it.

**Current layout:** two-column grid. Canvas on the left (`minmax(0,1fr)`, built screen capped
at 1100px), conversation rail on the right (`360px`, RTL Hebrew). Otto currently sits in a
280×112 status card at the top of that rail, which you designed last time and which replaced
the three phase chips. That card can be replaced, moved or kept — your call, but he now lives
in the centre either way.

**The loop he narrates:** talk → plan → approve → build → back to talk, where the next plan is
a change plan stating the delta. Builds take 30–60 seconds.

**Decide and specify:**

- **Geometry.** Is the centre a real third grid column or is he absolutely positioned in the
  gutter? Exact widths for all three zones, his size, his vertical position, and what happens
  below ~1280px and on a phone. The built screen must not lose width to him.
- **The status surface above him.** The founder describes a rectangular speech bubble. Say
  whether a bubble with a tail is right or whether something else reads better at this size,
  then specify it exactly: dimensions, background, border, radius, type sizes, where it
  points, and — importantly — how it changes between states **without the layout jumping** as
  the text length changes.
- **"General status and process."** He wants more than one line: the current state plus some
  sense of what is happening. Decide what that is. A short list of steps with the current one
  marked? A few recent lines that fade? A progress element during the build? Take a position
  on whether a continuously running feed makes this feel alive and credible or busy and
  anxious — in software someone uses for forty minutes under time pressure, those are very
  different outcomes.
- **The exact Hebrew.** Every state: idle with no screen, idle with a screen, gathering
  requirements, request the data cannot answer, ready to plan, plan awaiting approval, each
  of the three build stages, just built, discussing a change, error.
- **Whether he moves.** You banned character animation. He is now the constructor and sits
  between the description and the thing being built. Does that change your answer? If yes,
  the minimum that reads as working rather than performing.

## Constraints, unchanged

Hebrew RTL throughout. Free or already-licensed assets only. No emoji. **The built screen is
the hero** — a character plus a bubble plus a status display sitting right beside it is the
main risk here, and it is on you to keep it from competing. Operational software, used for
forty minutes at a stretch. Check contrast before specifying a pair.

Otto himself: a small 3D render, white matte shell, coloured joints and chest band, a dark
panel where a face would be with one calm horizontal indicator line. No eyes, no mouth.
Transparent PNG with real alpha, so he sits on any surface. His accent colour is currently
violet and can be re-rendered to match whatever palette you choose — say what colour he
should be.

## Output

Section 1: the palette, complete and final. Section 2: the centre arrangement, with exact
geometry, CSS and Hebrew strings. Then what to change first. If I have described something
badly, say so and give the better version.
