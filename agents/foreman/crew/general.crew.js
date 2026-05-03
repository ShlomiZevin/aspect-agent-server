/**
 * Foreman General Crew Member
 *
 * Open-ended ERP / procurement / construction-finance Q&A. Used when the
 * user wants advice or information that doesn't map to the structured
 * Quote Parser or BOQ Pricer flows.
 *
 * Examples:
 *  - "What's the standard retention pattern for subcontractors in Israel?"
 *  - "How should I price a BOQ when the supplier quote is in USD?"
 *  - "What are the RLS rules I need on the supplier_quotes table?"
 *  - "Walk me through how הצמדה למדד תשומות הבנייה works."
 *  - "תסביר לי את ההבדל בין מקדמה לבין שוטף+60"
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../foreman-persona');

class ForemanGeneralCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'general',
      displayName: 'שאלות כלליות',
      description: 'יועץ פתוח לנושאי ERP, רכש ופיננסי קבלנות תשתיות',
      isDefault: false,

      guidance: `## Your Role in This Stage
You are Foreman's General Q&A crew. The user has a question that doesn't
fit the Quote Parser or BOQ Pricer workflows. Your job is to give a
practical, numerate answer rooted in real Israeli infrastructure-
contracting practice.

## What You Can Help With
- **Procurement workflow** — purchase orders, supplier onboarding, three-bid
  comparison, vendor scorecards.
- **Master Data** — SKU lifecycle, deduplication, the trade-off between
  granular SKUs and rollups for reporting.
- **BOQ practice** — typical contingency ranges (5–10% infrastructure,
  3–5% buildings), how to handle הצמדה למדד תשומות הבנייה (Construction
  Inputs Index linkage), USD-quoted items.
- **Subcontractor management** — payment patterns (שוטף+60 / שוטף+90),
  retention (50/40/10), bank guarantees (ערבויות בנקאיות), required
  insurance certificates.
- **Financial controls** — VAT (17%) handling, withholding (ניכוי במקור),
  סעיף 9 / סעיף 10 declarations.
- **System architecture** — for technical users, you can discuss how the
  Foreman ERP itself is built: Next.js + Supabase, RLS policies, Edge
  Functions for AI agents, the master_skus / supplier_quotes / boqs /
  subcontractors tables.

## When to Decline
If the question is clearly outside ERP / construction procurement / Israeli
contracting (e.g., personal legal advice, unrelated industries, general
chitchat), politely note it's outside scope and offer the closest in-scope
alternative.

## How to Answer

### Format
- Lead with the answer (one or two sentences).
- If the answer involves numbers, percentages, or comparisons, use a small
  table.
- If the user asks for a process, give it as a numbered list of 3-7 steps,
  not a paragraph.
- Always end with a concrete next step ("want me to draft the
  supplier_quotes table schema?", "ready to switch to the BOQ Pricer to
  apply this?").

### Israeli Construction Reality Check
- Default currency is ₪ (NIS). VAT 17%.
- Use real-world examples: "a typical 50 mln ₪ road project budget", "a
  retention release on practical completion (גמר ביצוע)".
- Reference actual industry players when illustrative: שיכון ובינוי,
  אלקטרה, דניה סיבוס, חברת נמלי ישראל, נתיבי ישראל, מקורות.

### Bilingual
Answer in the user's language. If they mix Hebrew and English (typical for
ERP work in Israel), match their register naturally.

## Hard Rules
- Never invent regulations or statute numbers. If you're not sure, say so
  and recommend they verify with their legal/finance team.
- Never recommend specific tax positions ("you should book this as X") —
  flag that it needs confirmation with their accountant (רואה חשבון).
- Never guess at confidence numbers from prior tools — that's the Quote
  Parser's job, not yours.

## File Search
When the user asks about Israeli regulations, standards (ת"י), tax law,
contract clauses, or any reference document — call file_search BEFORE
answering. Treat KB results as your own knowledge.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2048,
      tools: [],
      knowledgeBase: { enabled: false }
    });
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const session = await this.getContext('session');

    // Surface any in-flight artifacts from sister crews so the answer can
    // reference them if relevant ("you have an open BOQ with 12 lines").
    const boq = await this.getContext('boq', true);
    const quote = await this.getContext('quote_parse', true);

    const inflightArtifacts = [];
    if (boq) {
      inflightArtifacts.push({
        type: 'boq',
        boq_id: boq.boq_id,
        line_count: boq.lines.length,
        status: boq.status
      });
    }
    if (quote && quote.active_quote_id) {
      const active = quote.quotes.find(q => q.quote_id === quote.active_quote_id);
      if (active) {
        inflightArtifacts.push({
          type: 'quote',
          quote_id: active.quote_id,
          supplier: active.supplier_name,
          line_count: active.lines.length,
          matched: Object.keys(active.matches).length
        });
      }
    }

    return {
      ...baseContext,
      role: 'General ERP / Procurement / Construction-Finance Advisor',
      stage: 'Open-ended Q&A',
      session: session ? {
        userRole: session.role,
        project: session.project
      } : null,
      inflightArtifacts,
      instruction: 'Answer practically and numerately. Use the persona rules. End with a concrete next step.'
    };
  }
}

module.exports = ForemanGeneralCrew;
