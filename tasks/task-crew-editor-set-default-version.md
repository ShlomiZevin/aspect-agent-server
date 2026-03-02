# Task: Crew Editor — Set Default Version from GCS

## Problem

When using the crew editor, every Apply creates a GCS backup. But there's no way to mark a specific GCS version as the "known good" / "default" version. If something breaks after multiple edits, the user has to guess which backup to restore.

## What "Set as Default" Means

A special GCS marker file that records which version is the stable/approved one. The user can freely edit and apply, but always has a one-click way to get back to the version they explicitly marked as good.

**Auto-load on open:** When the crew editor loads a crew member, it checks if a default version exists. If the current file on disk differs from the default, it auto-loads the default version as proposed source so the user can see and apply it immediately. This ensures the "known good" version is always front and center.

## Implementation

### Server: `crew-editor.service.js`

#### 1. New method: `setDefaultVersion(agentName, crewName, timestamp)`

Writes a small JSON marker file to GCS:

```
crew-versions/{agentName}/{crewName}/_default.json
→ { "timestamp": "2024-01-15T10-30-00-000Z", "setAt": "2024-01-15T12:00:00Z" }
```

#### 2. New method: `getDefaultVersion(agentName, crewName)`

Reads `_default.json`. Returns `{ timestamp, setAt }` or `null` if not set.

#### 3. Modify `listVersions()` response

Include a `isDefault: boolean` flag on each version by checking against `_default.json`.

#### 4. New method: `restoreDefault(agentName, crewName)`

Reads the default timestamp from `_default.json`, then loads that version's source and returns it (for preview in the code panel — user still clicks Apply to save).

### Server: `server.js`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/crew/:agentName/:crewName/versions/default` | GET | Get current default version |
| `/api/admin/crew/:agentName/:crewName/versions/:timestamp/set-default` | POST | Mark a version as default |
| `/api/admin/crew/:agentName/:crewName/versions/restore-default` | POST | Load default version source (preview) |

### Client: `crewEditorService.ts`

- `getDefaultVersion(agentName, crewName, baseURL)` → `{ timestamp, setAt } | null`
- `setDefaultVersion(agentName, crewName, timestamp, baseURL)` → `{ success }`
- `restoreDefault(agentName, crewName, baseURL)` → source string

### Client: `CrewEditorAI.tsx`

#### Versions dropdown changes
- Each version row shows a star icon (filled if default, outline if not)
- Clicking the star sets that version as default
- The default version is visually highlighted (e.g., gold star, subtle background)

#### Action bar changes
- New "Restore Default" button (only visible when a default is set)
- Loads the default version into proposed source (same as current restore flow)
- User clicks Apply to save

#### Auto-load on crew selection
When a crew member is selected (or on initial load):
1. Load the current source from disk (existing flow)
2. Check if a default version exists (`getDefaultVersion`)
3. If yes, fetch the default version source (`getVersionSource`)
4. Compare with current disk source — if they differ, auto-set it as `proposedSource` and switch to the "Proposed" tab
5. Show a status message: "Default version loaded — click Apply to restore"
6. If they match (disk already equals default), do nothing — everything is in sync

### Types: `crew.ts`

```typescript
export interface CrewVersionInfo {
  timestamp: string;
  name: string;
  size: number;
  created: string | null;
  isDefault?: boolean;  // NEW
}
```

## Files to Modify

| File | Change |
|------|--------|
| `aspect-agent-server/services/crew-editor.service.js` | Add default version methods, modify listVersions |
| `aspect-agent-server/server.js` | Add 3 endpoints |
| `aspect-react-client/src/services/crewEditorService.ts` | Add default version client functions |
| `aspect-react-client/src/components/dashboard/CrewEditorAI/CrewEditorAI.tsx` | Star icon in versions, Restore Default button |
| `aspect-react-client/src/components/dashboard/CrewEditorAI/CrewEditorAI.module.css` | Default star styling |
| `aspect-react-client/src/types/crew.ts` | Add isDefault to CrewVersionInfo |
