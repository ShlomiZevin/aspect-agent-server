# Task: Field Extractor Model Configuration

## Summary
Make the field extractor model configurable per-crew and display the active model in the debug side menu.

## Background
The field extractor (`crew/micro-agents/FieldsExtractorAgent.js`) was switched from `gpt-4o` to `claude-sonnet-4-6` for form mode. This is a global change affecting all agents. Claude handles Hebrew better and extracts indirect answers more reliably (e.g., "אני כן רוצה" → `true`).

## Current State
- Form mode: `claude-sonnet-4-6` (hardcoded)
- Conversational mode: `gpt-4o-mini` (hardcoded)
- Retry logic for empty responses (to be removed per decision)
- Markdown code fence stripping added (Claude wraps JSON in ```json ... ```)

## Changes Needed

### 1. Remove retry logic
The empty response retry in `FieldsExtractorAgent.js` should be removed. The root cause was the model switch — Claude Sonnet shouldn't have the same empty response issue.

### 2. Per-crew model configuration
Add an optional `extractionModel` property to crew config:
```js
super({
  // ...
  extractionModel: 'claude-sonnet-4-6', // optional, overrides default
});
```
If not set, use the current defaults (Claude for form, gpt-4o-mini for conversational).

### 3. Display in debug side menu
Show the active extraction model at the top of the fields panel in debug mode. Something like:
```
Extraction Model: claude-sonnet-4-6
```
This helps when debugging why extraction works differently across agents/crews.

## Files to Modify
- `crew/micro-agents/FieldsExtractorAgent.js` — remove retry, accept model override
- `crew/base/CrewMember.js` — add `extractionModel` property
- `crew/services/dispatcher.service.js` — pass `extractionModel` to extractor
- Client: fields panel component — display model name in debug mode

## Assignee
Claude
