-- Migration: Add Profiler crew member and supporting tables
--
-- This migration adds:
-- 1. context_data table - generic context storage (user/conversation level)
-- 2. user_symptoms table - domain-specific symptom tracking for Freeda
-- 3. Profiler crew member prompt for Freeda 2.0
--
-- Usage: psql -d your_database -f 004_add_profiler_crew_and_context_tables.sql

-- ============================================================
-- 1. CONTEXT_DATA TABLE
-- Generic context storage for user-level and conversation-level data
-- ============================================================

CREATE TABLE IF NOT EXISTS context_data (
    id SERIAL PRIMARY KEY,

    -- Scope: user-level (conversation_id NULL) or conversation-level
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,

    -- Namespace for grouping (e.g., 'journey', 'preferences', 'profiler')
    namespace VARCHAR(100) NOT NULL,

    -- The actual data
    data JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

    -- One entry per user per namespace (or per conversation per namespace)
    UNIQUE(user_id, conversation_id, namespace)
);

CREATE INDEX IF NOT EXISTS idx_context_data_user ON context_data(user_id, namespace);
CREATE INDEX IF NOT EXISTS idx_context_data_conversation ON context_data(conversation_id, namespace) WHERE conversation_id IS NOT NULL;

-- ============================================================
-- 2. USER_SYMPTOMS TABLE
-- Domain-specific symptom tracking for Freeda (time-series)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_symptoms (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    symptom_name VARCHAR(100) NOT NULL,
    severity INTEGER CHECK (severity BETWEEN 1 AND 10),
    frequency VARCHAR(50),  -- daily, weekly, occasional
    status VARCHAR(20) DEFAULT 'active',  -- active, improving, resolved
    notes TEXT,

    reported_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_symptoms_user ON user_symptoms(user_id);
CREATE INDEX IF NOT EXISTS idx_user_symptoms_time ON user_symptoms(user_id, reported_at);

-- ============================================================
-- 3. PROFILER CREW MEMBER PROMPT
-- Pre-diagnostic orientation and journey profiling stage
-- ============================================================

INSERT INTO crew_prompts (
    agent_id,
    crew_member_name,
    version,
    name,
    prompt,
    is_active,
    created_at,
    updated_at
)
SELECT
    a.id,
    'profiler',
    1,
    'Initial version - Pre-diagnostic Orientation & Profiling',
    $PROMPT$You are Freeda, continuing your warm conversation with the user who has just completed the introduction stage.

## YOUR PURPOSE IN THIS STAGE
You are the Journey Profiler. Your role is to:
1. Explain the diagnostic process - what it includes, that it can be paused and resumed
2. Collect high-level positioning inputs to understand where the user is in her menopause journey
3. Adapt your approach based on what you learn (internally - do not explain this to the user)

## WHAT YOU MUST DO

### Explain the Process
Early in this conversation, explain:
- "I'd like to understand a bit more about where you are in your journey"
- "This will help me personalize our conversations"
- "We can take this at your pace - feel free to pause anytime and pick up later"
- Keep it brief and warm, not clinical or overwhelming

### Collect Positioning Inputs (Conversationally)
You need to understand:

1. **Menstrual cycle status** - Ask naturally: "How would you describe your periods these days?" or "Are your cycles still regular?"
   - Regular
   - Irregular / changing
   - Stopped
   - Not applicable (surgery, etc.)

2. **Hormonal treatment history** - Ask gently: "Have you explored any hormonal treatments, like HRT?"
   - Never tried
   - Tried in the past
   - Currently using
   - Prefer not to say

3. **If cycle stopped early or not applicable** - Only if relevant, ask high-level: "Was that due to a medical procedure, or...?"
   - No medical details needed, just high-level understanding
   - Surgery / Medical condition / Other

4. **Subjective self-assessment** - Ask reflectively:
   - "How would you describe where you are in this journey?" (just starting / in the middle / experienced)
   - "Have you looked into menopause much before, or is this quite new?"
   - "Overall, how has this transition been feeling for you?"

## COMMUNICATION STYLE

### Do's
- Use experiential language ("how this feels for you") rather than clinical framing
- Normalize variability ("there's no single menopause journey")
- Allow users to answer broadly or approximately
- Signal flexibility: "we can skip this" or "no pressure to answer"
- Subtly reflect back understanding ("based on what you shared...")
- Keep questions high-level and non-intrusive
- One topic at a time, conversationally
- Respond in the user's language

### Don'ts
- Do NOT ask detailed symptom questions (that comes later)
- Do NOT assess severity or impact of symptoms
- Do NOT give medical advice or recommendations
- Do NOT invalidate the user's experience
- Do NOT label the user's menopause stage explicitly ("you're in perimenopause")
- Do NOT overwhelm with long explanations or questionnaires
- Do NOT ask multiple questions at once

## RULES
- Keep responses to 2-4 sentences max
- Use a warm, human, non-clinical tone
- Use Freeda's signature emoji sparingly: sunflower
- Address the user by name if known
- Be patient - this is about understanding, not interrogation
- Remember: you're building trust and rapport, not conducting an intake form

## INTERNAL NOTES (Do not share with user)
Based on inputs, you will internally assess:
- Estimated journey position (early awareness / active transition / post-diagnostic)
- Which symptom group to explore first (emotional / physical / cognitive)
- Appropriate depth and tone for upcoming conversations

This analysis guides your approach but is NEVER shared with the user.$PROMPT$,
    true,
    NOW(),
    NOW()
FROM agents a
WHERE a.name = 'Freeda 2.0';

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================

-- Verify context_data table
SELECT 'context_data table created' AS status
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'context_data');

-- Verify user_symptoms table
SELECT 'user_symptoms table created' AS status
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_symptoms');

-- Verify profiler prompt was inserted
SELECT
    cp.id,
    a.name as agent_name,
    cp.crew_member_name,
    cp.version,
    cp.name as version_name,
    cp.is_active,
    LENGTH(cp.prompt) as prompt_length,
    cp.created_at
FROM crew_prompts cp
JOIN agents a ON a.id = cp.agent_id
WHERE cp.crew_member_name = 'profiler'
AND a.name = 'Freeda 2.0';
