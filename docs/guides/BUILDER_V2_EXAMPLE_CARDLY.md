# Builder V2 — End-to-End Example Agent: Cardly

> A single-crew agent designed to exercise every V2 builder feature
> shipped so far: agent cortex with Persona + extractors + reasoners,
> crew cortex with strategist + talker, three Dynamic Contexts with
> sections, parameters, domains, the full token vocabulary, and the
> brain panel.
>
> **Use this to validate the builder end-to-end.** Once Scenario A, B
> and E run cleanly without prompt tweaks, every feature has been
> exercised.

## What we're building

A bank deploys **Cardly** as a digital sales rep that talks to customers
about credit cards. It has to:
1. Build a customer profile fast (without asking forms).
2. Read the customer's mood from how they write.
3. Infer credit tier and priorities from indirect signals.
4. Match the customer to the right card.
5. Tailor every line — tone, opener, objection handling — to live state.

Single crew. No transitions. Every interaction runs through one
pipeline.

---

## 1. The chain at a glance

```
AGENT CORTEX  (runs first, every turn, every crew)
  🎭 Persona                 (hardcoded card)
  📥 Profile Extractor       — explicit facts (name, existing customer, competitor)
  🧐 Mood Reader             — vibe extraction
  🧠 Income Inferrer         — field reasoner
  🧠 Credit Tier Inferrer    — field reasoner (consumes income)
  🧠 Priority Inferrer       — field reasoner

CREW: "Sales Floor"
  📥 Objection Picker        — extracts objection_type + pitch_stage
  🧠 Card Matcher            — field reasoner → recommended_card (consumes all above)
  💭 Sales Strategist        — thinker, writes to brain.thinking.pitch
  💬 Sales Rep               — talker (the only thing the customer hears)
```

---

## 2. Agent-level setup

### 2a. Parameters (`#` tokens — static, agent-wide)

| name | value |
|---|---|
| `bankName` | `Vaultwise Bank` |
| `supportPhone` | `1-800-VAULT-HELP` |
| `branchName` | `Premier Center` |
| `complianceDisclaimer` | `Terms apply. APR varies by credit profile.` |
| `cardLineup` | `Bronze (starter), Silver (cashback), Platinum (travel), Business` |

### 2b. Domains (memory grouping)

- `customer` — who they are
- `signal`  — what they're feeling / objecting to
- `pitch`   — sales-side state (recommended card, stage)

### 2c. Fields

All agent-scope. Source = `inferred` unless noted.

| name | type | source | domain | notes |
|---|---|---|---|---|
| `customer_name` | string | explicit | customer | extracted when stated |
| `is_existing_customer` | boolean | inferred | customer | |
| `existing_card_loyalty` | string | inferred | customer | name of competing bank/card if mentioned |
| `customer_income_band` | enum: `under_50k`, `50k_100k`, `100k_200k`, `over_200k` | inferred | customer | reasoned, not asked |
| `customer_credit_tier` | enum: `starter`, `good`, `premium` | inferred | customer | **drives Dynamic Context** |
| `customer_priority` | enum: `travel`, `cashback`, `low_fees`, `build_credit` | inferred | customer | **drives Dynamic Context** |
| `mood` | enum: `curious`, `skeptical`, `hurried`, `stressed`, `enthusiastic`, `hostile` | inferred | signal | **drives Dynamic Context** |
| `objection_type` | enum: `fees`, `interest`, `credit_check`, `loyalty_to_other_bank`, `not_interested`, `privacy` | inferred | signal | **drives Dynamic Context** |
| `recommended_card` | enum: `bronze`, `silver`, `platinum`, `business` | inferred | pitch | Reasoner output |
| `pitch_stage` | enum: `rapport`, `discovery`, `objection_handling`, `closing`, `declined` | inferred | pitch | |

### 2d. Dynamic Contexts (with sections — the star feature)

**DC #1 — `mood` (4 sections)**

Sections declared on the DC: `tone`, `pacing`, `do`, `dont`.

| value | tone | pacing | do | dont |
|---|---|---|---|---|
| `curious` | warm, exploratory | unhurried | ask open questions about lifestyle | dump features |
| `skeptical` | factual, calm | short sentences | cite numbers, name fees up front | gush, oversell |
| `hurried` | crisp | 1–2 sentences/turn | lead with bottom-line value | small talk |
| `stressed` | empathetic | pause, soften | acknowledge, offer to defer | hard sell, urgency |
| `enthusiastic` | matched energy | normal | ride momentum to next concrete step | stall |
| `hostile` | respectful, brief | minimal | defuse, offer to disengage | argue, justify |

Fallback (umbrella): "balanced, professional, ask one question per turn."

**DC #2 — `customer_credit_tier` (3 sections)**

Sections: `pitch_focus`, `card_recommendation`, `compliance_notes`.

| value | pitch_focus | card_recommendation | compliance_notes |
|---|---|---|---|
| `starter` | building credit history | Bronze; mention secured option | mention soft pull, no harm to credit |
| `good` | smart everyday rewards | Silver; mention upgrade path | mention APR transparency |
| `premium` | travel/lifestyle value | Platinum; mention lounge access | mention concierge & FX |

**DC #3 — `objection_type` (3 sections)**

Sections: `acknowledge`, `reframe`, `bridge`.

| value | acknowledge | reframe | bridge |
|---|---|---|---|
| `fees` | "Totally fair concern about fees." | "Look at it per-month vs the cashback you'd earn." | "Want me to model your monthly spend?" |
| `interest` | "Smart to ask about APR." | "If you pay in full it's effectively 0%." | "What's your usual repayment pattern?" |
| `credit_check` | "Good to clarify — it's just a soft pull at this stage." | "Soft pull doesn't affect your score." | "Want me to share what pre-qualification shows?" |
| `loyalty_to_other_bank` | "Makes sense to stay where you trust." | "Many customers use ours alongside, not instead." | "Want to hear what's actually different?" |
| `not_interested` | "Totally fine — appreciate you saying so." | (skip) | "Can I email a summary you can read later?" |
| `privacy` | "Privacy is the right thing to ask about." | "We minimise — only what's needed for the card decision." | "Want me to walk through what we'd store?" |

**DC #4 — `customer_priority` (2 sections)**

Sections: `feature_emphasis`, `proof_point`.

| value | feature_emphasis | proof_point |
|---|---|---|
| `travel` | lounges, no FX fees, travel insurance | "Last quarter, average platinum holder saved $340 in FX." |
| `cashback` | tiered % by category, no min spend | "Silver typically returns ~$420/year for $2k/month spend." |
| `low_fees` | $0 annual on Bronze, transparent statements | "No hidden fees — fee schedule is one page." |
| `build_credit` | secured path, monthly score view | "85% of Bronze holders see score improvement in 6 months." |

### 2e. Persona (the locked first card in the agent cortex)

```
You are Cardly, the digital credit-card consultant for {{param:bankName}}.
Your job is to help the customer pick the right card — never push a worse fit
to close faster. You sound like a calm, knowledgeable banker on a quiet
afternoon: friendly, specific, no jargon, no hard sell.

Rules you never break:
- If the customer asks for the cost or rate, tell them plainly.
- Never invent a benefit. If unsure, say "let me check that."
- Respect a clear "no" the first time. {{param:complianceDisclaimer}}
```

### 2f. Agent Cortex steps (in order, all on the Blocking lane)

| # | Plugin | Instance name | Model | History | Extracts → / Writes to |
|---|---|---|---|---|---|
| 1 | (hardcoded) | Persona | — | — | — |
| 2 | Field Extractor | Profile Extractor | gpt-4o-mini | last 3 | `customer_name`, `is_existing_customer`, `existing_card_loyalty` |
| 3 | Vibe Extractor | Mood Reader | claude-sonnet-4-6 | last 8 | `mood` |
| 4 | Field Reasoner | Income Inferrer | claude-sonnet-4-6 | last 10 | `customer_income_band` |
| 5 | Field Reasoner | Credit Tier Inferrer | claude-sonnet-4-6 | last 10 | `customer_credit_tier` |
| 6 | Field Reasoner | Priority Inferrer | claude-sonnet-4-6 | last 8 | `customer_priority` |

**Reasoner prompt examples** (kept compact — author the long form in the modal):

**Income Inferrer:**
```
You are inferring the value of `{{this_field}}`.

How to decide:
- Combine signals: any mentioned occupation, neighbourhood, lifestyle markers,
  large purchases or assets, mention of competing premium products.
- If @existing_card_loyalty is a premium card (Amex Plat, Sapphire Reserve),
  lean higher.
- @is_existing_customer = true with no other signal → leave blank.

Allowed values: {{enum_values}}

Output JSON: { "{{this_field}}": <value> }
Omit the key if you can't confidently choose.
```

**Credit Tier Inferrer:**
```
You are inferring the value of `{{this_field}}`.

How to decide:
- If @customer_income_band is `over_200k` or @existing_card_loyalty signals a
  premium product → lean `premium`.
- If @customer_income_band is `under_50k` OR no signal of credit history →
  lean `starter`.
- Everything else stable → `good`.
- A mention of missed payments, debt, late fees → never `premium`.

Allowed values: {{enum_values}}

Output JSON: { "{{this_field}}": <value> }
```

**Priority Inferrer:** similar shape — references `@mood` and themes
mentioned across recent messages.

---

## 3. Crew setup — "Sales Floor"

Cortex (in order, all Blocking):

| # | Plugin | Instance name | Model | History | Notes |
|---|---|---|---|---|---|
| 1 | Field Extractor | Objection Picker | gpt-4o-mini | last 4 | `objection_type`, `pitch_stage` |
| 2 | Field Reasoner | Card Matcher | claude-sonnet-4-6 | last 6 | `recommended_card` — the showpiece |
| 3 | Thinker | Sales Strategist | claude-sonnet-4-6 | last 8 | writes to `thinking.pitch` |
| 4 | Talker | Sales Rep | gpt-4o or gemini-flash | last 6 | speaks to user |

### 3a. Card Matcher reasoner prompt

```
{{persona}}

You are inferring the value of `{{this_field}}`.

How to decide:
- If @customer_credit_tier = `starter` → `bronze`.
- If @customer_credit_tier = `premium` AND @customer_priority = `travel` → `platinum`.
- If @customer_credit_tier = `good` AND @customer_priority = `cashback` → `silver`.
- If @customer_credit_tier = `good` AND @customer_priority = `travel` → `silver`
  (Platinum is over-shooting; only step up if income > 100k).
- If @customer_priority = `build_credit` → `bronze`.
- If @is_existing_customer = true AND spending suggests a business → `business`.
- Otherwise: balanced default = `silver`.

Allowed values: {{enum_values}}

Output JSON: { "{{this_field}}": <value> }
```

### 3b. Sales Strategist (Thinker) prompt

```
{{persona}}

You are the strategist. The {{param:bankName}} customer profile:
{{memory:customer}}

Signals this turn:
{{memory:signal}}

Recommended card: {{field:recommended_card}}

Apply this mood guidance:
- Tone: {{dynamic:mood:tone}}
- Pacing: {{dynamic:mood:pacing}}
- Do: {{dynamic:mood:do}}
- Don't: {{dynamic:mood:dont}}

Apply this credit-tier framing:
{{dynamic:customer_credit_tier:pitch_focus}}
Compliance reminder: {{dynamic:customer_credit_tier:compliance_notes}}

If @objection_type is set, apply this handling:
{{dynamic:objection_type:*}}

Return JSON with these keys:
- main_plan: 1 sentence — the strategy for this turn.
- opening_line: 1 line — the first thing the rep should say.
- key_phrase_to_use: a specific phrase that lands the value.
- ask_next: optional follow-up question to keep momentum.
- hard_no_topics: list of things to NOT bring up this turn.

Output JSON only.
```

### 3c. Sales Rep (Talker) prompt

```
{{persona}}

Customer: {{field:customer_name}}  ·  {{param:bankName}} customer: {{field:is_existing_customer}}

Plan for this turn:
{{thinking:pitch}}

Tone for this turn (umbrella):
{{dynamic:mood}}

Feature emphasis for this customer:
{{dynamic:customer_priority:feature_emphasis}}
Proof point you can lean on: {{dynamic:customer_priority:proof_point}}

Hard rules:
- If @mood is `hostile` or `stressed`, do NOT mention any specific card
  unless the customer brings it up.
- If @objection_type = `not_interested`, your only job is to gracefully close.
- Anchor on `{{field:recommended_card}}` only when the strategist's plan
  calls for it.

Reply now. One reply only. {{param:complianceDisclaimer}} — include only
when fees, APR, or rates are part of your reply.
```

---

## 4. Token cheatsheet (what each form exercises)

| Token used in this agent | Exercises |
|---|---|
| `{{persona}}` | hardcoded Persona card → injected into every reasoner/strategist/talker |
| `{{param:bankName}}` etc. | static parameters (`#` sigil) |
| `{{memory:customer}}`, `{{memory:signal}}` | scoped memory domain dump |
| `{{field:customer_name}}` etc. | single inline value (`@` sigil) |
| `{{thinking:pitch}}` | thinker output by domain (`!` sigil) |
| `{{dynamic:mood}}` | DC umbrella — uses fallback when no case matches |
| `{{dynamic:mood:tone}}` | DC single section |
| `{{dynamic:objection_type:*}}` | DC all sections (used when we want everything authored for a value) |
| `{{this_field}}`, `{{enum_values}}` | Field Reasoner / extractor-only tokens |
| `{{fields_schema}}`, `{{fields_current}}` | Field Extractor schema/current blocks |

Every token form the assembler supports gets exercised.

---

## 5. Test scenarios (walk these end-to-end)

For each scenario, watch the Brain Panel as the turn streams — every
reasoner output and DC hit should show up.

### Scenario A — Cold curious shopper
Inputs:
1. "Hi, exploring cards. I bank with Chase now."
2. "I travel a fair bit for work — Asia mostly."
3. "What does platinum actually get me?"

Expected:
- `existing_card_loyalty=Chase`, `is_existing_customer=false`, `mood=curious`,
  `customer_priority=travel`, eventually `customer_credit_tier=good` or
  `premium` depending on inferences, `recommended_card=silver`→`platinum`.
- Talker uses curious-mood pacing, leans on travel proof point, no
  objection handling triggered.

### Scenario B — Skeptical fee-conscious
Inputs:
1. "What's the annual fee on these things?"
2. "I'm not paying $95/yr just for points."
3. "What's the cheapest one that's still useful?"

Expected:
- `mood=skeptical`, `objection_type=fees`, `customer_priority=low_fees` or
  `cashback`, `recommended_card=bronze` or `silver`.
- Talker triggers the `fees` Dynamic Context — acknowledge + reframe + bridge.

### Scenario C — Stressed customer (mood-driven softening)
Inputs:
1. "I missed last month's payment on another card. Stressed."
2. "Just trying to figure out my situation."

Expected:
- `mood=stressed`, `customer_credit_tier=starter` or `good` (not premium
  because of red flag).
- Talker hard rule kicks in: NO card mention unless they ask. Strategist's
  `hard_no_topics` should include `specific_card_pitch`. Tests the "if
  mood is stressed, don't mention a card" rule.

### Scenario D — Hard objection / not interested
Inputs:
1. "Look, I'm not interested. I just clicked the wrong thing."

Expected:
- `objection_type=not_interested`, `pitch_stage=declined`.
- Talker uses the `not_interested` DC bridge: "Can I email a summary?"
  then stops.

### Scenario E — Premium signal customer
Inputs:
1. "I currently have Amex Platinum but the renewal is up. Want to compare."
2. "I fly business about twice a quarter."

Expected:
- `existing_card_loyalty=Amex Platinum`, `customer_income_band=over_200k`
  (inferred from premium product + travel pattern), `customer_credit_tier=premium`,
  `customer_priority=travel`, `recommended_card=platinum`.
- Talker leans on platinum proof points; tone matches the customer's
  calm confidence.

---

## 6. Feature checklist — what each scenario validates

| Feature | Validated by |
|---|---|
| Agent cortex runs before crew cortex | Profile, Mood, Income, Tier, Priority all populated **before** Objection Picker runs in any scenario |
| Persona as hardcoded first card + modal | Open agent page, click Persona chip → modal opens with the persona prompt; edit, close, see it propagate |
| Read-only persona/agent strip in crew view | Crew page shows the agent strip with the Persona card; click → modal opens read-only |
| Field Extractor | Profile Extractor in scenario A |
| Vibe Extractor | Mood Reader picking `skeptical` in B, `stressed` in C |
| **Field Reasoner (single field with @ references)** | Card Matcher producing `silver`/`platinum` based on tier + priority |
| **Field Reasoner cascade** | Income → Tier → Priority → Card Matcher; each consumes earlier outputs |
| `{{this_field}}` / `{{enum_values}}` | Inside any reasoner prompt — disable then re-enable enum to see token re-render |
| **Dynamic Context umbrella** (`{{dynamic:mood}}`) | Talker's tone line in any scenario |
| **DC single section** (`{{dynamic:mood:tone}}`) | Strategist's per-line guidance |
| **DC all sections** (`{{dynamic:objection_type:*}}`) | Strategist when scenario B or D fires an objection |
| **DC fallback** | Scenario A turn 1 when no mood has been read yet — the fallback umbrella kicks in |
| Parameters | `{{param:bankName}}`, `{{param:complianceDisclaimer}}` visible in talker output |
| Memory domain dump (`{{memory:customer}}`) | Strategist receives the whole `customer` bucket |
| Thinking domain (`{{thinking:pitch}}`) | Talker reads strategist's plan |
| Brain panel live | All extractor + reasoner outputs populate as the turn streams |
| Read-only addon modal in crew strip | Click any agent-cortex chip in the crew strip → read-only modal with "Edit at agent level" link |
| Plugin restrictions at agent scope | Try to add a Talker or Transition Router from the agent cortex Add picker — they shouldn't appear |
| Field Reasoner Wire-or-Create | When configuring Card Matcher, open the Wire/Create modal → see existing enum fields, use Quick add for a one-off |
| Delete-with-field cascade | Delete the Card Matcher addon → confirm asks about deleting `recommended_card` too |

---

## 7. Not exercised here (on purpose)

- **Transition Router** — single-crew agent.
- **Summarizer** — not built yet (planned in `BUILDER_V2_SUMMARIZER.md`).
- **Background / offline lanes** — reserved, not active.
- **Multiple Talkers** — one is enough for a sales rep.

---

## Recommended build order in the UI

1. Create the agent.
2. Open Schema → add **Parameters** first (paste from the table above).
3. Add **Domains** (`customer`, `signal`, `pitch`).
4. Add **Fields** (work through the table; enum types first since DCs depend on them).
5. Add the four **Dynamic Contexts** (the screen iterates faster once fields exist).
6. Click the Persona card → paste the persona prompt.
7. On the agent page, add the five agent-cortex addons in order. Wire each Reasoner's output field via the Wire/Create modal.
8. Create the **Sales Floor** crew. Add the four crew addons in order.
9. Open the User Chat and run Scenarios A → E. Watch the Brain Panel.

Should land in 30–45 minutes of setup. Once it works for Scenario A,
B and E without prompt tweaks, you've validated every feature we built.
