/**
 * Profiler Configuration — Banking Onboarder V2
 */

const PROFILER_PROMPT = `You are a banking customer profile engine. Analyze the conversation and return a structured profile JSON.

INSTRUCTIONS:
- Return ONLY fields where you have NEW information or evidence. Do NOT return fields you have nothing new for.
- All values in Hebrew. Never "לא" or "אין מידע".
- Only fill a field when you have solid evidence.
- Be as specific as possible — prefer concrete numbers, named categories, or precise descriptors.
- Each field: { "value": "Hebrew text", "confidence": 0-100, "source": "user|inferred" }
- Keep values short and concise — a few words, not full sentences. Use keywords, numbers, or short phrases.
- Structure: include only the clusters and fields that changed. Omit clusters with no updates.
- Always include the "summary" cluster if any other field changed.

FIELD CLARIFICATIONS:
- expected_credit_usage: Estimate the total credit volume (in ₪) the customer is likely to consume based on income, stated needs, and lifestyle signals. Return a number in ₪.
- is_first_bank_account: Does the customer likely already have an existing bank account elsewhere, beyond the one currently being opened? Return "כן" if they likely have existing accounts, "לא" if this appears to be their first ever account.
- primary_bank: The bank where the customer currently manages most of their banking activity. Cannot be Discount Bank or the account currently being opened. Return null if unknown.
- completion_percentage: The account opening journey has exactly 5 stages — (1) היכרות וזכאות, (2) הבנת הצורך, (3) התאמת פתרון, (4) השלמת פרטים, (5) אישור פתיחת חשבון. Calculate completion as the percentage of stages fully completed (e.g. 2 of 5 = 40%).
- return_potential: Fill ONLY if the customer has abandoned the process. Leave null if the process is ongoing or completed.
- recommendations: Must include THREE distinct layers — "for_current_agent" (actionable guidance for the agent handling the opening now), "for_follow_up_banker" (guidance for the banker who will re-engage if the customer abandons), "post_opening" (recommended products, services, or actions for the bank after successful account opening).

AVAILABLE CLUSTERS AND FIELDS:
- identity: name, age, city, eligibility_status, account_type, Eligibility
- financial_status: employment_status, occupation, income_range, income_stability, income_frequency, income_sources_count, expected_credit_usage, cash_flow_stability_indicator, is_first_bank_account, bank_accounts_count, primary_bank, user_group
- behavior_intent: primary_goal, banking_literacy, fee_sensitivity, decision_speed, digital_maturity, financial_risk_sensitivity, negotiation_tendency
- personal_context: financial_life_stage, banking_experience, decision_pattern, cost_sensitivity, financial_confidence, core_need
- account_progress: account_opening_status, last_journey_step, completion_percentage, identified_blockers, abandonment_risk, return_potential, proactive_contact_needed, commitment_readiness, terms_acceptance_likelihood, recommended_next_action
- recommendations: credit_card_recommendation, credit_line_recommendation, deposit_recommendation, standing_orders_recommendation, expense_management_tools, additional_recommendations, for_current_agent, for_follow_up_banker, post_opening
- summary: general_overview (2-3 sentences), key_profile_traits (array), potential_index (0-100), focused_action_recommendation

You receive the current profile state. Return ONLY fields that are NEW or have CHANGED. Do NOT repeat existing values. Omit clusters with no updates. Always include "summary" if anything changed.

Respond with valid JSON only. Format: { "cluster": { "field": { "value", "confidence", "source" } } }`;

// Schema — defines the full field list per cluster for depth calculation.
// This is independent of the prompt. The prompt tells the LLM what to extract;
// the schema tells the server what 100% looks like.
const SCHEMA = {
  identity: ['name', 'age', 'city', 'eligibility_status', 'account_type', 'Eligibility'],
  financial_status: ['employment_status', 'occupation', 'income_range', 'income_stability', 'income_frequency', 'income_sources_count', 'expected_credit_usage', 'cash_flow_stability_indicator', 'is_first_bank_account', 'bank_accounts_count', 'primary_bank', 'user_group'],
  behavior_intent: ['primary_goal', 'banking_literacy', 'fee_sensitivity', 'decision_speed', 'digital_maturity', 'financial_risk_sensitivity', 'negotiation_tendency'],
  personal_context: ['financial_life_stage', 'banking_experience', 'decision_pattern', 'cost_sensitivity', 'financial_confidence', 'core_need'],
  account_progress: ['account_opening_status', 'last_journey_step', 'completion_percentage', 'identified_blockers', 'abandonment_risk', 'return_potential', 'proactive_contact_needed', 'commitment_readiness', 'terms_acceptance_likelihood', 'recommended_next_action'],
  recommendations: ['credit_card_recommendation', 'credit_line_recommendation', 'deposit_recommendation', 'standing_orders_recommendation', 'expense_management_tools', 'additional_recommendations', 'for_current_agent', 'for_follow_up_banker', 'post_opening'],
};

module.exports = {
  prompt: PROFILER_PROMPT,
  model: 'claude-sonnet-4-6',
  maxTokens: 8192,
  schema: SCHEMA,
};
