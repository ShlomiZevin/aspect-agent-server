# Otto — presence and colour. Second consult.

You gave the identity direction for this tool last time and most of it shipped: the palette,
Noto Sans Hebrew, the outlined plan card, the named build stages, the construction-grid empty
state. It works. Two things are now open, and one of them reverses a call you made.

## 1. The character is back, and it is your problem now

You said no character: a robot turns an approval-based operational tool into a consumer AI
product and gets irritating by the tenth session. The founder overrode that, for a reason
worth hearing:

> "I want to present customers with Otto — his AI dev / BI / IT / tech employee. **The robot
> is the tech person you used to have to have, and now this is him.**"

So the character exists. Your job is no longer whether, but **how**, and your original
objection is still the thing to design against — it must not wear out.

**What exists:** a 3D render of a friendly service robot. White matte shell, violet joints
and chest band, a dark panel where a face would be crossed by one calm violet light bar, a
blank clipboard, a stable base instead of feet. No eyes, no mouth, no glow. It reads as a
competent colleague rather than a toy.

**What is wrong right now:** it is a square white-background PNG dropped into the middle of
the empty state at 132px. The founder's words:

> "now it's just you stamp a picture on it, no nice merging, nothing, it looks stupid."

He is right. It is a photograph sitting on a grid, not part of the interface.

**His own idea, which I think is good:**

> "maybe even put Otto to the side where it has a talking box or something where it tells you
> where we are at — brainstorming, planning, need to approve, then review and comment. When
> building it tells you the status. **He is like the manager actually** — and as a manager he
> looks good."

That turns the character from decoration into a status surface: he says where you are in the
loop instead of a chip strip saying it silently.

**The loop he would be narrating** (this is the whole product):

1. **שיחה** — free conversation. Otto asks what the screen needs and refuses things the data
   cannot answer.
2. **תוכנית** — the conversation becomes an action plan the user must approve. The gate.
3. **בנייה** — one long call (30–60s) that writes the screen.
4. Back to conversation. The next plan is a **change plan** stating the delta.

**Answer these:**

- **Where does Otto live, at what size, and is he persistent or conditional?** Right now he
  appears only in the empty state and disappears once a screen exists. If he becomes a status
  presence he has to be there during work — which is exactly the wear-out risk you named.
  Resolve that tension explicitly.
- **Does the speech box replace the three phase chips, or sit alongside them?** Having both
  is redundant. Take a position.
- **What does he say in each state?** Write the Hebrew, all of it — idle, gathering
  requirements, ready to plan, plan awaiting approval, building (three stages), just built,
  discussing a change, error. Short lines a person reads in half a second, not chat.
- **How does he stop being a pasted photo?** The render is on pure white. Options I can
  execute: key the background to transparency, `mix-blend-mode: multiply` over a light
  surface, crop him into a container with a deliberate edge, or a flat panel he sits in.
  Pick one and specify it — container, size, padding, background, border, radius, shadow,
  exact placement — and say what stops it looking pasted.
- **Does he animate?** You banned character animation last time. Does the status role change
  that, and if so what is the minimum that reads as alive without becoming a mascot?

## 2. Colour — the founder is not sure about the violet

> "I remind you about colour schema — not sure about the purple."

The violet `#6D28D9` is inherited from the Intelligence Center, which this tool lives inside
and where its output is later opened. You kept it last time and said it connects the two and
is distinctive enough.

He is questioning it now, so make the case again or change your mind — but the constraint has
not moved: **a screen built here is opened inside the Intelligence Center**, so Otto cannot
simply pick a different brand colour without the built screens looking foreign there.

Two things to resolve:

- **Keep or change.** If keep, say what to do so it stops reading as "AI purple" — the exact
  thing that makes a product look like every other AI tool. If change, give the full palette
  with hex and roles, and say how it stays coherent with the Intelligence Center.
- **The generated apps must share the look.** Every screen Otto builds is HTML rendered in an
  iframe with CSS variables injected by the host. Today those are the same violet tokens plus
  base styling for tables, headings and controls. Give me the finished token set and base
  stylesheet for a **built app** — it has to look like it belongs in the same product without
  being a purple-tinted BI report. Tables, numbers, status badges, filters, buttons, empty
  and loading states.

## Constraints, unchanged

Hebrew RTL throughout. Free or already-licensed assets only. No emoji. The built screen is
the hero — nothing may compete with it. Operational software used for forty minutes at a time
under time pressure. Check contrast before you specify a pair.

## Output

For each of the two sections: the decision, then the exact values — hex, px, the Hebrew
strings, the CSS. Then a ranked list of what to change first. If something I have described
is a bad idea, say so plainly and give the better version.
