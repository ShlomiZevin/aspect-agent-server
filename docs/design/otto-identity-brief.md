# Otto — visual identity brief

## What Otto is

Otto is a screen builder inside a product called the Intelligence Center. The Intelligence
Center is connected to a retailer's own data and answers questions about it. Otto is the
part where an employee who is **not a developer** describes a screen they need in plain
Hebrew, and Otto builds it — a real, working operational screen: a table of items below
safety stock, a purchasing recommendation view, a sales comparison by branch.

The interface is a chat column pinned to the right (the UI is Hebrew, RTL) and the screen
being built filling the rest. Three phases with a human gate: **talk → plan → approve →
build**, then back to talking, where the next plan is a change plan.

## Who uses it

Retail chains and distributors in Israel. Small and mid-size businesses — a purchasing
manager, a branch operations manager, a logistics lead. **Not** enterprise IT, not
developers, not analysts. People who currently run their week off spreadsheets and reports
somebody else made for them, and who have never built software before in their lives.

## The founder's own words about the look

> "make it look something relevant to retailers, super techy yet for business SMBs"

> "you have Leonardo even to create a background if needed, maybe **רצפת מפעל** [a factory
> floor] or something — not sure, maybe that's too sleazy, it has to be techy"

> "maybe have a figure for Otto — like a futuristic automated robot in a factory"

Those are instincts, not decisions. He explicitly flagged that the factory-floor background
might be cheap. Treat both ideas as open questions, not requirements.

## Where it is now

Working, and the founder called the current state "super nice" — so this is a raise, not a
rescue. What exists:

- Palette inherited from the Intelligence Center: violet `#6D28D9` accent, `#F8F5FC` ground,
  `#FFFFFF` surfaces, `#EAE3F3` hairlines, ink `#241A38`, muted `#6E6584`.
- Public Sans throughout, 13–15px UI text.
- Chat column 380px, canvas fills the rest, the built screen capped at 1100px so every app
  in the framework is the same width.
- Three phase chips at the top of the chat (שיחה · תוכנית · בנייה).
- A plan card in violet that is the approval gate.
- A build state with a small indeterminate progress bar.

## Hard constraints — a recommendation that breaks one of these is unusable

1. **Hebrew, RTL, throughout.** Every label. Any typeface must have real Hebrew coverage.
2. **It must not fight the Intelligence Center.** A screen built here is opened later inside
   that product. Otto may be a distinct room, but it is in the same building.
3. **Free or already-licensed assets only.** Google Fonts is fine. Commercial faces are not.
4. **No emoji anywhere in the interface.**
5. **The built screen is the hero.** Any identity work must make the canvas more prominent,
   never compete with it. The chat is a tool, not the subject.
6. **This is operational software.** It gets used for forty minutes at a time by someone
   under time pressure. Nothing that is charming on the first open and tiring on the tenth.

## What I need from you

### A. The direction

What does "super techy but for an SMB retailer" actually mean as a design decision? Name the
two failure modes it sits between — the one that reads as enterprise software nobody likes,
and the one that reads as a consumer AI toy — and say concretely how to land between them.

Then give the system: palette (hex, with the job each colour does), typography (real
families, with sizes), spacing, corner radius, borders vs shadows, and any texture or
surface treatment. Keep or replace the violet — take a position and say why.

### B. Does Otto get a figure?

The founder wants a character — "a futuristic automated robot in a factory". Say yes or no
plainly.

If **no**, say what carries Otto's presence instead, specifically: the avatar in the chat
header is a 30px violet square with the letters "OT" right now, and that is placeholder-grade.

If **yes**: what is it, where does it appear, at what sizes, and what does it do in each of
the three phases (idle, thinking, building)? A robot mascot in operational software is a
real risk — if you say yes, say why it survives the tenth use.

### C. Does a background belong?

Address the factory-floor idea directly. If it is cheap, say so. If some environmental
imagery earns its place, say exactly where — the empty state before the first screen is
built is the obvious candidate and the only place with room.

### D. Generation prompts

For anything you approve that needs to be generated as an image, write the finished prompt:
subject, composition, palette by hex, lighting, texture, aspect ratio, and an explicit
negative list. These go into the generator unedited. If you approve nothing, write no
prompts and say so.

### E. The five changes that matter most

Ranked, with the exact values. What would make the biggest difference to how this looks and
feels, in order — so that if only the first two get done, those are the right two.
