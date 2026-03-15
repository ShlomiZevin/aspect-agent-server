# Documentation Index

> All documentation for the Aspect Agent Server, organized by category.

---

## Folder Structure

```
aspect-agent-server/
├── docs/
│   ├── INDEX.md              ← You are here
│   ├── guides/               ← How-to guides for building and understanding the platform
│   ├── features/             ← Documentation of existing features in the system
│   ├── setup/                ← Deployment logs, setup instructions, and infrastructure notes
│   └── reference/            ← Fixes, testing notes, and changelog
├── tasks/
│   ├── pending/              ← Tasks and plans to be implemented
│   └── done/                 ← Completed task specs (kept for reference)
├── agents/
│   └── {name}/AGENT.md       ← Agent-specific documentation (stays with its agent)
└── scripts/, db/, utils/
    └── README.md             ← Stay alongside their code
```

## Category Descriptions

### `docs/guides/`
How-to guides for building and understanding the platform. Covers agent building, crew architecture, playground usage, and data loading.

### `docs/features/`
Documentation of existing features in the system. Each file describes what a feature does, how it works, and how to use it.

### `docs/setup/`
Deployment logs, setup summaries, and infrastructure setup instructions. Includes Cloud SQL quickstart and deployment history.

### `docs/reference/`
One-off references: bug fixes, testing instructions, and the platform changelog.

### `tasks/pending/`
Specs and plans for work that still needs to be done.

### `tasks/done/`
Completed task specs, kept for historical reference.

### `agents/{name}/AGENT.md`
Each agent has its own `AGENT.md` describing its purpose, crew members, tools, and configuration. These stay in the agent folder they belong to. Compass also has knowledge base content files in `agents/compass/kb/`.
