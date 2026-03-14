# Task: Upgrade Crew Members to Structured Transition Rules

## Status: Pending

## Background
The transition debug visualization infrastructure is complete. Currently all existing crews show **raw function code** via `.toString()` in the debug panel. This task upgrades individual crew members to use **structured `transitionRules`**, which enables:

- **Per-message DebugPanel**: Live pass/fail evaluation with green checkmarks / red X marks per rule
- **Prompt Editor modal**: Static rule definitions with descriptions and field dependencies

## What's Already Built

### Server Infrastructure
- `CrewMember.js`: Accepts `transitionRules` array in constructor
- `dispatcher.service.js`: `_evaluateTransitionRules(crew, type, fields)` evaluates each rule's `condition.evaluate(fields, context)` at runtime
- `dispatcher.service.js`: `_buildTransitionDebugData()` sends evaluated results via SSE `debug_prompt` event
- Server endpoint: `GET /api/agents/:agentName/crew-members/:crewName/transition-logic` returns rule definitions

### Client Infrastructure
- **Per-message DebugPanel**: Renders structured rules with pass/fail status (green/red) when `hasStructuredRules: true`
- **Prompt Editor modal**: Shows rule definitions (descriptions, fields, targets) per crew member
- Types: `TransitionRuleEval`, `TransitionRuleDefinition`, `TransitionLogicConfig`

## transitionRules Format

```javascript
transitionRules: [
  {
    id: 'unique_rule_id',
    type: 'pre',  // 'pre' for preMessageTransfer, 'post' for postMessageTransfer
    condition: {
      description: 'Human-readable description of what this rule checks',
      fields: ['field1', 'field2'],  // Fields this rule depends on
      evaluate: (fields, context) => {
        // Return true if condition is met (rule passes)
        return !!fields.field1 && !!fields.field2;
      }
    },
    result: {
      action: 'transition',  // 'transition' | 'stay' | 'block'
      target: 'target_crew_name'  // Only for 'transition' action
    },
    priority: 1  // Lower = evaluated first
  }
]
```

## Crews to Upgrade

### 1. introduction.crew.js (Freeda)
**Current code:**
```javascript
async preMessageTransfer(collectedFields) {
  const gender = (collectedFields.gender || '').toLowerCase();
  const isMale = gender === 'male' || gender === 'man' || gender === 'זכר' || gender === 'גבר';
  if (isMale) { this.transitionTo = 'ineligible'; return true; }

  const ageStr = String(collectedFields.age || '');
  const age = parseInt(ageStr.match(/\d+/)?.[0] || '0', 10);
  if (age !== null && age > 0 && age < 38) { this.transitionTo = 'ineligible'; return true; }

  const hasName = !!collectedFields.name;
  const hasAge = !!collectedFields.age;
  const hasTosAcknowledged = !!collectedFields.tos_acknowledged;
  if (!hasName || !hasAge || !hasTosAcknowledged) { return false; }
  if (age !== null && age >= 38) { this.transitionTo = 'profiler'; return true; }
  return false;
}
```

**Proposed rules:**
```javascript
transitionRules: [
  {
    id: 'ineligible_male',
    type: 'pre',
    condition: {
      description: 'User is male',
      fields: ['gender'],
      evaluate: (fields) => {
        const gender = (fields.gender || '').toLowerCase();
        return gender === 'male' || gender === 'man' || gender === 'זכר' || gender === 'גבר';
      }
    },
    result: { action: 'transition', target: 'ineligible' },
    priority: 1
  },
  {
    id: 'ineligible_underage',
    type: 'pre',
    condition: {
      description: 'User is under 38',
      fields: ['age'],
      evaluate: (fields) => {
        const age = parseInt(String(fields.age || '').match(/\d+/)?.[0] || '0', 10);
        return age > 0 && age < 38;
      }
    },
    result: { action: 'transition', target: 'ineligible' },
    priority: 2
  },
  {
    id: 'eligible_complete',
    type: 'pre',
    condition: {
      description: 'All required fields collected and age >= 38',
      fields: ['name', 'age', 'tos_acknowledged'],
      evaluate: (fields) => {
        const hasAll = !!fields.name && !!fields.age && !!fields.tos_acknowledged;
        const age = parseInt(String(fields.age || '').match(/\d+/)?.[0] || '0', 10);
        return hasAll && age >= 38;
      }
    },
    result: { action: 'transition', target: 'profiler' },
    priority: 10
  }
]
```

### 2. profiler.crew.js (Freeda)
**Current code:** Uses `postMessageTransfer` checking context for journey profile completion.

### 3. symptom-assessment.crew.js (Freeda)
**Current code:** Uses `postMessageTransfer` checking `groupsCompleted.length >= 3` from context.

## Important Notes

- **Rules are IN ADDITION to the actual code** - the code still controls real behavior
- Rules are evaluated in `priority` order (lower first)
- Rules should mirror the code logic exactly (they're documentation + debug visualization)
- If rules get out of sync with code, the per-message debug panel will show incorrect pass/fail
- The `evaluate` function receives `(fields, context)` - fields are collected fields, context is empty `{}` for now
- Crews without `transitionRules` continue to show raw function code (no migration required)

## Acceptance Criteria

- [ ] introduction.crew.js has transitionRules matching its preMessageTransfer logic
- [ ] Debug panel shows pass/fail checkmarks per rule when chatting with introduction crew
- [ ] Prompt Editor modal shows rule definitions for introduction crew
- [ ] profiler.crew.js has transitionRules (if applicable)
- [ ] symptom-assessment.crew.js has transitionRules (if applicable)
- [ ] Update AGENT_BUILDING_GUIDE.md examples if needed
