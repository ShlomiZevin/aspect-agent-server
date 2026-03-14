# Rename Claude Code Tab Titles in VS Code

## Problem
Claude Code tabs in VS Code all show unhelpful titles like "The user opened the file..." or truncated first messages, making it hard to identify which conversation is which.

## Findings

### Where tab titles come from
- Stored in `~/.claude/projects/<project-slug>/sessions-index.json`
- Each entry has a `firstPrompt` field that becomes the tab title
- The actual conversation is in the corresponding `.jsonl` file
- The title is derived from the first user text content (stripping `<ide_opened_file>` tags)

### File locations (Windows)
```
C:\Users\<user>\.claude\projects\c--workspace-aspect\sessions-index.json   # Index with all titles
C:\Users\<user>\.claude\projects\c--workspace-aspect\<session-id>.jsonl    # Conversation data
```

### sessions-index.json structure
```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "uuid",
      "fullPath": ".../<session-id>.jsonl",
      "firstPrompt": "the tab title text (may include IDE tags)",
      "messageCount": 14,
      "created": "2026-01-27T...",
      "modified": "2026-01-27T...",
      "gitBranch": "master",
      "projectPath": "c:\\workspace\\aspect"
    }
  ]
}
```

## Proposed approach

### Step 1: Test on one tab
1. Pick a stale/throwaway session
2. Edit only `firstPrompt` in `sessions-index.json` to a descriptive title
3. Restart VS Code
4. Check if the tab title updated

### Step 2: If Step 1 works — batch rename
- Write a script that reads each `.jsonl`, extracts conversation context, and sets a meaningful `firstPrompt`
- Optionally use Claude API to auto-summarize each conversation into a short title

### Step 3: If Step 1 doesn't work
- Also edit the first user message text inside the `.jsonl` file
- Higher risk — could corrupt conversation if done incorrectly
- Always back up the `.jsonl` before editing

## Risks
- **Low**: Editing `firstPrompt` in the index (just metadata)
- **Medium**: Editing `.jsonl` files (could corrupt conversation state)
- **Requires**: VS Code restart to see changes

## Status
Not started — pending manual test of Step 1.
