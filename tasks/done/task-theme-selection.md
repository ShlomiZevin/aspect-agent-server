# Task: Theme Selection in Debug Mode

## Background
LYBI is a white-label AI assistant that can operate under different bank brands. Each bank has its own logo, colors, and name. Currently the theme is hardcoded per agent page. We need a way to switch themes at runtime — primarily through the debug panel, which already exists and supports session-level overrides for model, prompt, persona, KB, etc.

This is a **generic engine feature** with a **domain-specific first implementation** for Banking Onboarder V2.

---

## Generic Feature: Theme Selection

### Concept
Add a "Theme" section to the debug sidebar (alongside existing model/prompt/persona overrides). The user selects a theme → the client updates CSS variables + logo + display name in real time. The theme persists for the session (same as other debug overrides).

### Where Themes Live
Each agent defines its available themes in the agent config (client-side). Themes are **domain-specific** — a banking agent has bank themes, another agent could have completely different themes.

### Agent Config Addition
```ts
// In AgentConfig (types/agent.ts)
interface AgentTheme {
  id: string;           // 'discount', 'leumi', etc.
  name: string;         // Display name: 'בנק דיסקונט'
  logo: string;         // Path to logo image
  colors: {
    primary: string;    // Main brand color
    secondary: string;  // Secondary brand color
  };
}

interface AgentConfig {
  // ... existing fields ...
  themes?: AgentTheme[];     // Available themes for this agent
  defaultTheme?: string;     // Theme ID to use by default
}
```

### How It Works

1. **Agent config** declares `themes` array (optional — agents without themes work as before)
2. **Debug sidebar** shows a "Theme" section when `themes` exists — renders theme options (logo preview + name)
3. **User selects** a theme → client updates:
   - CSS variables (`--primary-color`, `--primary-hover`, etc.) on the root element
   - Logo in header
   - Any display name references
4. **Session-level** — resets on page refresh (same as other debug overrides)
5. **Server doesn't need to know** — theme is purely visual, no server changes for the generic feature

### Client Changes

| File | Change |
|------|--------|
| `types/agent.ts` | Add `AgentTheme` interface, `themes` + `defaultTheme` to `AgentConfig` |
| `context/ChatContext.tsx` | Add `selectedTheme` state + `setTheme()` setter |
| `context/AgentContext.tsx` | Apply theme colors to CSS variables when theme changes |
| Debug sidebar component | Add "Theme" section — list of themes with logo preview, click to select |
| `components/layout/Header/Header.tsx` | Read logo from selected theme instead of static config |

### CSS Variable Mapping
When a theme is selected, override these variables on `<html>`:
```css
--primary-color: [theme.colors.primary]
--primary-hover: [derived from primary — darken 10%]
--primary-light: [derived from primary — lighten 90%]
--secondary-color: [theme.colors.secondary]
```

All existing components already use these variables — no component changes needed.

---

## First Implementation: Banking Onboarder V2

### Available Themes

| ID | Name | Primary | Secondary | Logo |
|----|------|---------|-----------|------|
| `lybi` | LYBI (default) | current LYBI colors | current | current LYBI logo |
| `discount` | בנק דיסקונט | #2EC05D | #21B783 | `discont-bank-logo.png` |
| `leumi` | בנק לאומי | #10069A | #0066FF | `leumi-bank-logo.png` |
| `poalim` | בנק הפועלים | #ED1C24 | #515153 | `poalim-bank-logo.png` |
| `mizrahi` | בנק מזרחי | #F5821F | #4D555A | `tfhaot-bank-logo.png` |
| `international` | הבינלאומי | #00529B | #FDB726 | `international-bank-logo.png` |

### Logo Files
Already created at: `aspect-agent-server/agents/banking-onboarder-v2/images/`
Need to copy to client `public/` folder (or serve from server).

### Agent Config Update
```ts
// banking-onboarder-v2.config.ts (or within the existing page config)
themes: [
  {
    id: 'lybi',
    name: 'LYBI',
    logo: '/img/lybi-logo-transparent.png',
    colors: { primary: '#7C3AED', secondary: '#6D28D9' }  // current LYBI colors
  },
  {
    id: 'discount',
    name: 'בנק דיסקונט',
    logo: '/banking/images/discont-bank-logo.png',
    colors: { primary: '#2EC05D', secondary: '#21B783' }
  },
  {
    id: 'leumi',
    name: 'בנק לאומי',
    logo: '/banking/images/leumi-bank-logo.png',
    colors: { primary: '#10069A', secondary: '#0066FF' }
  },
  {
    id: 'poalim',
    name: 'בנק הפועלים',
    logo: '/banking/images/poalim-bank-logo.png',
    colors: { primary: '#ED1C24', secondary: '#515153' }
  },
  {
    id: 'mizrahi',
    name: 'בנק מזרחי',
    logo: '/banking/images/tfhaot-bank-logo.png',
    colors: { primary: '#F5821F', secondary: '#4D555A' }
  },
  {
    id: 'international',
    name: 'הבינלאומי',
    logo: '/banking/images/international-bank-logo.png',
    colors: { primary: '#00529B', secondary: '#FDB726' }
  }
],
defaultTheme: 'lybi'
```

### What Changes for Banking V2

| File | Change |
|------|--------|
| Banking V2 agent config | Add `themes` array with 6 bank themes |
| `public/banking/images/` | Copy logo files from server |
| Banking V2 page component | No changes — generic engine handles it |

---

## Implementation Order

### Phase 1: Generic Engine
1. Add `AgentTheme` type + `themes`/`defaultTheme` to `AgentConfig`
2. Add theme state to `ChatContext` (or `AgentContext`)
3. Apply CSS variable overrides when theme changes
4. Add "Theme" section to debug sidebar
5. Update Header to read logo from selected theme

### Phase 2: Banking V2
1. Copy logo images to client `public/`
2. Add themes array to banking-onboarder-v2 config
3. Test all 6 themes — colors + logo + overall look

---

## Out of Scope
- Server-side theme awareness (persona mentioning bank name) — future, separate task
- Theme persistence across sessions — future (could use localStorage)
- Theme selection outside debug mode (e.g. URL param, admin panel) — future
- Dark mode variants per bank theme — future

## Acceptance Criteria
- [ ] Debug sidebar shows "Theme" section when agent has themes
- [ ] Clicking a theme updates colors + logo immediately
- [ ] All existing components reflect the new colors (buttons, links, header, etc.)
- [ ] Default theme loads correctly on page load
- [ ] Theme resets on page refresh (session-level)
- [ ] Agents without themes work exactly as before
- [ ] Banking V2: all 6 bank themes render correctly with proper logos and colors
