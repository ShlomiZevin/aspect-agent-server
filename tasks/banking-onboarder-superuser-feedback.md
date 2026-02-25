# Banking Onboarder - Super User Feedback

## Status: Pending

---

### Task 1: Account Selection - Business account redirect too abrupt
**Crew:** Account Selection
**Type:** Wrong Reply
**Notes:**
- Placeholder visible: `[מספר טלפון]` appears as raw text, needs real data
- Redirect is too abrupt/cold - should feel like "we're still taking care of you", not "not my job, go elsewhere"
- No option to continue with a private account - if customer wants both, they're stuck
- "יש עוד משהו שאני יכול לעזור לך בו?" is too generic when the agent already limited what it can do

---

### Task 2: Completion - Text-heavy format, needs celebratory UI
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

### Task 3: Final Confirmation - Add digital signature simulation
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Notes:**
- Add a simulated digital signature step instead of just typing "I authorize"

---

### Task 4: Final Confirmation - Terms confirmation too abrupt
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Notes:**
- Missing short summary of terms in customer-friendly language with mock link to full document
- Missing context - transition from summary to this question is too sharp. Customer who didn't read terms feels like "signing" something they didn't understand. Add a connecting sentence
- "תקנות" - dry terminology. Use simpler language like "תנאי השימוש" or "הפרטים שראית"
- Quick Replies - "מאשר/ת" / "יש לי שאלה" buttons are better than free typing at this critical stage

---

### Task 5: Final Confirmation - Missing detail completion step
**Crew:** Final Confirmation
**Type:** Wrong Reply
**Notes:**
- Before final confirmation, missing a step to complete and confirm technical details:
  - Full name
  - Full name in English
  - Address confirmation (based on ID)

---

### Task 6: Final Confirmation - Summary presentation improvements
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

### Task 7: Account Terms & Offers - Stuck, doesn't auto-transition
**Crew:** Account Terms & Offers
**Type:** Didn't Transition
**Notes:**
- Agent gets stuck and requires explicit request to continue after presenting terms

---

### Task 8: Account Terms & Offers - Offer presentation too text-heavy
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Notes:**
- Text-heavy format - offer shown as long text block with bold headers. Feels like a document, not a conversation. Consider dedicated UI for offer display (visual product card)
- "תנאים סטנדרטיים" - dry banking language. Use friendlier wording like "מה חשוב לדעת"
- "האם ההצעה הזו עונה על צרכייך?" - too vague. Better to offer clear Quick Replies: "כן, נמשיך" / "יש לי שאלות" / "רוצה לראות אפשרויות נוספות"
- No explanation of logic - customer doesn't know why they got this specific offer. A short sentence connecting what they shared to the recommendation increases trust and personalization feeling

---

### Task 9: Account Terms & Offers - Should present offer immediately
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Notes:**
- Agent should continue and present the offer immediately without waiting for explicit request

---

### Task 10: Account Terms & Offers - Should offer immediately, not treat as new customer
**Crew:** Account Terms & Offers
**Type:** Wrong Reply
**Notes:**
- Agent should present options/offer immediately upon entering this crew
- Needs prompt sharpening or system prompt injection to know it should offer right away

---

### Task 11: Financial Profile - Asks too many questions at once
**Crew:** Financial Profile
**Type:** Wrong Reply
**Notes:**
- Agent asks 4 questions simultaneously. Switch to one question per message
- "האם יש לך הלוואות קיימות או התחייבויות כספיות משמעותיות?" - very sensitive question without context/preparation. If needed, add framing explaining why it's relevant
- "מה טווח ההוצאות החודשי המשוער?" - better as Quick Replies with predefined ranges
- "איך את מצפה להשתמש בחשבון?" - too open-ended. Offer common clickable options (salary, savings, daily expenses, etc.) with "אחר" option

---

### Task 12: Financial Profile - Income questions too many at once
**Crew:** Financial Profile
**Type:** Wrong Reply
**Notes:**
- Agent asks 3 questions simultaneously (income source, range, additional sources). Switch to one per message
- Income ranges should be Quick Replies - predefined clickable ranges instead of free typing. More comfortable and less intimidating

---

### Task 13: Financial Profile - Employment questions problematic
**Crew:** Financial Profile
**Type:** Wrong Reply
**Notes:**
- Agent fires 4 questions at once, creating a form/questionnaire feeling instead of conversation
- Fix in three ways:
  1. One question at a time - start with most basic (employment status), continue to next only after answer
  2. Conditional logic - not all questions relevant to everyone (e.g., "position" only for employed, "temporary" only for freelancers). Branch based on answers
  3. Remove "תוכלי לספק פרטים אלו בבקשה?" - unnecessary, adds bureaucratic feeling

---

### Task 14: KYC - "Financial profile" language is intimidating
**Crew:** KYC Verification
**Type:** Wrong Reply
**Notes:**
- "בניית הפרופיל הפיננסי שלך" is intimidating and uninviting. Change in two levels:
  1. Remove "פרופיל פיננסי" - replace with customer language like "כמה שאלות קצרות על העיסוק וההכנסה שלך"
  2. Add short value explanation - customer needs to understand why we're asking. Something like "כדי שאוכל להמליץ לך על האפשרויות שהכי מתאימות לך"
- "נמשיך?" can stay - gives customer sense of control

---

### Task 15: KYC - Don't show behind-the-scenes checks
**Crew:** KYC Verification
**Type:** Wrong Reply
**Notes:**
- Should NOT list which checks were performed (sanctions, compliance, risk assessment)
- Just update that everything was verified successfully

---

### Task 16: Identity Verification - Missing face verification step
**Crew:** Identity Verification
**Type:** Wrong Reply
**Notes:**
- Identity verification is not complete - needs to also do face verification (simulate for current demo stage)

---

### Task 17: Identity Verification - Should continue, not ask "more questions?"
**Crew:** Identity Verification
**Type:** Wrong Reply
**Notes:**
- "אם יש לך שאלות נוספות" is wrong - agent should continue to next step, not offer open-ended help

---

### Task 18: Identity Verification - Doesn't continue conversation
**Crew:** Identity Verification
**Type:** Didn't Transition
**Notes:**
- Agent says "we can continue to the next step" but doesn't actually transition/continue

---

### Task 19: Identity Verification - OTP should mention code length for demo
**Crew:** Identity Verification
**Type:** Wrong Reply
**Notes:**
- For demo purposes, should mention how many digits the code needs to be so the tester knows what to enter

---

### Task 20: Identity Verification - Can we actually do OTP?
**Crew:** Identity Verification
**Type:** Feature Question
**Notes:**
- Question about whether actual OTP sending is possible (for future, not demo)

---

### Task 21: Consents - Missing transition message with process overview
**Crew:** Consents
**Type:** Wrong Reply
**Notes:**
- Between account selection and consents, need a transition message including:
  - Process overview and estimated duration - how many steps, how many minutes roughly
  - Freedom to ask questions - customer knows they can ask anything along the way
  - Option to stop and return - data is saved, can pause and return anytime
  - Positive framing for consents section: "נעשה את זה כמה שיותר קצר וקל"

---

### Task 22: Identity Verification - Add file/image upload option
**Crew:** Identity Verification
**Type:** Feature Request
**Notes:**
- Need ability to actually upload image/file for ID verification

---

### Task 23: Identity Verification - OTP should come before ID document
**Crew:** Identity Verification
**Type:** Wrong Reply
**Notes:**
- Agent should do OTP verification BEFORE requesting ID document, not after

---

### Task 24: Consents - Only 2 required consents, presented separately
**Crew:** Consents
**Type:** Wrong Reply
**Notes:**
- Only 2 consents are actually required:
  1. Consent to use the service (הסכמה לשימוש בשירות)
  2. Consent to access credit database (פניה למאגר נתוני אשראי)
- All other playbook guidelines remain as-is
- Each consent needs to be presented separately (see Task 25)

---

### Task 25: Consents - Each consent separately, not all at once
**Crew:** Consents
**Type:** Wrong Reply
**Notes:**
- Each consent should be presented one at a time, moving through them individually
- Not dumping all consents in one message

---

### Task 26: Welcome - Opening message needs to be more inviting and detailed
**Crew:** Welcome (entry-introduction)
**Type:** Wrong Reply
**Notes:**
- Current opening is too brief: "שלום! אני כאן כדי לעזור לך לפתוח חשבון בנק חדש. איך קוראים לך?"
- Should be more inviting and detailed, also for someone still considering
- Example: "שלום! אני כאן כדי ללוות אותך בפתיחת חשבון בנק חדש. אוכל להסביר על המסלולים, המוצרים והיתרונות, לעשות יחד התאמה לצרכים שלך, ולוודא שתצאי מפה עם החשבון שהכי טוב עבורך. בואו נתחיל – איך קוראים לך?"

---

### Task 27: Account Selection - Add bank contact info to KB
**Crew:** Account Selection
**Type:** Wrong Reply
**Notes:**
- Add to Knowledge Base: phone numbers, links, and contact methods for each bank
- So agent can provide real contact details instead of placeholders

---

### Task 28: Account Selection - Show options as visual sliders/cards
**Crew:** Account Selection
**Type:** Wrong Reply
**Notes:**
- Should present options: private account or other
- Both options should appear as slider/card UI for selection
- "Other" option should show "לא נתמך כרגע" (not supported currently)
