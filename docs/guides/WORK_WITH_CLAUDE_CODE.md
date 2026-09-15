# Working with Claude Code

Build agents by talking to Claude Code on your computer. It edits a draft,
you look at it in the Builder, you press save. Nothing becomes real until
you save — so you cannot break anything.

Setup takes about 15 minutes. You only do it once.

---

## Before you start

- [ ] Ask Shlomi to give your GitHub account access to the code.

---

## Step 1 — Install Claude Code

1. Go to **https://claude.ai/download**
2. Download the **desktop app** for your computer
3. Install it and sign in with your Lybi account

> ⚠️ The desktop app, not the website. The website version can't see files
> on your computer, and that's how this works.

---

## Step 2 — Install Git

1. Go to **https://git-scm.com/downloads**
2. Download and install it
3. Click "Next" on every screen — all the defaults are fine

---

## Step 3 — Get the files

Open **Git Bash** (Windows) or **Terminal** (Mac) and paste this in, one
block, then press Enter:

```bash
git clone --filter=blob:none --sparse https://github.com/ShlomiZevin/aspect-agent-client-react.git lybi
cd lybi
git sparse-checkout set aspect-agent-server/builder aspect-agent-server/alfred aspect-agent-server/docs .claude
mkdir drafts .lybi
```

It will ask you to sign in to GitHub. Do that.

You now have a folder called **lybi**.

---

## Step 4 — Your builder id

1. In the Builder, open **Work with Claude Code**
2. Press **Copy** next to your id
3. In the `lybi` folder, create the file `.lybi/config.json` and paste:

```json
{ "ownerUserId": "PASTE_YOUR_ID_HERE" }
```

That's the only setting. There's no password.

---

## Step 5 — Start

Open the Claude Code desktop app, open your **lybi** folder, and type what
you want:

> Pull the freeda agent and show me how the classification crew works.

> Add a Choice field called `track` on the strategy crew.

> The agent ignored my instruction in conversation 412 — find out why.

When it's done, open the draft in the Builder, check it, and save.

---

## Getting good results

- **One thing at a time.** A short request you can check beats a long
  specification pasted in one go.
- **Check in the Builder as you go**, not at the end.
- **Let it ask you questions.** Answering one costs a minute; a wrong
  guess costs the afternoon.
- **Tell it when it's wrong.** It can't see your screen.
- **Ask "why did you do that?"** It should have a real answer.

---

## If something goes wrong

| What happened | What to do |
|---|---|
| The draft looks wrong | Don't save. Tell it what's wrong, reload the draft. |
| You saved something bad | Use the Builder's revert — every save is a version. |
| It says it can't do something | That one needs a code change. Send it to Shlomi. |
| It seems to be guessing | Tell it to go read the actual agent or conversation. |

---

## What it can't do

Save to the Builder, deploy anything, change the platform's code, or touch
a live customer. It reads, and it writes drafts. You're the one who saves.
