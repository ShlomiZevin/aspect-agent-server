# Task: UI Elements for Fields — Implemented

## Background
When the agent asks about a field with known options or requires structured input, the user previously typed free text. Now the agent emits inline markup that the client renders as interactive UI elements. The user can interact with the element or still type freely.

The LLM decides **when** to show elements (prompt-injected rules). The client decides **how** to render them.

This is a **generic engine feature** — any agent can use it by adding `ui` to its field config.

---

## Supported UI Types

| Type | Purpose | Interaction | Example |
|------|---------|-------------|---------|
| `buttons` | Choose from static options | Click sends option as message | Account type selection |
| `id` | ID document upload (mock) | Opens file picker → fake processing → sends mock ID | ID photo upload |
| `input` | Free text entry form | Fill fields → click שליחה → sends labeled values | Personal details collection |

Additional types are whitelisted in the client parser but not yet used: `chips`, `checkbox`, `radio`, `toggle`, `select`.

---

## Markup Format
The LLM includes a markup hint in its response text:
```
[buttons: option1 | option2 | option3]
[id: העלאת תעודת זהות 📷]
[input: שם משפחה בעברית]
[input: כתובת אימייל]
```

This is a plain text convention — no special SSE events, no schema changes. The markup lives in the message content.

---

## Field Config — `ui` property

### Static options (buttons)
```js
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
```

### Label-based (id, input)
```js
{ name: 'id_number', ui: { type: 'id', label: 'העלאת תעודת זהות 📷' } }
{ name: 'last_name_he', ui: { type: 'input', label: 'שם משפחה בעברית' } }
```

### Dynamic options (guidance — not currently in use)
```js
{
  name: 'incomeRange',
  ui: {
    type: 'buttons',
    guidance: 'offer 3 ranges appropriate for the user profile'
  }
}
```

---

## Server Implementation

### `CrewMember.js` — `getUIElementsInstruction()`
Reads `ui` property from `fieldsToCollect`. Supports `options`, `label`, and `guidance` variants. Generates a prompt instruction block like:

```
## UI Elements
When asking about "account_type", append exactly: [buttons: פרטי 🏠 | אחר 🏢]
When asking about "id_number", append exactly: [id: העלאת תעודת זהות 📷]
Only append the markup when you are directly asking about that field. Do not include it in any other message.
```

### `dispatcher.service.js` — Prompt injection
Calls `crew.getUIElementsInstruction()` and appends result to the assembled talker prompt.

### `conversation.service.js` — `stripUIMarkup()`
Strips UI element markup (`[buttons: ...]`, `[id: ...]`, etc.) from assistant message content before sending to the LLM as conversation history. Prevents the model from mimicking the pattern in crews that don't define UI fields. Applied at all 4 history-load sites:
- `llm.google.js`
- `llm.openai.js`
- `llm.claude.js`
- `CrewMember.js` (thinker history)

---

## Client Implementation

### Parsing — `Message.tsx`
- `UI_ELEMENT_TYPES` whitelist: `['buttons', 'chips', 'checkbox', 'radio', 'toggle', 'select', 'id', 'input']`
- `parseUIElements()` matches `[type: content]` only for whitelisted types — markdown links `[text](url)` are never caught
- Returns `{ cleanText, elements: { type, options }[] }`

### Rendering — `Message.tsx`
Elements are split into `inputEls` (type `input`) and `otherEls` (everything else).

**Buttons (`type: buttons`):**
- Rendered as a row of styled buttons below the message
- Click sends the option label as a user message
- Disabled when a subsequent message exists

**ID Upload (`type: id`):**
- Renders a large dashed upload button with camera icon
- Click opens native file picker (`accept="image/*"`)
- On file selected: button shows spinner + "מעבד את תעודת הזהות שלך..." for 2s (mock processing)
- Then auto-sends `"העליתי את תעודת הזהות שלי. מספר זהות: 305123456"` (mock)
- After submission: button shows "✅ תעודת זהות הועלתה" with solid green styling

**Input Form (`type: input`):**
- Multiple input elements grouped into a single form card
- Each input renders as a labeled text field
- Single "שליחה" submit button at the bottom
- Submit composes one user message with `label: value` per line (only filled fields)
- Enter key also submits; partial submit allowed
- **Collected state**: when disabled, parses the next user message's `label: value` lines to recover submitted values. Only fields with recovered values are shown. Form switches to green border with "✅ נשלח" badge. Fields without values are hidden entirely.

### Styling — `Message.module.css`
- `.uiElementRow` — flex row for buttons
- `.uiElement` — base button style (pill, theme border, hover fill)
- `.uiDisabled` — dimmed, non-interactive
- `.uiType_id` — larger, dashed border, distinct upload feel
- `.uiType_id_uploaded` — solid green, shows completed state
- `.idProcessing` / `.idSpinner` — inline spinner animation
- `.uiInputForm` — card container for input fields
- `.uiInputField` / `.uiInputLabel` / `.uiInputBox` — form field styling
- `.uiInputSubmit` — submit button (theme color, right-aligned)
- `.uiInputFormCollected` / `.uiInputBoxCollected` / `.uiInputCollectedBadge` — green collected state

---

## Current Usage — Banking Onboarder V2

### Welcome crew (`welcome.heb.crew.js`)
- `account_type` — `ui: { type: 'buttons', options: [פרטי 🏠, אחר 🏢] }`
- `id_number` — `ui: { type: 'id', label: 'העלאת תעודת זהות 📷' }`

### Review-Finalize crew (`review-finalize.crew.js`)
- `last_name_he` — `ui: { type: 'input', label: 'שם משפחה בעברית' }`
- `first_name_en` — `ui: { type: 'input', label: 'שם פרטי באנגלית' }`
- `last_name_en` — `ui: { type: 'input', label: 'שם משפחה באנגלית' }`
- `home_address` — `ui: { type: 'input', label: 'כתובת מגורים מלאה' }`
- `email` — `ui: { type: 'input', label: 'כתובת אימייל' }`
- `phone` — `ui: { type: 'input', label: 'מספר טלפון' }`

---

## What Does NOT Change
- Field extractor — sees normal text messages, no awareness of UI elements
- SSE events — no new event types
- DB schema — raw markup stored in message content as-is
- Transition logic — unchanged
- Thinker — unchanged (UI elements are talker-only)

---

## Files Touched

| File | Change |
|------|--------|
| `crew/base/CrewMember.js` | `getUIElementsInstruction()` — supports `options`, `label`, `guidance` |
| `crew/services/dispatcher.service.js` | Appends UI instruction to talker prompt |
| `services/conversation.service.js` | `stripUIMarkup()` — strips UI markup from history sent to LLM |
| `services/llm.google.js` | Applies `stripUIMarkup` to assistant history messages |
| `services/llm.openai.js` | Applies `stripUIMarkup` to assistant history messages |
| `services/llm.claude.js` | Applies `stripUIMarkup` to assistant history messages |
| `client/Message/Message.tsx` | Parser (whitelist-based), render (buttons/id/input), collected state |
| `client/Message/Message.module.css` | All UI element styles (buttons, id upload, input form, collected states) |
| `welcome.heb.crew.js` | `ui` on `account_type` (buttons) and `id_number` (id) |
| `review-finalize.crew.js` | `ui` on 6 input fields (names, address, email, phone) |
