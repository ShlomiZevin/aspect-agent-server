# Banking Onboarder - Super User Feedback

## Status: In Progress

---

### ~~Task 1: Account Selection - Business account redirect too abrupt~~ ✅
**Crew:** Account Selection
**Type:** Wrong Reply
**Status:** Done
**Changes:** Warm Hebrew redirect with fake phone 03-9999999, offers private account as alternative, gender-neutral language.

---

### ~~Task 2 [#78]: Completion - Text-heavy format, needs celebratory UI~~ ✅
**Crew:** Account Opened (completion)
**Type:** Wrong Reply
**Status:** Done
**Changes:** Complete rewrite. Short celebratory message, "what's ready now" vs "what's coming" separation, warm closure instead of "how can I help". Removed placeholder bank name. Removed all fields (no collection needed). Celebratory UI / animation is separate UI task.

---

### ~~Task 3 [#77]: Final Confirmation - Add digital signature simulation~~ ✅
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Status:** Done
**Changes:** Guidance describes authorization as a "digital signature moment" — framed as official but not scary. Single `authorized` boolean field replaces multi-step authorization phrases.

---

### ~~Task 4 [#76]: Final Confirmation - Terms confirmation too abrupt~~ ✅
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Status:** Done
**Changes:** Guidance instructs to present friendly summary of account terms before asking for authorization. Focus on what customer is getting, not internal process. Quick Replies is separate UI task.

---

### ~~Task 5 [#75]: Final Confirmation - Missing detail completion step~~ ✅
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Status:** Done
**Changes:** Added 3 new fields: `full_name_hebrew`, `full_name_english`, `address_confirmed`. Sequential collection via `getFieldsForExtraction`. Collected before summary and authorization.

---

### ~~Task 6 [#74]: Final Confirmation - Summary presentation improvements~~ ✅
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Status:** Done
**Changes:** Guidance: focus on account offer not internal items, explain what happens after confirmation, customer-facing language. No behind-the-scenes details. Structured summary card is separate UI task.

---

### ~~Task 7 [#73]: Account Terms & Offers - Stuck, doesn't auto-transition~~ ✅
**Crew:** Account Terms & Offers
**Type:** Didn't Transition
**Status:** Done
**Changes:** Simplified to single `terms_accepted` boolean field. `preMessageTransfer` transitions on acceptance. Removed 6-field negotiation state machine.

---

### ~~Task 8 [#72]: Account Terms & Offers - Offer presentation too text-heavy~~ ✅
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Status:** Done
**Changes:** Guidance rewritten — concise, friendly Hebrew, no dry jargon. Rule: "explain why" connects offer to customer profile. Removed wall-of-text example. Visual card is separate UI task.

---

### ~~Task 9 [#71]: Account Terms & Offers - Should present offer immediately~~ ✅
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Status:** Done
**Changes:** Guidance rule: "present immediately — on your first message, present the offer right away. Do not ask what the customer needs."

---

### ~~Task 10 [#70]: Account Terms & Offers - Should offer immediately, not treat as new customer~~ ✅
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Status:** Done
**Changes:** Same as #71. Guidance explicitly says not to treat as new customer. `buildContext` passes customer profile (employment, income, usage) so agent has context.

---

### ~~Task 11 [#69]: Financial Profile - Asks too many questions at once~~ ✅
**Crew:** Financial Profile
**Type:** Wrong Reply
**Status:** Done
**Changes:** One question at a time via `getFieldsForExtraction`. Simplified from 14 to 6 fields. Guidance rewritten with general flow guidelines, Hebrew, gender-neutral. Predefined ranges in field descriptions. Removed over-detailed fields (industry, employment_stability, income_frequency, etc.).

---

### ~~Task 12 [#68]: Financial Profile - Income questions too many at once~~ ✅
**Crew:** Financial Profile
**Type:** Wrong Reply
**Status:** Done
**Changes:** Sequential field exposure — income source, range, and usage asked one at a time. Predefined ranges in field descriptions for extractor. Added `extractionMode: 'form'`.

---

### ~~Task 13 [#67]: Financial Profile - Employment questions problematic~~ ✅
**Crew:** Financial Profile
**Type:** Wrong Reply
**Status:** Done
**Changes:** One question at a time. Conditional logic via `getFieldsForExtraction` — occupation only asked for employed/self-employed (skipped for students, retirees, unemployed using Set-based lookup). Removed bureaucratic tone. Simple conversational guidance.

---

### ~~Task 14 [#66]: KYC - "Financial profile" language is intimidating~~ ✅
**Crew:** KYC Verification
**Type:** Wrong Reply
**Status:** Done
**Changes:** Replaced "בניית הפרופיל הפיננסי שלך" with "כמה שאלות קצרות על העיסוק וההכנסה שלך, כדי שנוכל להמליץ לך על האפשרויות שהכי מתאימות לך". Kept "נמשיך?" for sense of control.

---

### ~~Task 15 [#65]: KYC - Don't show behind-the-scenes checks~~ ✅
**Crew:** KYC Verification
**Type:** Wrong Reply
**Status:** Done
**Changes:** Removed detailed check list (sanctions, compliance, risk assessment). Replaced with simple "כל הבדיקות הושלמו בהצלחה". Added explicit rule: "Do NOT list which checks were performed."

---

### ~~Task 16 [#64]: Identity Verification - Missing face verification step~~ ✅
**Crew:** Identity Verification
**Type:** Wrong Reply
**Status:** Done
**Changes:** Added `face_verified` field (simulated). Full flow now: Phone → OTP → ID number → ID document → Face verification → Done. Added `getFieldsForExtraction` for sequential field exposure.

---

### ~~Task 17 [#63]: Identity Verification - Should continue, not ask "more questions?"~~ ✅
**Crew:** Identity Verification
**Type:** Wrong Reply
**Status:** Done
**Changes:** Added rule "Always move forward - after each step, immediately proceed to the next. Never ask 'do you have questions?' or 'should we continue?'" in both guidance and buildContext note.

---

### ~~Task 18 [#62]: Identity Verification - Doesn't continue conversation~~ ✅
**Crew:** Identity Verification
**Type:** Didn't Transition
**Status:** Done
**Changes:** Stronger buildContext instructions that explicitly tell the agent what to do next at each step. Combined with "always move forward" rule ensures agent progresses through steps.

---

### ~~Task 19: Identity Verification - OTP should mention code length for demo~~ ✅
**Crew:** Identity Verification
**Type:** Wrong Reply
**Status:** Done
**Changes:** Added "**6 ספרות**" to OTP guidance message and OTP DEMO RULES section with "IMPORTANT: Always mention the code is 6 digits".

---

### Task 20 [#59]: Identity Verification - Can we actually do OTP?
**Crew:** Identity Verification
**Type:** Feature Question
**Status:** Skipped
**Notes:**
- Question about whether actual OTP sending is possible (for future, not demo)

---

### ~~Task 21: Consents - Missing transition message with process overview~~ ✅
**Crew:** Consents
**Type:** Wrong Reply
**Status:** Done
**Changes:** Added Step 0 process overview (5 steps, 5-7 min estimate, freedom to ask questions, option to pause and return).

---

### Task 22 [#57]: Identity Verification - Add file/image upload option
**Crew:** Identity Verification
**Type:** Feature Request
**Status:** Skipped
**Notes:**
- Need ability to actually upload image/file for ID verification

---

### ~~Task 23: Identity Verification - OTP should come before ID document~~ ✅
**Crew:** Identity Verification
**Type:** Wrong Reply
**Status:** Done
**Changes:** Reordered flow from ID→Document→Phone→OTP to Phone→OTP→ID number→ID document→Face verification.

---

### ~~Task 24: Consents - Only 2 required consents, presented separately~~ ✅
**Crew:** Consents
**Type:** Wrong Reply
**Status:** Done
**Changes:** Reduced from 4 to 2 consents (service usage + credit database). Added extractionMode: 'form', getFieldsForExtraction for sequential exposure, Hebrew field descriptions with explicit approved/rejected mapping.

---

### ~~Task 25: Consents - Each consent separately, not all at once~~ ✅
**Crew:** Consents
**Type:** Wrong Reply
**Status:** Done
**Changes:** One-at-a-time flow in guidance + getFieldsForExtraction ensures extractor only sees the active consent field. Rejection → reconsideration flow with form mode corrections.

---

### ~~Task 26: Welcome - Opening message needs to be more inviting and detailed~~ ✅
**Crew:** Welcome (entry-introduction)
**Type:** Wrong Reply
**Status:** Done
**Changes:** Updated opening to be more inviting with Hebrew example. Added gender-neutral rule.

---

### Task 27: Account Selection - Add bank contact info to KB
**Crew:** Account Selection
**Type:** Wrong Reply
**Notes:**
- Add to Knowledge Base: phone numbers, links, and contact methods for each bank
- So agent can provide real contact details instead of placeholders

---

### ~~Task 28: Account Selection - Show options as visual sliders/cards~~ ✅
**Crew:** Account Selection
**Type:** Wrong Reply
**Status:** Done
**Changes:** Options presented as structured cards immediately (text only - UI slider/card is a separate task). Gender-neutral rule added.

---

## Infrastructure Fixes
- **Dispatcher**: Form mode doesn't skip extraction when all fields collected; sends all active fields for correction support; filters empty string values
- **FieldsExtractorAgent**: Updated form mode prompt to handle consent re-approval as corrections; added debug logging; added TYPED FIELDS support (`type: 'boolean'`, `allowedValues: [...]`) with dynamic prompt injection
- **CrewMember base**: Added `getFieldsForExtraction(collectedFields)` method for sequential field exposure
- **AGENT_BUILDING_GUIDE.md**: Documented `getFieldsForExtraction` and extraction modes

## Cross-cutting fixes
- **Gender-neutral rule**: Added to entry-introduction, account-type, consents, identity-verification, kyc crews
- **Context level**: All banking crews use conversation-level context (not user-level)
- **Currency**: Fixed $ → ₪ in final-confirmations and completion crews
- **Typed fields**: Added `type: 'boolean'` and `allowedValues` support to field definitions for consistent extractor output
