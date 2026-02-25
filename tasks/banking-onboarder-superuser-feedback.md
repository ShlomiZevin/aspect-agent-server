# Banking Onboarder - Super User Feedback

## Status: In Progress

---

### ~~Task 1: Account Selection - Business account redirect too abrupt~~ ✅
**Crew:** Account Selection
**Type:** Wrong Reply
**Status:** Done
**Changes:** Warm Hebrew redirect with fake phone 03-9999999, offers private account as alternative, gender-neutral language.

---

### Task 2 [#78]: Completion - Text-heavy format, needs celebratory UI
**Crew:** Account Opened (completion)
**Type:** Wrong Reply
**Notes:**
- Text-heavy format - this screen deserves celebratory visual UI (account card with bold number, green status, icons)
- "הצעדים הבאים" too long - 3 steps with long explanations at end of tiring process. Shorten drastically or show as light visual checklist
- "ברוכה הבאה ל-[שם הבנק]" - visible placeholder, needs real bank name
- "איך אפשר לעזור?" - after this process user doesn't know what to ask. Better to offer 2-3 Quick Replies: "הפקד כסף ראשון" / "הזמן כרטיס אשראי" / "סיימתי לבינתיים"
- Missing celebratory moment - single 🎉 not enough. Consider short animation or design that marks completion
- Separate what's already available vs next steps
- Add links everywhere the customer needs/can continue
- Remove "איך אפשר לעזור?" at the end. Create more closure options, customer can always return

---

### Task 3 [#77]: Final Confirmation - Add digital signature simulation
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Notes:**
- Add a simulated digital signature step instead of just typing "I authorize"

---

### Task 4 [#76]: Final Confirmation - Terms confirmation too abrupt
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Notes:**
- Missing short summary of terms in customer-friendly language with mock link to full document
- Missing context - transition from summary to this question is too sharp. Customer who didn't read terms feels like "signing" something they didn't understand. Add a connecting sentence
- "תקנות" - dry terminology. Use simpler language like "תנאי השימוש" or "הפרטים שראית"
- Quick Replies - "מאשר/ת" / "יש לי שאלה" buttons are better than free typing at this critical stage

---

### Task 5 [#75]: Final Confirmation - Missing detail completion step
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Notes:**
- Before final confirmation, missing a step to complete and confirm technical details:
  - Full name
  - Full name in English
  - Address confirmation (based on ID)

---

### Task 6 [#74]: Final Confirmation - Summary presentation improvements
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Notes:**
- Text-heavy format - summary shown as text block with headers. This is the most important step, deserves dedicated UI (structured summary card easy to scan in a second)
- "הפרופיל שלך" - term repeats. Unify customer-facing language throughout the flow
- "האם כל הפרטים נכונים?" - better as Quick Replies: "הכל נכון, נמשיך" / "רוצה לתקן משהו"
- Missing info on what happens after - customer doesn't know next step after confirmation. Before they approve, they should know what to expect (SMS? account opens immediately?). Expectation management is critical here
- Don't show behind-the-scenes items like "אימות זהות: מאושר"
- Expand on account terms, not customer profile

---

### Task 7 [#73]: Account Terms & Offers - Stuck, doesn't auto-transition
**Crew:** Account Terms & Offers
**Type:** Didn't Transition
**Notes:**
- Agent gets stuck and requires explicit request to continue after presenting terms

---

### Task 8 [#72]: Account Terms & Offers - Offer presentation too text-heavy
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Notes:**
- Text-heavy format - offer shown as long text block with bold headers. Feels like a document, not a conversation. Consider dedicated UI for offer display (visual product card)
- "תנאים סטנדרטיים" - dry banking language. Use friendlier wording like "מה חשוב לדעת"
- "האם ההצעה הזו עונה על צרכייך?" - too vague. Better to offer clear Quick Replies: "כן, נמשיך" / "יש לי שאלות" / "רוצה לראות אפשרויות נוספות"
- No explanation of logic - customer doesn't know why they got this specific offer. A short sentence connecting what they shared to the recommendation increases trust and personalization feeling

---

### Task 9 [#71]: Account Terms & Offers - Should present offer immediately
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Notes:**
- Agent should continue and present the offer immediately without waiting for explicit request

---

### Task 10 [#70]: Account Terms & Offers - Should offer immediately, not treat as new customer
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Notes:**
- Agent should present options/offer immediately upon entering this crew
- Needs prompt sharpening or system prompt injection to know it should offer right away

---

### Task 11 [#69]: Financial Profile - Asks too many questions at once
**Crew:** Financial Profile
**Type:** Wrong Reply
**Notes:**
- Agent asks 4 questions simultaneously. Switch to one question per message
- "האם יש לך הלוואות קיימות או התחייבויות כספיות משמעותיות?" - very sensitive question without context/preparation. If needed, add framing explaining why it's relevant
- "מה טווח ההוצאות החודשי המשוער?" - better as Quick Replies with predefined ranges
- "איך את מצפה להשתמש בחשבון?" - too open-ended. Offer common clickable options (salary, savings, daily expenses, etc.) with "אחר" option

---

### Task 12 [#68]: Financial Profile - Income questions too many at once
**Crew:** Financial Profile
**Type:** Wrong Reply
**Notes:**
- Agent asks 3 questions simultaneously (income source, range, additional sources). Switch to one per message
- Income ranges should be Quick Replies - predefined clickable ranges instead of free typing. More comfortable and less intimidating

---

### Task 13 [#67]: Financial Profile - Employment questions problematic
**Crew:** Financial Profile
**Type:** Wrong Reply
**Notes:**
- Agent fires 4 questions at once, creating a form/questionnaire feeling instead of conversation
- Fix in three ways:
  1. One question at a time - start with most basic (employment status), continue to next only after answer
  2. Conditional logic - not all questions relevant to everyone (e.g., "position" only for employed, "temporary" only for freelancers). Branch based on answers
  3. Remove "תוכלי לספר פרטים אלו בבקשה?" - unnecessary, adds bureaucratic feeling

---

### Task 14 [#66]: KYC - "Financial profile" language is intimidating
**Crew:** KYC Verification
**Type:** Wrong Reply
**Notes:**
- "בניית הפרופיל הפיננסי שלך" is intimidating and uninviting. Change in two levels:
  1. Remove "פרופיל פיננסי" - replace with customer language like "כמה שאלות קצרות על העיסוק וההכנסה שלך"
  2. Add short value explanation - customer needs to understand why we're asking. Something like "כדי שאוכל להמליץ לך על האפשרויות שהכי מתאימות לך"
- "נמשיך?" can stay - gives customer sense of control

---

### Task 15 [#65]: KYC - Don't show behind-the-scenes checks
**Crew:** KYC Verification
**Type:** Wrong Reply
**Notes:**
- Should NOT list which checks were performed (sanctions, compliance, risk assessment)
- Just update that everything was verified successfully

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

## Infrastructure Fixes (from consents debugging)
- **Dispatcher**: Form mode doesn't skip extraction when all fields collected; sends all active fields for correction support; filters empty string values
- **FieldsExtractorAgent**: Updated form mode prompt to handle consent re-approval as corrections; added debug logging
- **CrewMember base**: Added `getFieldsForExtraction(collectedFields)` method for sequential field exposure
- **AGENT_BUILDING_GUIDE.md**: Documented `getFieldsForExtraction` and extraction modes

## Cross-cutting fixes
- **Gender-neutral rule**: Added to entry-introduction, account-type, consents, identity-verification crews
- **Context level**: All banking crews use conversation-level context (not user-level)
- **Currency**: Fixed $ → ₪ in final-confirmations and completion crews
