# Task: Banking Thinking Model — 3-Crew Agent with Thinker+Talker Architecture

## Problem

The current banking onboarder has 9 sequential crews that feel like a rigid form wizard. Each crew handles a narrow step (welcome → account-type → consents → identity → kyc → profile → offers → confirmations → completion). The conversation is procedural, not consultative. There's no real "selling" — the agent just collects data and presents a result.

## Goal

A new agent variant ("banking-onboarder-v2") with **3 crews** and a smarter conversation design. The core crew uses a **thinker+talker** pattern where a reasoning LLM (Claude) advises a conversational LLM (GPT-5) on what to ask and when to recommend — creating a natural selling process.

The customer should feel like they're having a real conversation with a knowledgeable banker, not filling out a form.

---

## Architecture: Thinker+Talker

### How It Works

Before each response, the main crew calls a **ThinkingAdvisorAgent** (Claude) inside `buildContext()`. The thinker analyzes the conversation and returns structured advice. The talker (GPT-5) sees this advice in its context and responds naturally.

```
User message
  → Dispatcher calls buildContext()
    → buildContext() calls ThinkingAdvisorAgent.think() (Claude, ~1-2s)
    → Thinker returns JSON advice (next question, strategy, readyToRecommend)
    → Advice injected into context
  → Dispatcher streams crew response (GPT-5 sees advice in context)
  → FieldsExtractorAgent runs in parallel (extracts mandatory fields)
  → preMessageTransfer checks if offer_accepted → transition
```

**Key: zero changes to dispatcher or base class.** The thinker runs inside `buildContext` (already async) using `llmService.sendOneShot()`.

### Why Not a Single Thinking Model?

A thinking model (Claude extended thinking, o3) could put everything in one prompt. But:
- Reasoning is hidden — not inspectable or debuggable
- Can't use different models for reasoning vs. conversation
- Less control over selling strategy
- Not reusable by other crews

The thinker+talker approach gives structured, visible advice that any crew can reuse.

---

## The 3 Crews

### 1. `welcome` (default)

Quick entry. Collect name + age, check eligibility (>= 16).

- **Fields:** `user_name`, `age`
- **Transition:** `main-conversation` (when both collected and age >= 16)
- **Guidance:** Short. Greet, ask name, ask age, confirm eligibility. 2 messages max.
- **Model:** gpt-5-chat-latest

### 2. `main-conversation` (core)

The heart of the agent. A selling conversation powered by thinker+talker.

- **Mandatory fields:** `employment_status`, `primary_income_source`, `monthly_income_range`, `expected_account_usage`, `offer_accepted` (boolean)
- **Transition:** `review-finalize` (when `offer_accepted` = true)
- **extractionMode:** conversational
- **Model:** gpt-5-chat-latest (talker), claude-sonnet (thinker)

**Sequential field exposure:** `getFieldsForExtraction` exposes one mandatory field at a time. After all mandatory fields collected, exposes `offer_accepted`.

**Thinker prompt (Claude system prompt):**

```
You are a strategic advisor for a banking onboarding agent. You analyze the customer's
profile and conversation to guide the talker agent.

You receive: conversation history, collected fields, available account offers.

Return JSON:
{
  "customerAnalysis": "Brief profile summary based on what's known",
  "nextQuestion": "The single question to ask next (or null if ready to recommend)",
  "questionRationale": "Why this question matters — keep internal",
  "sellingStrategy": "Current approach notes for the talker",
  "readyToRecommend": true/false,
  "recommendedOffer": null or offer ID from catalog,
  "recommendationPitch": "How to present this offer (when recommending)",
  "toneNotes": "Tone adjustments based on conversation signals"
}

Rules:
- Even if you know the right offer early, keep asking to build rapport and confidence.
  The customer should feel understood before hearing a recommendation.
- Mandatory fields must all be collected before recommending.
- Mix mandatory questions with strategic ones: lifestyle, banking frustrations,
  what matters most in a bank, future financial plans.
- The recommendation should feel earned — not formulaic.
- When the customer shows urgency or impatience, accelerate. Don't over-cook.
```

**Talker guidance (GPT-5 crew prompt):**

```
You are a banking advisor having a natural conversation to find the perfect account for this customer.

You receive "thinkingAdvice" in your context — use it:
- Ask the question it suggests, in your own natural words
- Follow its selling strategy and tone notes
- When it says ready to recommend: present the offer warmly with its features, pricing,
  and why it's right for this specific customer
- After presenting: guide toward acceptance without pressure

Never mention internal systems, advice, or the thinking process.
You are just a knowledgeable banker having a great conversation.
```

**buildContext flow:**

```js
async buildContext(params) {
  // 1. Load conversation history (last 20 messages)
  // 2. Load onboarding_profile from welcome crew
  // 3. Build context string for thinker (profile + fields + offers + history)
  // 4. Call thinkingAdvisor.think() → structured JSON advice
  // 5. If thinker fails → fallback advice (ask next missing mandatory field)
  // 6. If readyToRecommend → persist advisor_state to context (for review crew)
  // 7. Return context with thinkingAdvice + recommendedOfferDetails
}
```

### 3. `review-finalize` (terminal)

Summary, authorization, celebration. No transition.

- **Fields:** `authorized` (boolean)
- **Transition:** null (end of journey)
- **extractionMode:** form
- **Model:** gpt-5-chat-latest

**Guidance:**

```
First message: Summarize the chosen offer (name, features, fee).
Include links: terms, privacy, fees. Ask for explicit authorization.

After authorization: Celebrate. Account opened.
What's ready now (app, online banking), what's coming (card, email). Warm goodbye.
```

**buildContext:** Reads `advisor_state` context (written by main-conversation) to get the recommended offer details.

---

## New General-Purpose Service: ThinkingAdvisorAgent

**File:** `crew/micro-agents/ThinkingAdvisorAgent.js`

Follows the exact same pattern as `FieldsExtractorAgent.js`: stateless singleton, one main method, `sendOneShot`.

```js
class ThinkingAdvisorAgent {
  /**
   * @param {Object} params
   * @param {string} params.thinkingPrompt - System prompt for the thinker
   * @param {string} params.context - Formatted context string
   * @param {Object} options
   * @param {string} options.model - Default: claude-sonnet-4-20250514
   * @param {number} options.maxTokens - Default: 1024
   * @param {boolean} options.jsonOutput - Default: true
   * @returns {Promise<Object|string>} Parsed JSON or raw string
   */
  async think({ thinkingPrompt, context }, options = {}) {
    // sendOneShot with Claude, parse JSON, return
    // On error: return { error: true, fallback: true }
  }
}

module.exports = new ThinkingAdvisorAgent();
```

Any crew in any agent can use this in the future by calling `thinkingAdvisor.think()` in its `buildContext`.

---

## Offers Catalog

**File:** `agents/banking-onboarder-v2/offers-catalog.js`

Static data module. Placeholder — will be customized.

```js
const OFFERS = [
  {
    id: 'basic',
    name: 'חשבון בסיסי',
    monthlyFee: 0,
    features: ['כרטיס חיוב', 'אפליקציית בנקאות', 'העברות'],
    bestFor: 'Young, first account, students, low income'
  },
  {
    id: 'plus',
    name: 'חשבון פלוס',
    monthlyFee: 19.90,
    features: ['כרטיס אשראי', 'ביטוח בסיסי', 'מסגרת אשראי', 'שירות עדיפות'],
    bestFor: 'Salaried, moderate income, daily use + savings'
  },
  {
    id: 'premium',
    name: 'חשבון פרימיום',
    monthlyFee: 49.90,
    features: ['כרטיס פלטינום', 'ביטוח מורחב', 'יועץ אישי', 'הנחות מיוחדות'],
    bestFor: 'High income, multiple financial needs'
  }
];
```

---

## Simplified Persona

**File:** `agents/banking-onboarder-v2/banking-onboarder-v2-persona.js`

Same spirit as current (~80 lines), compressed to essentials (~15 lines):

```
# Banking Onboarder - Character

You are a digital banking assistant opening a new bank account with a customer.
Warm, confident, human. A knowledgeable friend who works at a bank.

## Rules
- Hebrew. Natural Israeli Hebrew, not formal banking language.
- One question per message. No exceptions.
- Short: 1-3 sentences per message.
- Gender: match customer's gender in Hebrew. Before known, use neutral phrasing.
- Never judge financial situations. Match and serve.
- Frame as availability, not gatekeeping ("the bank offers..." not "if you qualify...").
- Give context before sensitive info requests.
- Emojis: milestone moments only, one per message max.
```

---

## File Structure

```
aspect-agent-server/
  crew/micro-agents/
    ThinkingAdvisorAgent.js              ← NEW (general-purpose)
  agents/banking-onboarder-v2/
    banking-onboarder-v2-persona.js      ← NEW
    offers-catalog.js                    ← NEW
    crew/
      index.js                           ← NEW
      welcome.crew.js                    ← NEW
      main-conversation.crew.js          ← NEW
      review-finalize.crew.js            ← NEW

aspect-react-client/src/
  agents/banking-onboarder-v2.config.ts  ← NEW (copy from existing, change agentName)
  pages/BankingOnboarderV2Page.tsx       ← NEW (copy from existing page pattern)
  App.tsx                                ← EDIT (add route)
```

---

## Context Flow Between Crews

| Namespace | Written By | Read By | Content |
|-----------|-----------|---------|---------|
| `onboarding_profile` | welcome | main-conversation, review-finalize | name, age, startedAt |
| `advisor_state` | main-conversation | review-finalize | recommendedOffer, recommendationPitch |
| `onboarding_completion` | review-finalize | (external) | completed, accountNumber |

All conversation-level (fresh per conversation).

---

## Implementation Sequence

1. **ThinkingAdvisorAgent** — standalone, no dependencies
2. **Offers catalog** — standalone data module
3. **Simplified persona** — standalone
4. **Welcome crew** — depends on persona
5. **Main-conversation crew** — depends on 1, 2, 3
6. **Review-finalize crew** — depends on 2, 3
7. **Crew index** — depends on 4, 5, 6
8. **Register agent in DB** — `INSERT INTO agents` with name 'banking-onboarder-v2'
9. **Client config + page + route** — standard wiring
10. **Test end-to-end**

Steps 1-3 are independent (parallel). Steps 4-6 are independent of each other.

---

## Notes

- **Thinker latency:** Claude sendOneShot adds ~1-2s before streaming starts. Use claude-sonnet (fast), not opus. Acceptable tradeoff for strategic quality.
- **Thinker fallback:** If Claude fails, crew falls back to basic mode — asks next missing mandatory field, recommends basic account when all collected. User never knows.
- **No dispatcher changes needed.** Everything runs inside existing `buildContext` → `sendMessageStreamWithPrompt` flow.
- **Prompt writing principles apply:** Identity-first prompts, no whack-a-mole rules, short and natural.
