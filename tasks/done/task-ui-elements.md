# Task: UI Elements for Fields (Buttons, Chips)

## Background
When the agent asks about a field with known options (account type, income range), the user currently types free text. We want the agent to emit inline markup that the client renders as interactive UI elements (buttons, chips). The user can click a button (which fills the input and sends) or still type freely.

The LLM decides **when** and **what** options to show. The client decides **how** to render them.

This is a **generic engine feature** — any agent can use it by adding `ui` to its field config.

---

## The Generic Tool

### Markup Format
The LLM includes a markup hint in its response text:
```
[buttons: option1 | option2 | option3]
```

This is a plain text convention — no special SSE events, no schema changes. The markup lives in the message content.

### Field Config — `ui` property
```js
// Static options (hardcoded)
{
  name: 'account_type',
  ui: {
    type: 'buttons',
    options: [
      { value: 'personal', label: 'פרטי 🏠' },
      { value: 'other', label: 'אחר 🏢' }
    ]
  }
}

// Dynamic options (LLM decides)
{
  name: 'incomeRange',
  ui: {
    type: 'buttons',
    guidance: 'offer 3 ranges appropriate for the user profile (e.g. עד 5,000 | 5,000-10,000 | מעל 10,000)'
  }
}
```

### Auto Prompt Injection
The dispatcher reads all fields with `ui` config and appends one instruction block to the talker prompt:

```
## UI Elements
When asking about these topics, include a markup hint at the end of your message.
Format: [buttons: option1 | option2 | option3]
Only include when you are actively asking the user to choose. Do not include in every message.

- account_type: [buttons: פרטי 🏠 | אחר 🏢]
- incomeRange: [buttons: offer 3 ranges appropriate for the user profile]
```

For fields with hardcoded `options` — dispatcher builds the exact markup instruction.
For fields with `guidance` — dispatcher passes the guidance text, LLM picks the options.

### Client Rendering
1. After stream ends, scan message text for `[buttons: ...]` patterns
2. Strip the markup from displayed text
3. Render a button row below the message bubble (styled in agent theme colors)
4. On history reload — re-parse stored markup and render again

### User Interaction
- **Click**: fills the chat input with the button label and auto-submits (identical to typing + pressing send)
- **Type**: user can ignore buttons and type freely — extractor handles both identically
- **After response**: buttons become disabled/dimmed

### What Does NOT Change
- Field extractor — sees normal text messages, no awareness of buttons
- SSE events — no new event types
- DB schema — raw markup stored in message content as-is
- Transition logic — unchanged
- Thinker — unchanged (UI elements are talker-only)

---

## Implementation Order

### Phase 1: Generic Engine (implement first)
Build the infrastructure so any field on any agent can use UI elements.

#### Server — `CrewMember.js`
Add `getUIElementsInstruction()` method:
```js
getUIElementsInstruction() {
  const uiFields = this.fieldsToCollect.filter(f => f.ui);
  if (uiFields.length === 0) return null;

  const lines = uiFields.map(f => {
    if (f.ui.options) {
      const labels = f.ui.options.map(o => o.label).join(' | ');
      return `- ${f.name}: [buttons: ${labels}]`;
    }
    if (f.ui.guidance) {
      return `- ${f.name}: [buttons: ${f.ui.guidance}]`;
    }
    return null;
  }).filter(Boolean);

  return `## UI Elements
When asking about these topics, include a markup hint at the end of your message.
Format: [buttons: option1 | option2 | option3]
Only include when you are actively asking the user to choose. Do not include in every message.

${lines.join('\n')}`;
}
```

#### Server — `dispatcher.service.js`
In the prompt assembly step (where the talker prompt is built), call `crew.getUIElementsInstruction()` and append to the prompt if not null.

#### Client — `Message.tsx`
Add a parsing utility:
```ts
function parseUIElements(text: string): { cleanText: string; buttons: string[][] } {
  const regex = /\[buttons:\s*(.+?)\]/g;
  const buttons: string[][] = [];
  const cleanText = text.replace(regex, (_, opts) => {
    buttons.push(opts.split('|').map((o: string) => o.trim()));
    return '';
  }).trim();
  return { cleanText, buttons };
}
```

Render button rows below message content. Each button:
- Styled with agent theme CSS variables (already available)
- On click: calls `onSendMessage(buttonLabel)` or equivalent (fills input + submits)
- Disabled state: when the next message in history exists (user already responded)

#### Client — `Message.module.css`
```css
.buttonRow {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.uiButton {
  padding: 8px 16px;
  border-radius: 20px;
  border: 1px solid var(--primary-color);
  background: transparent;
  color: var(--primary-color);
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.uiButton:hover {
  background: var(--primary-color);
  color: white;
}

.uiButton.disabled {
  opacity: 0.5;
  cursor: default;
  pointer-events: none;
}
```

### Phase 2: First Implementation — Banking Onboarder V2
Apply the generic tool to the two requested fields.

#### Welcome crew — account_type
```js
{
  name: 'account_type',
  allowedValues: ['personal', 'business', 'joint', 'other'],
  ui: {
    type: 'buttons',
    options: [
      { value: 'personal', label: 'פרטי 🏠' },
      { value: 'other', label: 'אחר 🏢' }
    ]
  }
}
```

#### Advisor crew — incomeRange
```js
{
  name: 'incomeRange',
  ui: {
    type: 'buttons',
    guidance: 'offer 3 NIS income ranges appropriate for the user profile'
  }
}
```

---

## Files Touched

| File | Phase | Change |
|------|-------|--------|
| `crew/base/CrewMember.js` | 1 | Add `getUIElementsInstruction()` method |
| `crew/services/dispatcher.service.js` | 1 | Append UI instruction to talker prompt |
| `client/components/chat/Message/Message.tsx` | 1 | Parse `[buttons:]` markup, render button row, handle click |
| `client/components/chat/Message/Message.module.css` | 1 | Button row styling |
| `client/components/chat/ChatInput/ChatInput.tsx` | 1 | Expose method for programmatic fill + submit |
| `welcome.heb.crew.js` / `welcome.crew.js` | 2 | Add `ui` to `account_type` field |
| `advisor.crew.js` | 2 | Add `ui` to `incomeRange` field |

## Acceptance Criteria
- [ ] `getUIElementsInstruction()` generates correct prompt text from field configs
- [ ] Dispatcher appends UI instruction to talker prompt
- [ ] LLM emits `[buttons: ...]` when asking about a UI-enabled field
- [ ] Client parses markup and renders styled buttons below message
- [ ] Clicking a button fills input and sends the message
- [ ] User can type freely instead — extractor handles both
- [ ] Buttons disabled after user responds
- [ ] Works on history reload (re-parses stored markup)
- [ ] Banking V2: account_type buttons appear in welcome crew
- [ ] Banking V2: income range buttons appear in advisor crew
