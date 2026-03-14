# Task: Remove DB Persistence from Playground Conversations

## Status: Pending

## Summary
The playground (both crew editor chat and test chat) currently stores all messages in the database via the regular stream endpoint. These are ephemeral work sessions and don't need DB persistence — it's a waste of space.

## What to Change
- Playground test chat and crew editor chat should manage history **client-side only**
- Send conversation history inline with each request (`inlineHistory` approach) instead of relying on DB-stored history
- Add `inlineHistory` support to LLM providers (`llm.openai.js`, `llm.claude.js`, `llm.google.js`) — when `config.inlineHistory` is provided, skip the DB history fetch and use the client-provided array
- Skip creating `conversations` and `messages` DB rows for playground/editor sessions
- Consider a flag (e.g., `ephemeral: true`) on the stream request to signal no-persist mode

## Affected Files
- `aspect-agent-server/services/llm.openai.js` — add `inlineHistory` support
- `aspect-agent-server/services/llm.claude.js` — add `inlineHistory` support
- `aspect-agent-server/services/llm.google.js` — add `inlineHistory` support
- `aspect-agent-server/server.js` — skip DB writes when ephemeral
- `aspect-react-client/src/components/dashboard/CrewPlayground/CrewPlayground.tsx` — send history inline
- `aspect-react-client/src/components/dashboard/CrewEditorAI/` — send history inline
