/**
 * Ofek Development (אופק יזמות) Crew Member
 *
 * Sales & marketing intelligence for a residential developer selling
 * apartments off-plan — the real-estate demo. Queries the synthetic
 * `realestate` schema (scripts/seed-realestate-synthetic.js).
 *
 * Two tools:
 *  - fetch_realestate_data — the shared NL -> SQL pipeline, same as every BI crew.
 *  - show_building_board   — the sales-office availability board of a project,
 *    rendered deterministically from the units table (no generated SQL), so the
 *    picture is always exactly the data.
 */

const CrewMember = require('../../../crew/base/CrewMember');
const { DataQueryService } = require('../../../services/data-query.service');
const { getPool } = require('../../../services/db.realestate');

const dataQueryService = new DataQueryService(getPool());

// Names a user may use for each project: its name, city, region, English forms.
const PROJECT_ALIASES = {
  1: ['אופק פארק', 'פארק', 'ראשון לציון', 'ראשון', 'park', 'rishon'],
  2: ['אופק ים', 'ים', 'נתניה', 'שרון', 'yam', 'netanya', 'sea'],
  3: ['אופק כרמל', 'כרמל', 'חיפה', 'צפון', 'carmel', 'haifa', 'north'],
  4: ['אופק הנגב', 'נגב', 'באר שבע', 'דרום', 'negev', 'beer sheva', "be'er sheva", 'south'],
  5: ['אופק העיר', 'העיר', 'ירושלים', 'ha-ir', 'hair', 'jerusalem'],
};
// Same colours as the live board page: green sold, yellow reserved, white free, orange stuck.
const CELL = { 'נמכרה': '🟩', 'שמורה': '🟨', 'פנויה': '⬜' };

function resolveProject(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  for (const [id, aliases] of Object.entries(PROJECT_ALIASES)) {
    if (aliases.some(a => t.includes(a.toLowerCase()))) return Number(id);
  }
  return null;
}

class RealEstateCrew extends CrewMember {
  constructor() {
    super({
      name: 'realestate',
      displayName: 'אופק יזמות', // shown above every reply and in the thinking steps of a Hebrew UI
      description: 'Sales and marketing intelligence for Ofek Development — leads, buyers, apartments, campaigns, sales reps',
      isDefault: true,

      guidance: `You are the sales & marketing intelligence advisor of Ofek Development (אופק יזמות), an Israeli residential developer that sells apartments off-plan in 5 projects:
אופק פארק (ראשון לציון), אופק ים (נתניה), אופק כרמל (חיפה), אופק הנגב (באר שבע), אופק העיר (ירושלים).

You speak to the owner and the sales manager. They are not data people — they think in apartments, buyers, shekels and phone calls.

## WHAT YOU CAN ANSWER (real data, via fetch_realestate_data)
- Leads and the sales funnel: inquiries → office visit → negotiation → signed contract; conversion by project, source, segment, sales rep, period
- Buyers: age, gender, profession, family, income decile, city of residence; first home / upgraders / investors / buying for the children
- Apartments: rooms, size, floor, direction, unit type, price per sqm; sold / reserved / free; stuck units and over-pricing
- Projects: sales pace and the forecast sell-out date
- Marketing: lead sources and campaigns — spend, cost per lead, cost per deal
- Sales reps: speed of first call-back, conversion, discounts — and discounts above the company average in ₪
- Benefits by segment: which benefit (20/80 financing, no linkage to the construction-input index, free kitchen, price cut, spec upgrade, extra parking) actually closes which buyer segment
- Deal terms: payment plan, mortgage, linkage to מדד תשומות הבנייה (full / 50% / none)
- Who to call today: open leads ranked by a lead score with the reason
- "Stuck" apartments: ONLY the ones the data marks stuck (over 180 days on the market AND priced 10%+ above comparable sold units) — never count all unsold units as stuck

## HOW A DEVELOPER MOVES STOCK — shape every recommendation this way
- Developers rarely cut the list price: it re-prices every unsold unit and angers buyers who already signed. Recommend, in this order: payment terms (20/80, no index linkage until delivery), a benefit that fits the segment (spec upgrade, kitchen, parking), a targeted campaign to the leads who want that size — and a price change only as a last resort, framed as "הטבה בשווי ₪X" on specific units.
- Discount problems: recommend a discount ceiling with manager approval above it, and swapping discounts for the segment's best benefit.

## TOOLS
1. \`fetch_realestate_data\` — pass ONE clean business question (Hebrew or English). It writes and runs the SQL.
   Combine related metrics into ONE call; split only when they come from genuinely different subjects.
2. \`show_building_board\` — the live availability board of a project (every apartment, floor by floor, colored by status). Use it whenever the user asks to SEE a project / building / "לוח דירות" / what is left to sell in a project, or when a stuck-units answer would land better as a picture. ONE call returns every building of the project — call it once per project, never twice. The tool returns \`board_markdown\`: paste it into your reply EXACTLY as given (do not retype, reorder or translate it), then add your reading of it.

## HOW TO ANSWER — this is what makes you valuable
- Lead with the answer in one sentence, with the number.
- Then the 2-4 numbers that explain it.
- End with ONE concrete recommendation — what you would do tomorrow morning — and, when the data supports it, what it is worth in ₪ or in apartments. Example: "להעביר את תקציב האינסטגרם ליריד הבא — באותו כסף זה ~3 עסקאות במקום אחת."
- Every number must come from a tool result of THIS turn. Never invent a figure, a name or a date. If the data cannot answer, say so in one sentence.
- Respond in the language the user wrote in. Hebrew in the data (names, statuses, sources) says nothing about the reply language. ₪ amounts: ₪2.45M / ₪850K style in prose.

## EXAMPLES — pass a CLEAN business question (no table or column names)
User: "כמה לידים עברו לרכישה?" → fetch_realestate_data("conversion from lead to signed contract overall and by project")
User: "מאיפה מגיעים הלידים הכי טובים?" → fetch_realestate_data("lead sources ranked by conversion and cost per deal")
User: "מי הרוכשים שלנו?" → fetch_realestate_data("share of signed deals by purchase purpose, with the average age, income decile and share of first-home buyers of each purpose") — ONE small table (a row per purpose), never a cross-tab of every combination
User: "איזו הטבה לתת לאיזה סגמנט?" → fetch_realestate_data("close rate of each buyer segment by the benefit offered")
User: "למי להתקשר היום?" → fetch_realestate_data("top 15 open leads to call today with lead score and reason")
User: "תראה לי את אופק כרמל" → show_building_board({ project: "אופק כרמל" })
User: "למה ההמרה בחיפה ירדה?" → fetch_realestate_data("monthly conversion of Ofek Carmel lead cohorts with the reps handling them and their call-back speed")
User: "אילו דירות לא נמכרות?" → fetch_realestate_data("stuck unsold units with their price premium vs comparable sold units"), then offer the board of the project that stands out.

## TABLES & FULL DATA
- Ask for SMALL tables: at most 5 columns and about 12 rows. The chat opens in a panel — a wide table gets cut. Profiles and segments: aggregate (share, average) per group, not one row per combination; leave out ids and phone numbers unless the user asks for a list of people.
- The fetch result's \`summary\` already contains a FULLY FORMATTED markdown table — the COMPLETE result (20 rows or fewer) or a 20-row preview. When showing a table, paste it EXACTLY as given.
- More than 20 rows: the user automatically gets a full paginated table with Excel export below your reply — say it is there.
- ALWAYS pass a short \`table_title\` in the user's language.
- NEVER claim a table exists unless you called a tool THIS turn and got it back.`,

      model: process.env.REALESTATE_CREW_MODEL || 'gpt-5.6-terra',
      maxTokens: 8192,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,

      tools: [
        {
          name: 'fetch_realestate_data',
          description: 'Fetch real business data of Ofek Development (leads, buyers, apartments, deals, campaigns, sales reps). Pass a natural language question and get back the relevant data.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The business question to answer. Hebrew or English. Examples: "conversion by lead source", "buyer profile by purchase purpose", "stuck units in Haifa"',
              },
              table_title: {
                type: 'string',
                description: 'A SHORT title for the resulting table, in the SAME language the user used, describing what this table shows (max ~8 words). Example: "מקורות לידים לפי עלות לעסקה".',
              },
            },
            required: ['question'],
          },
          handler: async (params) => this._handleDataFetch(params),
        },
        {
          name: 'show_building_board',
          // No building parameter on purpose: given one, the model picked
          // building 1, then looped re-calling it for the others until the
          // tool-iteration cap ended the turn with an empty reply. One call
          // always returns the whole project.
          description: 'Show the live availability board of a project: ALL its buildings, every apartment floor by floor, colored sold / reserved / free / stuck — in ONE call. Returns board_markdown to paste verbatim.',
          parameters: {
            type: 'object',
            properties: {
              project: {
                type: 'string',
                description: 'The project name or its city, as the user said it, e.g. "אופק כרמל", "חיפה", "Netanya".',
              },
            },
            required: ['project'],
          },
          handler: async (params) => this._handleBuildingBoard(params),
        },
      ],

      knowledgeBase: null,
    });
  }

  async _handleDataFetch({ question, table_title }) {
    const thinkingService = require('../../../services/thinking.service');
    const tableFormatService = require('../../../services/table-format.service');

    try {
      console.log('Real estate data fetch: "' + question + '"');

      const result = await dataQueryService.queryByQuestion(question, 'realestate', {
        agentName: 'realestate',
        llmAgentName: this._agentName,
        conversationId: this._externalConversationId,
        userId: this._userId,
      });

      if (this._externalConversationId && result.sql) {
        thinkingService.addFunctionCallStep(
          this._externalConversationId,
          'fetch_realestate_data',
          { question, sql: result.sql, explanation: result.explanation },
          'Fetching data: ' + question
        );
      }

      if (result.timeout) {
        return {
          error: true,
          timeout: true,
          message: result.message,
          suggestion: 'Try a more specific question or a narrower date range.',
        };
      }

      if (result.error) {
        return {
          error: true,
          message: 'Unable to fetch data: ' + result.message,
          suggestion: 'Try rephrasing your question or asking about a different metric.',
        };
      }

      return tableFormatService.buildFetchResult({ question, tableTitle: table_title, schema: 'realestate', result });
    } catch (err) {
      console.error('Real estate data fetch failed:', err);
      return {
        error: true,
        message: err.message,
        suggestion: 'There was an error fetching the data. Please try a different question.',
      };
    }
  }

  /**
   * The sales-office board: one table per building, top floor first, four
   * apartment positions per floor. Built straight from the units table.
   */
  async _handleBuildingBoard({ project }) {
    console.log(`Real estate building board: project="${project}"`);
    try {
      const projectId = resolveProject(project);
      if (!projectId) {
        return { error: true, message: `No project matches "${project}". Projects: אופק פארק (ראשון לציון), אופק ים (נתניה), אופק כרמל (חיפה), אופק הנגב (באר שבע), אופק העיר (ירושלים).` };
      }
      const pool = getPool();
      const [{ rows: [proj] }, { rows: units }] = await Promise.all([
        pool.query('SELECT project_name, city, floors, buildings FROM realestate.projects WHERE project_id = $1', [projectId]),
        pool.query(
          // stuck = in v_stuck_units, the one definition the brief, board page and reports use.
          `SELECT u.building, u.floor, u.position, u.unit_number, u.rooms, u.unit_type, u.status, u.list_price,
                  CURRENT_DATE - u.listed_date AS days_on_market, s.unit_id IS NOT NULL AS stuck
             FROM realestate.units u LEFT JOIN realestate.v_stuck_units s USING (unit_id)
            WHERE u.project_id = $1
            ORDER BY u.building, u.floor DESC, u.position`,
          [projectId]
        ),
      ]);

      const isStuck = (u) => u.stuck;
      const cell = (u) => (u ? `${isStuck(u) ? '🟧' : CELL[u.status]} ${u.rooms}` : '·');
      const sections = [];
      const totals = { 'נמכרה': 0, 'שמורה': 0, 'פנויה': 0, stuck: 0 };
      for (const b of [...new Set(units.map(u => u.building))]) {
        const inB = units.filter(u => u.building === b);
        const lines = [`**בניין ${b}**`, '', '| קומה | 1 | 2 | 3 | 4 |', '|:-:|:-:|:-:|:-:|:-:|'];
        for (const floor of [...new Set(inB.map(u => u.floor))]) {
          const at = (pos) => inB.find(u => u.floor === floor && u.position === pos);
          const label = floor === 0 ? 'קרקע' : floor === proj.floors ? `${floor} (גג)` : String(floor);
          lines.push(`| ${label} | ${[1, 2, 3, 4].map(p => cell(at(p))).join(' | ')} |`);
        }
        for (const u of inB) { totals[u.status]++; if (isStuck(u)) totals.stuck++; }
        sections.push(lines.join('\n'));
      }
      const legend = '🟩 נמכרה · 🟨 שמורה · ⬜ פנויה · 🟧 תקועה (מעל 180 יום ומעל 10% ממחיר עסקאות דומות) — המספר בכל תא = מספר החדרים';
      const board_markdown = `### לוח דירות — ${proj.project_name}, ${proj.city}\n\n${sections.join('\n\n')}\n\n${legend}`;

      // What the board shows, as facts the talker can read out.
      const stuckUnits = units.filter(isStuck);
      const stuckByKind = {};
      for (const u of stuckUnits) {
        const k = `${u.rooms} חד׳ ${u.unit_type}`;
        stuckByKind[k] = (stuckByKind[k] || 0) + 1;
      }
      return {
        board_markdown,
        project: proj.project_name,
        city: proj.city,
        buildings_shown: [...new Set(units.map(u => u.building))],
        units_total: units.length,
        sold: totals['נמכרה'],
        reserved: totals['שמורה'],
        free: totals['פנויה'],
        stuck: totals.stuck,
        stuck_by_kind: stuckByKind,
        unsold_list_value_ils: units.filter(u => u.status !== 'נמכרה').reduce((a, u) => a + Number(u.list_price), 0),
        instruction: 'Paste board_markdown verbatim, then 2-3 sentences on what stands out (e.g. a column or unit kind that stays white/orange) and one recommendation.',
      };
    } catch (err) {
      console.error('Building board failed:', err);
      return { error: true, message: err.message };
    }
  }
}

module.exports = RealEstateCrew;
