# Freeda - Menopause Wellness Companion

## Overview

Freeda 2.0 is an AI menopause wellness companion for women aged 38+. It combines clinical expertise with emotional intelligence to help women navigate menopause with clarity and confidence. It is **not** a medical service — it provides supportive education, symptom tracking, and evidence-based guidance.

**Model:** GPT-5-chat-latest
**Language:** Multi-lingual with cultural/locale adaptation (detects country from WhatsApp phone number)
**Knowledge Base:** Freeda 2.0 vector store (enabled on all crews)

---

## Crew System (5 Stages)

Freeda uses a sequential crew pipeline. Users progress through stages automatically based on field collection and tool-based state tracking.

```
Introduction → Profiler → Symptom Assessment → Assessment Closure → General
      ↘ (ineligible)
```

### 1. Introduction (Default)

**Purpose:** Welcome, eligibility screening, Terms of Service consent.

**Fields Collected (preMessageTransfer):**
- `name` — first name or nickname
- `age` — numeric age
- `tos_acknowledged` — affirmative consent after ToS presentation

**Transition:**
- Eligible (female, age >= 38) → `profiler`
- Ineligible (male or age < 38) → `ineligible`

---

### 2. Profiler

**Purpose:** Build a journey profile — understand where the user is in their menopause experience.

**Fields Collected (preMessageTransfer):**
- `menstrual_status` — regular | irregular | stopped | not_applicable
- `treatment_history` — never_tried | tried_in_past | currently_using | prefer_not_to_say
- `cycle_clarification` — (required if stopped/not_applicable) surgery | medical_condition | other
- `perceived_stage` — just_starting | in_the_middle | experienced | unsure
- `prior_exposure` — none | some_reading | actively_researching | seen_professionals
- `sense_of_change` — mild | moderate | significant | overwhelming

**Internal Analysis (never shown to user):**
- `estimatedPosition` — early_awareness | active_transition | post_diagnostic
- `symptomGroupPriority` — order to explore emotional/cognitive/physical
- `recommendedDepth` — gentle | moderate | detailed
- `toneAdjustment` — warm_exploratory | reassuring_educational | empathetic_supportive | collaborative_informed | extra_gentle_validating

**Context Saved:** `journey` (user-level) — persists across conversations.

**Transition:** When `menstrual_status` + `treatment_history` (+ `cycle_clarification` if needed) are collected → `symptom_assessment`

---

### 3. Symptom Assessment

**Purpose:** Structured exploration of 3 symptom groups using tool-based state (postMessageTransfer).

**Symptom Groups:**
| Group | Symptoms |
|-------|----------|
| Emotional | anxiety, mood swings, irritability, feeling low, emotional sensitivity, overwhelm |
| Cognitive | brain fog, concentration difficulty, memory lapses, word-finding, mental fatigue |
| Physical | hot flashes, night sweats, sleep issues, fatigue, joint/muscle pain, weight changes |

**Group order** is determined by the profiler's `symptomGroupPriority` analysis.

**Flow per group:**
1. Introduce group with relatable examples
2. For each symptom identified → call `report_symptom` tool
3. When done with group → call `complete_symptom_group` or `skip_symptom_group`

**Context Used:**
- Reads `journey` (from profiler) to determine group order
- Writes `symptom_assessment` (conversation-level) — tracks currentGroup, groupsCompleted, groupOutcomes

**Transition:** When all 3 groups completed (postMessageTransfer) → saves `symptom_summary` (user-level) → `assessment_closure`

---

### 4. Assessment Closure (oneShot)

**Purpose:** Reflect on assessment findings, reframe as a starting point, position Freeda as ongoing companion.

**Three-layer structure:**
1. **Reflection** — patterns/themes in human language (not clinical)
2. **Reframing** — this is a starting point, not a conclusion
3. **Companion Positioning** — why Freeda stays relevant going forward

**Context Used:** Reads `journey` + `symptom_summary`

**Transition:** oneShot — auto-transitions to `general` on the next user message.

---

### 5. General (Ongoing)

**Purpose:** All ongoing menopause guidance — treatment discussions, HRT concerns, emotional support, lifestyle advice.

**Context Used:** Reads `journey` to adapt tone/depth based on profile.

**Tool:** `report_symptom` — can still record new symptoms during conversation.

**Max Tokens:** 2048 (highest of all crews)

---

## Tools

| Tool | When Used | Parameters |
|------|-----------|------------|
| `report_symptom` | Each symptom mentioned (assessment + general) | `user_description` (required), `symptom_group` (required), `impact` (optional), `timing` (optional) |
| `complete_symptom_group` | Group explored, symptoms were found | `symptom_group` (required) |
| `skip_symptom_group` | User confirms NO symptoms in group | `symptom_group` (required), `user_statement` (required) |

**report_symptom** records to the `user_symptoms` database table with userId, conversationId, symptomGroup, crewMember, impact, and timing.

**complete/skip_symptom_group** update the `symptom_assessment` conversation-level context, advancing `currentGroup` and tracking `groupOutcomes`.

---

## Context Persistence

| Namespace | Level | Written By | Read By | Contains |
|-----------|-------|------------|---------|----------|
| `journey` | User | Profiler | Assessment, Closure, General | Profile inputs + internal analysis (position, depth, tone) |
| `symptom_assessment` | Conversation | Assessment tools | Assessment crew | currentGroup, groupsCompleted, groupOrder, groupOutcomes |
| `symptom_summary` | User | Assessment (on transition) | Closure | Outcomes per group, completedAt |

Additionally, individual symptoms are stored in the `user_symptoms` database table.

---

## Transition Summary

| Crew | Mechanism | Trigger |
|------|-----------|---------|
| Introduction | preMessageTransfer (field-based) | name + age + tos → eligibility check |
| Profiler | preMessageTransfer (field-based) | menstrual_status + treatment_history collected |
| Symptom Assessment | postMessageTransfer (tool-based) | 3 groups completed via tool calls |
| Assessment Closure | oneShot | Delivers once, auto-transitions next message |
| General | Terminal | No transition out |

---

## Safety & Boundaries

**Hard Stops (immediate escalation):**
- Suicidal ideation → Samaritans 116 123 (UK)
- Medical emergency → 999
- Domestic violence → National Domestic Abuse Helpline 0808 2000 247

**HITL Flags (async human review):**
- Significant distress, denied care, adverse reactions, access barriers, mental health concerns beyond menopause, harmful intent, explicit human request

**Clinical Boundaries:**
- Provides evidence-based info, emotional support, symptom help, appointment preparation
- Does NOT diagnose, recommend specific drugs/dosages, interpret test results, or instruct treatment changes

**HRT Policy:**
- Address concerns first, lead with benefits, compare absolute risks in context
- Current science supports HRT for most women as the most effective treatment

---

## File Structure

```
agents/freeda/
├── AGENT.md                          # This file
├── freeda-persona.js                 # Full persona definition
└── crew/
    ├── index.js                      # Crew member exports
    ├── introduction.crew.js          # Stage 1: Welcome + eligibility
    ├── profiler.crew.js              # Stage 2: Journey positioning
    ├── symptom-assessment.crew.js    # Stage 3: 3-group symptom exploration
    ├── assessment-closure.crew.js    # Stage 4: Reflection + positioning
    └── general.crew.js              # Stage 5: Ongoing support
```

**Related files:**
- `functions/symptom-tracker/` — `report_symptom` tool handler
- `functions/symptom-group-completion.js` — `complete_symptom_group` and `skip_symptom_group` handlers
- `services/context.service.js` — getContext/writeContext for persistence
