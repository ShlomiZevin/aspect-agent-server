# Task: Persona Editor in Crew Editor Tool

## Problem

Each agent has a **persona file** (`{agentName}-persona.js`) that defines the agent's core identity — voice, personality, communication style, domain philosophy. This persona is shared across ALL crew members.

Currently only editable by developers. The super user (product expert) should be able to edit the persona through the same crew editor UI.

## How Persona Differs from Crew

| | Persona | Crew |
|---|---|---|
| **File** | `agents/{agent}/{agent}-persona.js` | `agents/{agent}/crew/{name}.crew.js` |
| **Structure** | Exports `getPersona()` returning a string | Class extending `CrewMember` |
| **Content** | Character, voice, tone, values, boundaries | Stage guidance, fields, transitions, tools |
| **Scope** | Shared by ALL crew members | Specific to ONE crew member |
| **Change impact** | Changes ALL conversations | Changes one stage only |

### Persona file structure (example: Freeda)

```javascript
const FREEDA_PERSONA = `# Freeda - Character & Voice

## Who You Are
You are Freeda, a British menopause expert...

## Core Personality
- Psychologist's Instinct: ...
- High Emotional Intelligence: ...

## Communication Style
- Keep responses concise: 2-3 sentences...
`;

function getPersona() {
  return FREEDA_PERSONA;
}

module.exports = { getPersona };
```

The editor needs to handle this different structure — it's a template literal string, not a class with getters.

## Implementation

### Server: `crew-editor.service.js`

#### 1. New method: `getPersonaSource(agentName)`

Resolves path: `agents/{agentName}/{agentName}-persona.js`
Falls back to common patterns: `{agentName}-persona.js`, `persona.js`
Returns `{ source, filePath, lastModified }` (same shape as `getCrewSource`)

#### 2. New method: `applyPersonaSource(agentName, newSource)`

Same flow as `applySource`: validate → backup → write → hot-reload.

Hot-reload for persona: clear require cache for the persona file. All crew members that import it will get the updated version on next `require()` since they call `getPersona()` at construction time — so crew members also need to be reloaded.

```javascript
async _hotReloadPersona(agentName, filePath) {
  // Clear persona file cache
  delete require.cache[require.resolve(filePath)];
  // Reload ALL crews for this agent (they import persona)
  await crewService.reloadCrew(agentName);
}
```

#### 3. Modify `chatWithClaude()` — support `fileType` parameter

```javascript
async chatWithClaude(agentName, crewName, messages, currentSource, mode, fileType = 'crew')
```

When `fileType === 'persona'`:
- Use a persona-specific system prompt (simpler — no fields, transitions, or code levels)
- Focus on: identity, voice, tone, communication style, domain philosophy
- Claude should ONLY edit the text inside the template literal, not the JS wrapper

#### 4. Persona-specific system prompt

```
You are editing the PERSONA of an AI agent — its core identity and voice.
The persona defines WHO the agent is: personality, communication style, tone, values.
It is shared across all conversation stages.

===== CURRENT PERSONA =====
{extracted persona text — just the template literal content}

===== RULES =====
- Edit the CHARACTER, VOICE, and STYLE — not technical code
- Keep the same general structure (headings, bullet points)
- Changes here affect EVERY conversation the agent has
- Be conservative: small tweaks to tone/style, not wholesale rewrites
- When outputting the updated file, keep the JS wrapper intact (const, function, module.exports)
```

#### 5. GCS backup path for persona

```
crew-versions/{agentName}/_persona/{timestamp}.persona.js
```

Uses same `MAX_VERSIONS = 5` cleanup.

### Server: `server.js`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/persona/:agentName/source` | GET | Read persona source |
| `/api/admin/persona/:agentName/chat` | POST | Chat with Claude about persona |
| `/api/admin/persona/:agentName/apply` | POST | Validate + backup + write + hot-reload |
| `/api/admin/persona/:agentName/versions` | GET | List persona backups |
| `/api/admin/persona/:agentName/versions/:timestamp` | GET | Read backup source |

### Client: `CrewEditorAI.tsx`

#### Selector changes

Add a toggle or special entry in the crew selector:

```
[Crew Member ▾]         [📝 Persona | 👥 Crew]
[introduction    ]
[profiler         ]     ← only shown when "Crew" is selected
[general          ]
```

Option A: A segmented toggle above the dropdown — "Persona" | "Crew Members"
Option B: Add "Agent Persona" as the first item in the crew dropdown with a visual separator

When "Persona" is selected:
- Code panel shows persona source
- Chat uses persona-specific prompt
- Apply calls persona endpoint
- Crew dropdown is hidden/disabled

#### Service layer

New functions in `crewEditorService.ts`:
- `getPersonaSource(agentName, baseURL)`
- `chatWithClaudePersona(agentName, messages, currentSource, baseURL)`
- `applyPersonaSource(agentName, source, baseURL)`
- `listPersonaVersions(agentName, baseURL)`
- `getPersonaVersionSource(agentName, timestamp, baseURL)`

### Types: `crew.ts`

No new types needed — reuse `CrewSourceResponse`, `CrewChatResponse`, `CrewApplyResponse`.

## Important Notes

- **Not all agents have persona files.** Currently only Freeda has one. The UI should gracefully handle agents without a persona file (hide the toggle or show "No persona file found").
- **Impact is broader than crew edits.** Changing persona affects ALL crew members. The UI should show a warning: "Changes to persona affect all conversation stages."
- **The persona is plain text in a template literal.** Claude should edit the text content, not the JS wrapper (`const`, `function`, `module.exports`). The extract/inject logic should handle this.

## Files to Create/Modify

| File | Change |
|------|--------|
| `aspect-agent-server/services/crew-editor.service.js` | Add persona methods, persona prompt, fileType support |
| `aspect-agent-server/server.js` | Add 5 persona endpoints |
| `aspect-react-client/src/services/crewEditorService.ts` | Add persona client functions |
| `aspect-react-client/src/components/dashboard/CrewEditorAI/CrewEditorAI.tsx` | Persona/Crew toggle, persona mode |
| `aspect-react-client/src/components/dashboard/CrewEditorAI/CrewEditorAI.module.css` | Toggle styling |

## Verification

1. Open crew editor for Freeda → see "Persona | Crew" toggle
2. Click "Persona" → persona source loads in code panel
3. Chat: "Make Freeda more casual" → Claude edits the persona text
4. Apply → persona file updated, all crews hot-reloaded
5. Open a Freeda chat → verify the new tone is active across all stages
6. Open crew editor for an agent without persona → toggle hidden or disabled
