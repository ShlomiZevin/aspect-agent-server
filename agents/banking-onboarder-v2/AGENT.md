# Banking Onboarder V2 (LYBI) - Bank Account Opening Assistant

## Overview

Banking Onboarder V2 is a Hebrew-language bank account opening assistant called **LYBI** (Hebrew: ליבי). It guides users through opening bank accounts with personalized product recommendations using a multi-stage crew system with a thinker/talker architecture.

**Language:** Hebrew exclusively
**Status:** Partially complete — 2 of ~3+ planned crews implemented

---

## Crew System (2 Stages)

LYBI uses a sequential pipeline with automatic transitions based on field collection and thinker analysis.

```
Welcome → Advisor → [Third crew TBD]
```

### 1. Welcome (Default)

**Purpose:** Warm introduction, eligibility qualification, service consent collection.
**Model:** Gemini 2.5 Flash
**Display Name:** "Welcome" (Hebrew: ברוכים הבאים)

**Fields Collected (preMessageTransfer):**
| Field | Description | Requirement |
|-------|-------------|-------------|
| `user_name` | Name or nickname | Required |
| `gender` | Hebrew language agreement (m/f) | Auto-inferred via `set_gender` tool |
| `age` | Minimum 16+ | Required |
| `account_type` | Must be "personal" | Required |
| `service_consent` | Mandatory consent (re-extracted every message) | Required |

**Tool: `set_gender`**
- Infers gender from Hebrew/English names using GPT-4o-mini
- Requires 99%+ confidence to auto-set
- If uncertain, LYBI asks: "How should I address you, masculine or feminine?"
- Enables proper Hebrew gender agreement in all future responses

**Transition Logic (preMessageTransfer):**
- All gates must pass: age >= 16, account_type = "personal", service_consent = true
- On pass: persists `onboarding_profile` (conversation-level context) with name, age, accountType, startedAt
- Transitions to → `advisor`

---

### 2. Advisor

**Purpose:** Financial profile building + personalized product recommendations.
**Model:** Gemini 2.5 Flash (talker) + Claude Sonnet 4.6 (thinker)
**Display Name:** "Consultation & Matching" (Hebrew: ייעוץ והתאמה)
**Knowledge Base:** Enabled — "onboarding" vector store for account terms and features

**Profile Building (conversational, not form-based):**
- Employment status/type
- Income range (approximate)
- Expenses range
- Main expense types
- Financial commitments (high level)
- Expected account usage
- Relevant context (student, irregular income, etc.)

**Product Presentation (layered approach):**
| Layer | Products | When |
|-------|----------|------|
| Layer 1 (Mandatory) | Account plan: Basic / Plus / Premium | Always presented first |
| Layer 2 (After L1 accepted) | Credit card, checkbook | Only after Layer 1 agreement |
| Layer 3 (Value mention) | Loans, deposits, investments | Mentioned as future opportunities |

**Product Catalog:**
| Plan | Monthly Fee | Best For | Key Features |
|------|------------|----------|--------------|
| Basic | 0 NIS | Young, students, first account | Debit card, app, transfers |
| Plus | 19.90 NIS | Salaried, moderate income | Credit card, basic insurance, credit line |
| Premium | 49.90 NIS | High income, investment-minded | Platinum card, personal advisor, extended insurance |

**Thinker (Claude Sonnet 4.6):**
Analyzes the full conversation and returns strategic JSON:
- Profile assessment (employment, income, expenses, commitments)
- User type detection (first account, young, bad experience, browsing, etc.)
- Conversation state tracking (profiling → recommending → handling objections)
- Product matching with customer-specific reasoning
- Acceptance tracking (Layer 1 agreement, card/checkbook responses)
- Readiness decision: `readyToTransfer: true` only when L1 agreed AND L2 complete
- Strategy and tone notes for the next response

**State Persistence (after each thinker run):**
`advisor_state` (conversation-level):
- recommendedOffer, offerPitch
- layer1Agreed, offerAccepted
- cardOffered, cardResponse, checkbookOffered, checkbookResponse
- layer2Complete, readyToTransfer
- customerType, employment, incomeRange, expensesRange
- profileCompleteness, conversationState, productStatus

**Transition:** Currently inactive (`transitionTo: null`) — third crew not yet implemented.

---

## LYBI Persona

**Personality:**
- Female banking assistant — warm, confident, direct
- Conversational by design, not form-based
- Sales instinct — reads user intent, knows when to push/offer/pause
- Adaptive to financial literacy level
- Completion-driven, never bureaucratic

**Handling Principles (adapts based on user type):**
| User Type | Approach |
|-----------|----------|
| First Account | Simplified flow, basic financial education woven in |
| Young Users | Adjusted language/complexity |
| Bad Bank Experience | Acknowledge once, redirect to value |
| Browsing / Not Ready | Engage genuinely without pressure |
| Specific Purpose | Start from goal, not product |
| Attracted by Offer | Use offer as entry, build fuller picture |
| Life Event | Frame products around new chapter |

**Hebrew Language Rules:**
- LYBI always speaks in feminine form (e.g., "I'm helping" = אני עוזרת)
- Before gender known: combined forms (ברוך/ה)
- After gender confirmed: consistent gender agreement
- All interaction in Hebrew — no English fallback
- Proactively translates banking jargon in plain Hebrew

---

## Safety & Boundaries

**LYBI Does:**
- Guide through account opening start to finish
- Present relevant products with value-based positioning
- Answer banking/process questions
- Redirect to human banker when needed

**LYBI Does Not:**
- Approve or promise eligibility for discounts outside authority
- Make promises about outcomes she doesn't control
- Offer financial advice (presents options, not directives)
- Push product after clear rejection
- Speak negatively about other banks
- Collect beyond what's required

**Scope Tiers:**
- **Tier 1 (Full):** Account tracks, fees, credit limits, cards, benefits, checks
- **Tier 2 (Informational):** Loans, deposits, investments (no specific terms)
- **Out of scope:** Non-banking products → redirect

---

## Context Persistence

| Namespace | Level | Written By | Contains |
|-----------|-------|------------|----------|
| `onboarding_profile` | Conversation | Welcome crew | name, age, accountType, startedAt |
| `advisor_state` | Conversation | Advisor (per thinker run) | Full recommendation state, product acceptance, profile data |

No user-level context used — all state is conversation-scoped.

---

## Completion Status

| Crew | Status | Notes |
|------|--------|-------|
| Welcome | Complete | Qualification + consent |
| Advisor | Complete | Profiling + recommendations |
| Identity Verification | Not implemented | KYC, document verification |
| Account Creation | Not implemented | Final submission + confirmation |

The flow currently ends at the Advisor stage. The V1 agent (`agents/banking-onboarder/`) with 7 crews can serve as reference for extending the pipeline.

---

## File Structure

```
agents/banking-onboarder-v2/
├── AGENT.md                                    # This file
├── banking-onboarder-v2-persona.js            # Shared LYBI persona and values
├── offers-catalog.js                           # Product definitions (Basic/Plus/Premium)
└── crew/
    ├── index.js                                # Crew member exports
    ├── welcome.crew.js                         # Stage 1: Welcome + eligibility
    └── advisor.crew.js                        # Stage 2: Profile + recommendations (thinker/talker)
```

**Related files:**
- `agents/banking-onboarder/` — V1 agent with 7 crews (reference for extending V2)
- `crew/base/CrewMember.js` — Base class with thinker support
