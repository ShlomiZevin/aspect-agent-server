/**
 * Foreman Intake Crew Member
 *
 * Default entry-point crew. Identifies:
 *  - The user's role (procurement / project manager / accounting / engineer)
 *  - The active project they're working on
 *  - What they want to do this session (parse a quote / build a BOQ / general Q&A)
 *
 * Persists project + role to user-level context so downstream crews don't
 * need to re-ask. Routes via preMessageTransfer based on stated intent.
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../foreman-persona');

class ForemanIntakeCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'intake',
      displayName: 'קבלה וניתוב',
      description: 'מזהה את התפקיד והפרויקט הפעיל ומנתב לסוכן המתאים',
      isDefault: true,

      fieldsToCollect: [
        {
          name: 'user_role',
          description: "User's role on the project. One of: 'procurement' (קניין/רכש), 'project_manager' (מנהל פרויקט), 'site_engineer' (מהנדס ביצוע), 'accounting' (הנה\"ח), 'executive' (הנהלה). Map free-text descriptions to these values.",
          allowedValues: ['procurement', 'project_manager', 'site_engineer', 'accounting', 'executive']
        },
        {
          name: 'active_project',
          description: "Project code or name the user is working on right now. Examples: 'PRJ-2025-014', 'כביש 6 קטע צפון', 'גשר נחל איילון', 'תחנת כוח חגית'. Capture exactly as the user says it."
        },
        {
          name: 'session_goal',
          description: "What the user wants to do in this session. One of: 'parse_quote' (parse a supplier price quote PDF/text), 'price_boq' (build or price a BOQ line by line), 'general' (general Q&A about ERP/master data/procurement). Map any phrasing to one of these three values.",
          allowedValues: ['parse_quote', 'price_boq', 'general']
        }
      ],

      // Default — overridden in preMessageTransfer based on session_goal
      transitionTo: 'general',

      transitionRules: [
        {
          id: 'route_to_quote_parser',
          type: 'pre',
          condition: {
            description: 'user_role + active_project + session_goal=parse_quote collected',
            fields: ['user_role', 'active_project', 'session_goal'],
            evaluate: (f) => !!f.user_role && !!f.active_project && f.session_goal === 'parse_quote'
          },
          result: { action: 'transition', target: 'quote_parser' },
          priority: 10
        },
        {
          id: 'route_to_boq_pricer',
          type: 'pre',
          condition: {
            description: 'user_role + active_project + session_goal=price_boq collected',
            fields: ['user_role', 'active_project', 'session_goal'],
            evaluate: (f) => !!f.user_role && !!f.active_project && f.session_goal === 'price_boq'
          },
          result: { action: 'transition', target: 'boq_pricer' },
          priority: 20
        },
        {
          id: 'route_to_general',
          type: 'pre',
          condition: {
            description: 'user_role + active_project + session_goal=general collected',
            fields: ['user_role', 'active_project', 'session_goal'],
            evaluate: (f) => !!f.user_role && !!f.active_project && f.session_goal === 'general'
          },
          result: { action: 'transition', target: 'general' },
          priority: 30
        }
      ],

      guidance: `## Your Role in This Stage
You are the Intake & Routing crew for Foreman. Your job is to greet the user
warmly (briefly!), figure out who they are and what they want to do this
session, and hand off to the right specialist.

## What to Collect (3 things)
1. **user_role** — Which hat are they wearing today?
   procurement / project_manager / site_engineer / accounting / executive
2. **active_project** — Which project? Capture the code or name as-is.
3. **session_goal** — What do they want to do?
   - parse_quote — they have a supplier price quote (PDF / text) to process
   - price_boq — they want to build or price a Bill of Quantities
   - general — anything else: master-data questions, ERP help, advice

## How to Collect
- Open with a short greeting that names the three things you can help with.
  Example (HE): "שלום! אני Foreman. אני יכול לעזור עם שלושה דברים: לפענח
  הצעת מחיר של ספק, לתמחר כתב כמויות, או לענות על שאלות כלליות על המערכת.
  במה נתחיל היום?"
- Then collect role + project naturally — DON'T interrogate. If the user
  jumps straight to a goal ("I have a PDF from גילי גרניט"), capture
  session_goal=parse_quote and ask the missing fields.
- If the user is clearly a returning user with an existing project context
  in the message, accept it and move on — don't ask redundantly.

## Routing Rules
Once you have all three fields, the system will route automatically:
- session_goal=parse_quote → Quote Parser crew
- session_goal=price_boq → BOQ Pricer crew
- session_goal=general → General crew

You do NOT announce the transition. Just deliver a brief acknowledgment
("מעולה, נתחיל") and the next crew takes over.

## Rules
- Keep responses to 2-3 sentences MAX. This is intake, not conversation.
- Always reply in the user's language.
- Never make up project codes or roles — if unclear, ask.
- If the user says "I don't know" about role, default to 'project_manager'.
- If the user has no specific project, accept "ללא פרויקט" / "no project"
  and use that as the active_project value.
`,

      model: 'gpt-5-chat-latest',
      maxTokens: 512,
      tools: [],
      knowledgeBase: { enabled: false }
    });
  }

  async preMessageTransfer(collectedFields) {
    const hasRole = !!collectedFields.user_role;
    const hasProject = !!collectedFields.active_project;
    const goal = collectedFields.session_goal;

    if (!hasRole || !hasProject || !goal) {
      return false;
    }

    // Persist session context for downstream crews
    await this.writeContext('session', {
      role: collectedFields.user_role,
      project: collectedFields.active_project,
      goal,
      startedAt: new Date().toISOString()
    });

    // Route based on stated goal
    switch (goal) {
      case 'parse_quote':
        this.transitionTo = 'quote_parser';
        return true;
      case 'price_boq':
        this.transitionTo = 'boq_pricer';
        return true;
      case 'general':
        this.transitionTo = 'general';
        return true;
      default:
        return false;
    }
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    // If returning user, surface their last session for warmer welcome
    const lastSession = await this.getContext('session');

    const allFields = ['user_role', 'active_project', 'session_goal'];
    const missing = allFields.filter(f => !collectedFields[f]);
    const collected = allFields.filter(f => !!collectedFields[f]);

    return {
      ...baseContext,
      role: 'Intake & Routing',
      stage: 'Session start',
      lastSession: lastSession ? {
        role: lastSession.role,
        project: lastSession.project,
        previousGoal: lastSession.goal
      } : null,
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length === 0
        ? 'All fields collected — system will transition. Give a brief acknowledgment only.'
        : `Still need: ${missing.join(', ')}. Be brief and conversational. Skip questions whose answer is already obvious from the user message.`,
      note: 'Field state lags one turn — always check the current user message for new values before re-asking.'
    };
  }
}

module.exports = ForemanIntakeCrew;
