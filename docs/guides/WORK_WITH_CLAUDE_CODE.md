# Working with your AI

Build agents by talking to an AI assistant on your own computer. It reads
the real platform code and the real conversations, writes its changes to a
draft, and you review the draft in the Builder and press save. Nothing
becomes real until you do — so you cannot break anything.

## Setup is in the Builder, not here

Open the Builder and click the **🤖** button in the toolbar. Before you
have set anything up it reads "Connect my AI"; afterwards it carries the
name of the tool you chose, so it will say **🤖 Codex** or **🤖 Claude
Code**. A dot on it means the platform files in your folder are out of
date. The wizard does the setup for you:

- links you to whichever AI tool you use (Claude Code or Codex)
- writes the platform files into a folder you pick
- writes the instructions file under the name your tool reads
  (`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex)
- writes your builder id, so there is nothing to look up or type
- sends it the agent you are editing, so it starts from the real current
  version instead of guessing
- gives you the opening message to paste into the AI session — it tells
  the assistant what it is working on, where everything is, and what it
  must not do. A session that starts by reading the instructions behaves
  nothing like one that starts by guessing.

There is **no Git, no GitHub account and no repository to clone**. The
Builder serves the files directly, which is also why you only ever get the
Builder V2 parts rather than the whole codebase.

When the platform changes, the wizard tells you your copy is out of date
and refreshes it in one click.

## Working day to day

Open your AI tool, point it at that folder, and ask for what you want:

> Pull the freeda agent and show me how the classification crew works.

> Add a Choice field called `track` on the strategy crew.

> The agent ignored my instruction in conversation 412 — find out why.

When it changes something, the Builder notices and asks you whether to
load it. Read what changed, then save it if it is right.

You never have to send anything the other way: your draft saves into that
folder every time you change it, so your assistant is always looking at
your current work.

## Getting good results

- **One thing at a time.** A short request you can check beats a long
  specification pasted in one go.
- **Check in the Builder as you go**, not at the end.
- **Let it ask you questions.** Answering one costs a minute; a wrong
  guess costs the afternoon.
- **Tell it when it is wrong.** It cannot see your screen.
- **If it seems to be guessing**, tell it to go and read the actual code
  or the actual conversation. It has both.

## If something goes wrong

| What happened | What to do |
|---|---|
| The draft looks wrong | Don't save. Tell it what's wrong — it will write a new version and the Builder will ask you again. |
| You saved something bad | Use the Builder's revert — every save is a version. |
| It says it can't do something | That one needs a platform change. Send it to Shlomi. |
| You are never asked to load anything | Your assistant hasn't written the file yet, or it is working in a different folder. |
| The wizard says your files are out of date | Click to refresh — the platform changed. |

## What it cannot do

Save to the Builder, deploy anything, change the platform's code, or touch
a live customer. It reads, and it writes drafts on your machine. Everything
that becomes real goes through you pressing save.

## Note on browsers

The folder features need Chrome or Edge — they are the only browsers that
let a page write into a folder you choose. Everything else in the Builder
works the same in any browser.
