# Task Board - Outstanding Bugs & Features

**Created:** 2025-02-24
**Status:** Open
**Priority:** High

---

## Bug 1: Assignee Colors Too Similar

**Description:**
Two assignees are always getting the same color. The current hash function still produces collisions despite using pure RGB primary colors.

**Current Implementation:**
- 8 pure primary colors (Red, Green, Blue, Yellow, Magenta, Cyan, Orange, Black)
- Hash function: `hash = (hash + charCodeAt(i) * (i * 7 + 13)) % 9999991`
- Still produces collisions for certain name combinations

**Expected Behavior:**
Each assignee should have a distinctly different color that's easily distinguishable from all others.

**Files Affected:**
- `aspect-react-client/src/components/tasks/TaskCard/TaskCard.tsx`
- `aspect-react-client/src/components/tasks/AssigneeManager/AssigneeManager.tsx`

**Suggested Fix:**
- Increase color palette to 12+ colors
- Use a better hash algorithm (MurmurHash, FNV-1a with better seeding)
- Consider manual color assignment via UI
- Store color preference in database per assignee

---

## Bug 2: Ctrl+Shift+L Keyboard Shortcut Not Working

**Description:**
The `Ctrl+Shift+L` keyboard shortcut to toggle drafts view does not work. User has to manually click the "Drafts" button.

**Current Implementation:**
- Event listener attached to window
- Checks for input/textarea focus
- Compares key with both 'L' and 'l'
- Should work but doesn't trigger

**Expected Behavior:**
Pressing `Ctrl+Shift+L` (or `Cmd+Shift+L` on Mac) should toggle the drafts view on/off, similar to how `Ctrl+Shift+Space` opens the task board.

**Files Affected:**
- `aspect-react-client/src/components/tasks/TaskBoardModal/TaskBoardModal.tsx` (lines 119-153)

**Debugging Steps:**
1. Check browser console for any errors when pressing shortcut
2. Verify event is being captured (add console.log)
3. Check if browser is using this combo for something else
4. Test with different key combination (e.g., Ctrl+Shift+D)
5. Verify event.key value on keydown

**Suggested Fix:**
- Add debug logging to verify event capture
- Try alternative key combination if browser conflict
- Use `keyCode` as fallback if `key` property unreliable
- Consider using a keyboard library (e.g., hotkeys-js)

---

## Feature 3: UI for Draft Default Setting

**Description:**
Currently, users must use browser console to set their draft default preference. This is ridiculous UX. Need a proper UI toggle.

**Current Implementation:**
- Draft default stored in localStorage: `aspect_draft_default`
- Only accessible via console: `localStorage.setItem('aspect_draft_default', 'true')`
- No UI indicator of current setting

**Expected Behavior:**
User should be able to toggle their draft preference with a single click from the UI, without opening browser console.

**Suggested Implementation:**

### Option A: Settings Button in Toolbar
Add a settings/gear icon button in the task board toolbar that opens a small settings panel with:
- ☑ "Create drafts by default" checkbox
- Other future preferences can be added here

### Option B: Footer Toggle
Add a toggle in the task board footer:
- "Draft by default: [ON/OFF switch]"
- Visible and easily accessible

### Option C: First-Time Setup
Show a one-time setup modal on first use:
- "How do you want to create tasks?"
- [ ] Regular (visible to everyone)
- [ ] Draft (only you can see until fired)
- Checkbox: "Remember my preference"

**Recommended:** Option A (Settings button) - most scalable for future preferences.

**Files to Create/Modify:**
- Create: `aspect-react-client/src/components/tasks/SettingsPanel/SettingsPanel.tsx`
- Create: `aspect-react-client/src/components/tasks/SettingsPanel/SettingsPanel.module.css`
- Modify: `aspect-react-client/src/components/tasks/TaskBoardModal/TaskBoardModal.tsx`
- Modify: `aspect-react-client/src/utils/userIdentifier.ts` (add UI helper functions)

---

## Priority Order

1. **Bug 2** (Keyboard shortcut) - Quick fix, high user frustration
2. **Feature 3** (Draft UI) - Critical UX issue, shouldn't require console
3. **Bug 1** (Colors) - Annoying but workaround exists (check names)

---

## Notes

- All three issues are blockers for production release
- Bug 1 has been attempted 5+ times with different hash functions - needs fundamental approach change
- Bug 2 might be browser-specific - test on Chrome, Firefox, Safari
- Feature 3 is embarrassing to leave as console-only
