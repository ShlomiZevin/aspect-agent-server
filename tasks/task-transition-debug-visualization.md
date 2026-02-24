# Transition Debug Visualization Plan

## Problem Statement
When crew transitions don't happen, it's hard to debug why. Transitions are code-based (JavaScript if-statements), which provides flexibility but makes it difficult to visualize in the debug panel.

## Current State
- **Two transition types:**
  - `preMessageTransfer(collectedFields)` - Field-based, runs BEFORE LLM response
  - `postMessageTransfer(collectedFields)` - Tool-based, runs AFTER LLM response (context-driven)
  - `oneShot` - Auto-transition after delivery (simple, no conditions)

- **Example conditions in code:**
  ```javascript
  // introduction.crew.js preMessageTransfer
  if (isMale) { this.transitionTo = 'ineligible'; return true; }
  if (age !== null && age < 38) { this.transitionTo = 'ineligible'; return true; }
  if (!hasName || !hasAge || !hasTosAcknowledged) { return false; }
  if (age !== null && age >= 38) { this.transitionTo = 'profiler'; return true; }

  // symptom-assessment.crew.js postMessageTransfer
  if (state?.groupsCompleted?.length >= 3) { return true; }
  ```

---

## Proposed Solution: Transition Rules Metadata + Runtime Evaluation

### Approach Overview
1. Add a `transitionRules` metadata array to each crew member
2. Each rule describes a condition + result (transition/stay/block)
3. Dispatcher evaluates rules at runtime and sends results via SSE
4. DebugPanel displays evaluated rules with pass/fail status

### Why This Approach
- **Preserves code flexibility**: Code still controls actual behavior
- **Self-documenting**: Rules serve as documentation
- **AI-friendly**: Easy to update rules when modifying transition logic
- **Non-breaking**: Existing transitions work unchanged, rules are optional

---

## Implementation Details

### 1. Server: TransitionRule Type Definition

**File:** `aspect-agent-server/crew/base/CrewMember.js`

Add to crew configuration:
```javascript
transitionRules: [
  {
    id: 'ineligible_male',
    type: 'pre',  // 'pre' | 'post' | 'oneShot'
    condition: {
      description: 'User is male',
      fields: ['gender'],
      evaluate: (fields, context) => {
        const gender = fields.gender?.toLowerCase();
        return gender === 'male' || gender === 'man';
      }
    },
    result: { action: 'transition', target: 'ineligible' },
    priority: 1  // Higher priority evaluated first
  },
  {
    id: 'eligible_fields_complete',
    type: 'pre',
    condition: {
      description: 'Name, age, and ToS collected, age >= 38',
      fields: ['name', 'age', 'tos_acknowledged'],
      evaluate: (fields, context) => {
        const hasAll = !!fields.name && !!fields.age && !!fields.tos_acknowledged;
        const age = parseInt(String(fields.age).match(/\d+/)?.[0] || '0', 10);
        return hasAll && age >= 38;
      }
    },
    result: { action: 'transition', target: 'profiler' },
    priority: 10
  }
]
```

### 2. Server: Rule Evaluation in Dispatcher

**File:** `aspect-agent-server/crew/services/dispatcher.service.js`

Add evaluation helper:
```javascript
async _evaluateTransitionRules(crew, type, fields, context) {
  if (!crew.transitionRules) return null;

  const rules = crew.transitionRules
    .filter(r => r.type === type)
    .sort((a, b) => a.priority - b.priority);

  const results = [];
  for (const rule of rules) {
    const passed = await rule.condition.evaluate(fields, context);
    results.push({
      id: rule.id,
      description: rule.condition.description,
      fields: rule.condition.fields,
      passed,
      result: rule.result
    });
  }
  return results;
}
```

### 3. Server: New SSE Event Type

**Event:** `debug_transition_eval`

```javascript
// In dispatcher, after preMessageTransfer/postMessageTransfer
if (params.debug) {
  const hasRules = crew.transitionRules && crew.transitionRules.length > 0;

  let evaluatedRules = null;
  let rawCode = null;

  if (hasRules) {
    // Structured evaluation
    evaluatedRules = {
      pre: await this._evaluateTransitionRules(crew, 'pre', fields, context),
      post: await this._evaluateTransitionRules(crew, 'post', fields, context)
    };
  } else {
    // Fallback: extract raw function code
    rawCode = {
      pre: crew.preMessageTransfer ? crew.preMessageTransfer.toString() : null,
      post: crew.postMessageTransfer ? crew.postMessageTransfer.toString() : null
    };
  }

  yield {
    type: 'debug_transition_eval',
    data: {
      crewName: crew.name,
      transitionTo: crew.transitionTo,
      didTransition: shouldTransfer,
      hasStructuredRules: hasRules,
      evaluatedRules,  // Structured (if defined)
      rawCode,         // Fallback (if no rules)
      collectedFields: fields,
      contextSnapshot: { /* relevant context keys */ }
    }
  };
}
```

### 4. Client: Type Definitions

**File:** `aspect-react-client/src/types/chat.ts`

```typescript
// For structured rules (optional)
export interface TransitionRuleEval {
  id: string;
  description: string;
  fields: string[];
  passed: boolean;
  result: {
    action: 'transition' | 'stay' | 'block';
    target?: string;
  };
}

// For raw code fallback
export interface TransitionRawCode {
  pre: string | null;   // preMessageTransfer function source
  post: string | null;  // postMessageTransfer function source
}

export interface TransitionEvalData {
  crewName: string;
  transitionTo: string | null;
  didTransition: boolean;
  hasStructuredRules: boolean;
  // One of these will be populated:
  evaluatedRules: {
    pre: TransitionRuleEval[];
    post: TransitionRuleEval[];
  } | null;
  rawCode: TransitionRawCode | null;
  // Current state for context
  collectedFields: Record<string, string>;
  contextSnapshot: Record<string, unknown>;
}
```

### 5. Client: SSE Handler in chatService

**File:** `aspect-react-client/src/services/chatService.ts`

```typescript
// Add new callback
onTransitionEval?: (data: TransitionEvalData) => void;

// In SSE parser
if (parsed.type === 'debug_transition_eval' && parsed.data) {
  onTransitionEval?.(parsed.data);
}
```

### 6. Client: DebugPanel Enhancement

**File:** `aspect-react-client/src/components/chat/DebugPanel/DebugPanel.tsx`

Add new section that handles both modes:
```tsx
{transitionEval && (
  <div className={styles.section}>
    <button className={styles.sectionHeader} onClick={() => toggleSection('transition')}>
      <span>
        Transition Logic
        {transitionEval.didTransition
          ? ` ✓ → ${transitionEval.transitionTo}`
          : ' (No transition)'}
      </span>
    </button>
    {expandedSections.has('transition') && (
      <div className={styles.transitionContent}>
        {/* Mode 1: Structured rules */}
        {transitionEval.hasStructuredRules && transitionEval.evaluatedRules && (
          <>
            {transitionEval.evaluatedRules.pre?.length > 0 && (
              <div className={styles.ruleGroup}>
                <div className={styles.ruleType}>preMessageTransfer</div>
                {transitionEval.evaluatedRules.pre.map(rule => (
                  <div key={rule.id} className={`${styles.rule} ${rule.passed ? styles.passed : styles.failed}`}>
                    <span className={styles.ruleStatus}>{rule.passed ? '✓' : '✗'}</span>
                    <span>{rule.description}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Similar for post rules */}
          </>
        )}

        {/* Mode 2: Raw code fallback */}
        {!transitionEval.hasStructuredRules && transitionEval.rawCode && (
          <>
            {transitionEval.rawCode.pre && (
              <div className={styles.codeGroup}>
                <div className={styles.ruleType}>preMessageTransfer</div>
                <pre className={styles.codeBlock}>{transitionEval.rawCode.pre}</pre>
              </div>
            )}
            {transitionEval.rawCode.post && (
              <div className={styles.codeGroup}>
                <div className={styles.ruleType}>postMessageTransfer</div>
                <pre className={styles.codeBlock}>{transitionEval.rawCode.post}</pre>
              </div>
            )}
          </>
        )}

        {/* Current state reference */}
        <div className={styles.stateGroup}>
          <div className={styles.ruleType}>Current State</div>
          <pre className={styles.stateBlock}>
            {JSON.stringify(transitionEval.collectedFields, null, 2)}
          </pre>
        </div>
      </div>
    )}
  </div>
)}
```

---

## Visual Design

### Mode 1: Structured Rules (when `transitionRules` defined)
```
┌─────────────────────────────────────────────────────────────────┐
│ DEBUG  introduction | gpt-5-chat-latest | 1024 tokens       ▼  │
├─────────────────────────────────────────────────────────────────┤
│ ▶ Transition Rules (No transition)                              │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │ preMessageTransfer                                        │ │
│   │ ✗ User is male (gender)                                   │ │
│   │ ✗ Under age 38 (age)                                      │ │
│   │ ✗ Name, age, ToS collected, age >= 38 (name, age, tos)   │ │
│   │   └─ Missing: tos_acknowledged                            │ │
│   └───────────────────────────────────────────────────────────┘ │
│ ▶ Full Instructions (Sent to LLM)                               │
└─────────────────────────────────────────────────────────────────┘
```

### Mode 2: Raw Code Fallback (no `transitionRules`)
```
┌─────────────────────────────────────────────────────────────────┐
│ DEBUG  symptom_assessment | gpt-5-chat-latest | 1536 tokens  ▼ │
├─────────────────────────────────────────────────────────────────┤
│ ▶ Transition Logic (No transition)                              │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │ postMessageTransfer                                       │ │
│   │ ┌─────────────────────────────────────────────────────┐   │ │
│   │ │ async postMessageTransfer(collectedFields) {        │   │ │
│   │ │   const state = await this.getContext(              │   │ │
│   │ │     'symptom_assessment', true);                    │   │ │
│   │ │                                                     │   │ │
│   │ │   if (state?.groupsCompleted?.length >= 3) {       │   │ │
│   │ │     // Save summary...                              │   │ │
│   │ │     return true;                                    │   │ │
│   │ │   }                                                 │   │ │
│   │ │   return false;                                     │   │ │
│   │ │ }                                                   │   │ │
│   │ └─────────────────────────────────────────────────────┘   │ │
│   │ Current state: groupsCompleted = ["emotional"]            │ │
│   └───────────────────────────────────────────────────────────┘ │
│ ▶ Full Instructions (Sent to LLM)                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Scope Decisions

- **UI Mode**: Read-only visualization (no editing from debug panel)
- **Storage**: Code only (no DB, version controlled with crew files)
- **Backward Compatible**: Works with existing crews via code extraction fallback

---

## Hybrid Approach: Structured Rules + Code Fallback

### How It Works

1. **If crew has `transitionRules`** → Evaluate and show structured pass/fail results
2. **If crew has NO `transitionRules`** → Extract and show raw function code

JavaScript allows getting function source via `.toString()`:
```javascript
// Automatically extract from any crew:
const preCode = crew.preMessageTransfer?.toString();
// Returns: "async preMessageTransfer(collectedFields) { ... }"

const postCode = crew.postMessageTransfer?.toString();
// Returns: "async postMessageTransfer(collectedFields) { ... }"
```

### No Migration Required
- Existing crews work immediately (show raw code)
- Add `transitionRules` later for better UX (structured evaluation)
- Gradual opt-in, not forced migration

---

## Migration Path

### Phase 1: Core Infrastructure (Required)
1. Add `transitionRules` type to CrewMember base class
2. Add evaluation helper + code extraction to dispatcher
3. Add `debug_transition_eval` SSE event (with rawCode fallback)
4. Update client types and SSE handler
5. Add Transition section to DebugPanel (supports both modes)

### Phase 2: Polish UI
1. Add CSS styling for pass/fail states (green/red)
2. Add syntax highlighting for raw code view (use `<pre>` with monospace)
3. Show current state variables alongside code (fields, context)

### Phase 3: Optional - Add Structured Rules
*Only if you want better UX for specific crews:*
1. Add `transitionRules` to introduction.crew.js
2. Add `transitionRules` to profiler.crew.js
3. Add `transitionRules` to symptom-assessment.crew.js

**Note**: Phase 3 is completely optional. All existing crews work immediately with raw code display.

---

## Files to Modify

### Server (2 files)
- `aspect-agent-server/crew/base/CrewMember.js` - Add transitionRules type/docs
- `aspect-agent-server/crew/services/dispatcher.service.js` - Add code extraction + SSE event

### Client (6 files)
- `aspect-react-client/src/types/chat.ts` - Add TransitionEvalData type
- `aspect-react-client/src/services/chatService.ts` - Handle new SSE event
- `aspect-react-client/src/context/ChatContext.tsx` - Store transition eval in message
- `aspect-react-client/src/hooks/useChat.ts` - Add onTransitionEval callback
- `aspect-react-client/src/components/chat/DebugPanel/DebugPanel.tsx` - New section (both modes)
- `aspect-react-client/src/components/chat/DebugPanel/DebugPanel.module.css` - Styling

### Documentation (1 file)
- `aspect-agent-server/AGENT_BUILDING_GUIDE.md` - Document transitionRules usage

### Optional (add structured rules later)
- `aspect-agent-server/agents/freeda/crew/introduction.crew.js`
- `aspect-agent-server/agents/freeda/crew/profiler.crew.js`
- etc.

---

## Alternative Approaches Considered

### 1. AST Parsing
Parse JavaScript source code to extract if-conditions automatically.
- **Pros**: No manual annotation needed
- **Cons**: Complex, fragile, hard to show meaningful descriptions

### 2. Declarative DSL
Replace code transitions entirely with JSON rules.
- **Pros**: Fully extractable, UI-editable
- **Cons**: Breaking change, loses flexibility of JavaScript

### 3. Console Log Parsing
Parse server logs for transition decisions.
- **Pros**: No code changes to crews
- **Cons**: Fragile, not real-time, requires log streaming

**Chosen approach (Hybrid Metadata)** provides the best balance of flexibility, maintainability, and debuggability.

---

## Verification

1. Enable debug mode (Ctrl+Shift+D)
2. Chat with Freeda (or another agent with transition rules)
3. Check DebugPanel shows "Transition Logic" section
4. Verify raw code is displayed for crews without transitionRules
5. Verify structured rules show pass/fail for crews with transitionRules
6. Verify current state (collectedFields) is shown alongside
