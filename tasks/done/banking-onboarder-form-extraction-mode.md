# Task: Add Form Extraction Mode to Banking Onboarder Crews

## Status: Pending

## Summary
Several crew members in the banking-onboarder agent would benefit from `extractionMode: 'form'` to enable field corrections during the conversation.

## Background
The `extractionMode: 'form'` setting enables:
- Users to correct previously entered values (e.g., fix typos in name)
- Field re-extraction when user provides updated information
- The `corrections` mechanism in FieldsExtractorAgent

Already applied to: `identity-verification.crew.js` (to fix OTP retry issue)

## Recommended Changes

| Crew | Priority | Reason |
|------|----------|--------|
| `entry-introduction.crew.js` | High | User might misspell name or want to correct it |
| `consents.crew.js` | Medium | User might change consent answers |
| `profile-enrichment.crew.js` | High | Multiple fields (employment, income) - users often need to correct |
| `final-confirmations.crew.js` | Medium | Final review step - user should be able to fix any errors |

## Implementation
Add to each crew's constructor config:

```js
super({
  name: '...',
  displayName: '...',
  extractionMode: 'form',  // <-- Add this line
  // ... rest of config
});
```

## Notes
- Crews with `oneShot: true` (like `kyc.crew.js`) don't need form mode since they auto-transition
- `offers-terms.crew.js` is mostly about presenting info, less about collecting - lower priority
