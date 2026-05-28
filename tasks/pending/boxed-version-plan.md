# Modular Agent Platform — Work Plan

## Goals

Turn the backend into a modular platform where each agent is a self-contained module. A single config flag (`ENABLED_AGENTS`) controls which agents the server activates. The same codebase can serve one client, several clients, or all of them — without code changes.

## Work Plan

1. **Audit.** Inventory every shared file that still mentions specific clients.
2. **SQL & data layer cleanup.** Move client-specific SQL rules and data logic into each agent's folder. Shared services become name-agnostic.
3. **Modular bootstrap.** Server discovers agents from the folder layout and activates only those listed in `ENABLED_AGENTS`. CORS, defaults, and fallbacks move to config.
4. **Email, notifications, defaults.** All client-specific addresses and domains move out of source into config.
5. **Schema & migrations.** Each agent owns its tables and migrations. The platform schema contains only platform concerns (users, conversations, billing).
6. **Internal tools flag.** Developer tooling (task board, query optimizer, super-admin, crew editor) hidden behind a single flag, off by default in client builds.
7. **Final cleanup.** Per-client scripts, docs, and fixtures move into their agent folder. Stray cross-references resolved.

## Result

- Each agent is a self-contained module — its crew, data, prompts, schema, and KB live in its own folder.
- Activation is driven by config (`ENABLED_AGENTS=zer4u,hypertoy`), not by code.
- A client receives only their agent's code. No mentions of other clients in source, logs, env, or database.
- The same codebase supports hosted (all agents), on-prem single-tenant (one agent), and custom packages (selected agents).
