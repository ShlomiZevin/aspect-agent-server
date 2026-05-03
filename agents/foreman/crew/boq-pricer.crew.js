/**
 * Foreman BOQ Pricer Crew Member
 *
 * Builds & costs a Bill of Quantities (כתב כמויות) line by line.
 *
 * Tools:
 *   - lookup_master_sku   Find a master SKU by description / category
 *   - add_boq_line        Append a line to the active BOQ
 *   - update_boq_line     Edit qty / price on an existing line
 *   - remove_boq_line     Delete a line
 *   - compute_boq_total   Recompute totals incl. VAT, contingency, discount
 *   - commit_boq          Mark the BOQ as ready for client/PM approval
 *
 * State (conversation-level): { boq_id, project, lines: [...], discount_pct, contingency_pct, status }
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../foreman-persona');

// Same mock master catalog as quote-parser, kept in sync via shallow snapshot.
// In production both crews would query the shared Supabase 'master_skus' table.
const MASTER_CATALOG = [
  { master_sku: 'CON-B30-RM',  description: 'בטון מובא ב-30 רגיל',                category: 'concrete',   unit: 'מ"ק', master_price_nis: 460 },
  { master_sku: 'CON-B40-RM',  description: 'בטון מובא ב-40 רגיל',                category: 'concrete',   unit: 'מ"ק', master_price_nis: 540 },
  { master_sku: 'CON-B50-SCC', description: 'בטון מובא ב-50 SCC (יציקה עצמית)',   category: 'concrete',   unit: 'מ"ק', master_price_nis: 680 },
  { master_sku: 'CEM-CEM2-50', description: 'מלט CEM II שק 50 ק"ג',               category: 'concrete',   unit: 'שק',  master_price_nis: 32 },
  { master_sku: 'STL-REB-12',  description: 'ברזל זיון מצולע קוטר 12 מ"מ',        category: 'steel',      unit: 'טון', master_price_nis: 3850 },
  { master_sku: 'STL-REB-16',  description: 'ברזל זיון מצולע קוטר 16 מ"מ',        category: 'steel',      unit: 'טון', master_price_nis: 3780 },
  { master_sku: 'STL-REB-20',  description: 'ברזל זיון מצולע קוטר 20 מ"מ',        category: 'steel',      unit: 'טון', master_price_nis: 3720 },
  { master_sku: 'STL-MESH-Q188', description: 'רשת מרותכת Q188',                  category: 'steel',      unit: 'מ"ר', master_price_nis: 28 },
  { master_sku: 'FRM-PLY-18',  description: 'לוח טריפלקס יציקה 18 מ"מ',           category: 'formwork',   unit: 'מ"ר', master_price_nis: 78 },
  { master_sku: 'FRM-BEAM-H20',description: 'קורת H20 לתבנית יציקה',              category: 'formwork',   unit: 'מטר', master_price_nis: 42 },
  { master_sku: 'AGG-SAND-WS', description: 'חול מנופה לבנייה',                    category: 'aggregate',  unit: 'טון', master_price_nis: 95 },
  { master_sku: 'AGG-GRAVEL-2',description: 'חצץ דרגה 2 (#2) — דרכים ותשתיות',     category: 'aggregate',  unit: 'טון', master_price_nis: 110 },
  { master_sku: 'ELC-CAB-NYY-3X25', description: 'כבל NYY 3x25 ממ"ר',             category: 'electrical', unit: 'מטר', master_price_nis: 38 },
  { master_sku: 'ELC-CAB-NYY-5X16', description: 'כבל NYY 5x16 ממ"ר',             category: 'electrical', unit: 'מטר', master_price_nis: 52 },
  { master_sku: 'ELC-PIPE-PVC-50', description: 'צינור PVC חשמל 50 מ"מ',          category: 'electrical', unit: 'מטר', master_price_nis: 9.5 },
  { master_sku: 'ELC-PNL-3F-100A', description: 'לוח חשמל תלת-פאזי 100A',         category: 'electrical', unit: 'יח׳', master_price_nis: 1850 },
  { master_sku: 'PLB-PIPE-PE100-110', description: 'צינור פוליאתילן PE100 קוטר 110', category: 'plumbing', unit: 'מטר', master_price_nis: 45 },
  { master_sku: 'PLB-VLV-BFLY-100',   description: 'מגוף פרפר קוטר 4" עם הילוך',     category: 'plumbing', unit: 'יח׳', master_price_nis: 480 },
  { master_sku: 'PLB-ELB-PE-110-90',  description: 'מעבר 90° פוליאתילן 110',         category: 'plumbing', unit: 'יח׳', master_price_nis: 68 },
  { master_sku: 'EW-FILL-A',    description: 'מילוי מהודק סוג A',                  category: 'earthworks', unit: 'מ"ק', master_price_nis: 65 },
  { master_sku: 'ASP-AC-SMA',   description: 'אספלט SMA שכבה עליונה',              category: 'asphalt',    unit: 'טון', master_price_nis: 520 },
  { master_sku: 'ASP-AC-BC',    description: 'אספלט שכבת מצע BC',                  category: 'asphalt',    unit: 'טון', master_price_nis: 410 },
  { master_sku: 'INS-BIT-4MM',  description: 'יריעת ביטומן 4 מ"מ',                 category: 'insulation', unit: 'מ"ר', master_price_nis: 36 },
  { master_sku: 'INS-XPS-50',   description: 'לוח XPS בידוד 50 מ"מ',                category: 'insulation', unit: 'מ"ר', master_price_nis: 48 },
  { master_sku: 'HW-ANCH-HILTI-M12', description: 'עוגן Hilti HSL3 M12',           category: 'hardware',   unit: 'יח׳', master_price_nis: 24 },
  { master_sku: 'HW-RBAR-WIRE-1MM',  description: 'תיל קשירה לזיון 1 מ"מ',         category: 'hardware',   unit: 'ק"ג', master_price_nis: 14 },
  { master_sku: 'SAF-FENCE-2M',  description: 'גדר אתר 2 מ\' מודולרית',             category: 'safety',     unit: 'מטר', master_price_nis: 95 }
];

const VAT_RATE = 0.17;

function _round2(n) {
  return Math.round(n * 100) / 100;
}

class ForemanBoqPricerCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'boq_pricer',
      displayName: 'תמחור כתב כמויות',
      description: 'בונה ומתמחר כתב כמויות שורה-שורה, עם חיפוש במאסטר וחישוב מע"מ',
      isDefault: false,

      guidance: `## Your Role in This Stage
You are the BOQ Pricer. The user is building a Bill of Quantities (כתב
כמויות) for the active project. You help them add, edit, and total lines —
always referencing the master SKU catalog so descriptions and prices stay
canonical.

## How a BOQ Line Works
Every line has:
  * **master_sku** — canonical code from the catalog (REQUIRED for committed lines)
  * **description** — copied from master, can be customized
  * **qty** — quantity in the unit
  * **unit** — measurement unit (מ"ק, מ"ר, מטר, טון, יח', שק, ק"ג)
  * **unit_price_nis** — price per unit in NIS, BEFORE VAT
  * **line_total_nis** — qty × unit_price (auto-computed)

## Workflow

### Adding a line
1. User says "add 120 cubic meters of B30 concrete" or "תוסיף 50 מטר כבל NYY 5x16".
2. Call \`lookup_master_sku\` with the description to find the master entry.
3. Show the master price as a baseline — but the user may quote a different
   price (e.g., from a confirmed supplier quote). Use the user's price if
   they specified one, otherwise default to master_price_nis.
4. Confirm the line with the user, THEN call \`add_boq_line\`.

### Editing
\`update_boq_line\` for qty/price changes. \`remove_boq_line\` to delete.
Always re-show the affected total after editing.

### Totals
Call \`compute_boq_total\` whenever the user asks "what's the total" or
after a meaningful number of changes. The result includes:
  - subtotal (sum of line totals, before VAT)
  - discount (if discount_pct set)
  - contingency (if contingency_pct set — typical 5-10% for infrastructure)
  - VAT (17%)
  - grand_total

### Committing
\`commit_boq\` marks the BOQ as ready for review. Only call when the user
explicitly says they're done.

## Hard Rules
- ALL prices in the BOQ are stored BEFORE VAT (לפני מע"מ). When the user
  quotes a price, ASK whether it includes VAT — if yes, divide by 1.17 and
  round to 2 decimals before storing.
- Never silently change a quantity or price on an existing line. Always
  echo the change back ("OK, line 3: changed qty from 50 to 75") before
  committing it.
- Show ₪ amounts with thousand separators: ₪ 1,247,580.50.
- Use a markdown table whenever you list 2+ lines.
- Always offer the next concrete step ("ready to compute total", "add
  another line", "review and commit").

## Tone
Crisp, numerate. The user wants the number, not a paragraph.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2048,

      tools: [],
      knowledgeBase: { enabled: false }
    });

    this.tools = [
      {
        name: 'lookup_master_sku',
        description: `Find master SKUs in the catalog by description or category.
Returns up to 6 matches with their canonical description, unit, and reference price.

Call this when the user mentions a material/product:
  - "add B30 concrete" → lookup_master_sku("B30 concrete")
  - "ברזל 16" → lookup_master_sku("ברזל 16")
  - "show me all electrical cables" → lookup_master_sku("cable", category="electrical")

Always call this BEFORE add_boq_line so the line is anchored to a real master SKU.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Description / keyword to search for.' },
            category: {
              type: 'string',
              description: "Optional category filter. One of: concrete, steel, formwork, aggregate, electrical, plumbing, earthworks, asphalt, insulation, hardware, safety."
            }
          },
          required: ['query']
        },
        handler: async (params) => {
          const { query, category = null } = params;
          const q = String(query || '').toLowerCase().replace(/[״"׳']/g, '');
          const tokens = q.split(/\s+/).filter(t => t.length >= 2);

          const scored = MASTER_CATALOG
            .filter(item => !category || item.category === category)
            .map(item => {
              const haystack = `${item.description} ${item.master_sku} ${item.category}`.toLowerCase().replace(/[״"׳']/g, '');
              let score = 0;
              for (const tok of tokens) {
                if (haystack.includes(tok)) score += Math.min(tok.length / 3, 4);
              }
              return { item, score };
            })
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 6);

          return {
            query,
            category,
            matches: scored.map(s => ({
              master_sku: s.item.master_sku,
              description: s.item.description,
              category: s.item.category,
              unit: s.item.unit,
              master_price_nis: s.item.master_price_nis
            })),
            match_count: scored.length,
            note: scored.length === 0
              ? 'No matches. Suggest the user try a different description or browse by category.'
              : 'Show top 1-3 matches to the user. Confirm one before calling add_boq_line.'
          };
        }
      },

      {
        name: 'add_boq_line',
        description: `Append a new line to the active BOQ. Call AFTER the user has confirmed
the master SKU, qty, and price.

Stored prices are always BEFORE VAT.`,
        parameters: {
          type: 'object',
          properties: {
            master_sku: { type: 'string', description: 'Master SKU code (e.g., "STL-REB-16").' },
            description: { type: 'string', description: 'Line description (defaults to master description if omitted).' },
            qty: { type: 'number', description: 'Quantity.' },
            unit: { type: 'string', description: 'Unit (מ"ק / מ"ר / מטר / טון / יח׳ / שק / ק"ג).' },
            unit_price_nis: { type: 'number', description: 'Price per unit in NIS, BEFORE VAT.' }
          },
          required: ['master_sku', 'qty', 'unit', 'unit_price_nis']
        },
        handler: async (params) => {
          const session = await this.getContext('session');
          const state = (await this.getContext('boq', true)) || {
            boq_id: `BOQ-${Date.now()}`,
            project: session?.project || 'unspecified',
            lines: [],
            discount_pct: 0,
            contingency_pct: 0,
            status: 'draft',
            created_at: new Date().toISOString()
          };

          const masterEntry = MASTER_CATALOG.find(m => m.master_sku === params.master_sku);
          const description = params.description || masterEntry?.description || params.master_sku;

          const line = {
            line_no: state.lines.length + 1,
            master_sku: params.master_sku,
            description,
            qty: params.qty,
            unit: params.unit,
            unit_price_nis: _round2(params.unit_price_nis),
            line_total_nis: _round2(params.qty * params.unit_price_nis),
            added_at: new Date().toISOString()
          };

          state.lines.push(line);
          await this.writeContext('boq', state, true);

          return {
            recorded: true,
            line,
            boq_summary: {
              boq_id: state.boq_id,
              total_lines: state.lines.length,
              subtotal_nis: _round2(state.lines.reduce((s, l) => s + l.line_total_nis, 0))
            },
            next_step: 'Confirm the line with the user. Offer: add another line, edit a line, or compute total.'
          };
        }
      },

      {
        name: 'update_boq_line',
        description: `Edit qty and/or unit_price_nis on an existing BOQ line.
Provide line_no plus whichever fields are changing. Returns the updated line.`,
        parameters: {
          type: 'object',
          properties: {
            line_no: { type: 'number' },
            qty: { type: 'number' },
            unit_price_nis: { type: 'number' }
          },
          required: ['line_no']
        },
        handler: async (params) => {
          const state = await this.getContext('boq', true);
          if (!state) return { error: 'No active BOQ. Add a line first.' };

          const line = state.lines.find(l => l.line_no === params.line_no);
          if (!line) return { error: `Line ${params.line_no} not found.` };

          const before = { qty: line.qty, unit_price_nis: line.unit_price_nis, line_total_nis: line.line_total_nis };
          if (params.qty !== undefined) line.qty = params.qty;
          if (params.unit_price_nis !== undefined) line.unit_price_nis = _round2(params.unit_price_nis);
          line.line_total_nis = _round2(line.qty * line.unit_price_nis);

          await this.writeContext('boq', state, true);

          return {
            recorded: true,
            line_no: params.line_no,
            before,
            after: { qty: line.qty, unit_price_nis: line.unit_price_nis, line_total_nis: line.line_total_nis },
            next_step: 'Echo the change to the user before continuing.'
          };
        }
      },

      {
        name: 'remove_boq_line',
        description: `Delete a BOQ line. Lines after it are renumbered.`,
        parameters: {
          type: 'object',
          properties: { line_no: { type: 'number' } },
          required: ['line_no']
        },
        handler: async (params) => {
          const state = await this.getContext('boq', true);
          if (!state) return { error: 'No active BOQ.' };

          const idx = state.lines.findIndex(l => l.line_no === params.line_no);
          if (idx === -1) return { error: `Line ${params.line_no} not found.` };

          const removed = state.lines.splice(idx, 1)[0];
          // Renumber
          state.lines.forEach((l, i) => { l.line_no = i + 1; });
          await this.writeContext('boq', state, true);

          return {
            recorded: true,
            removed_line: removed,
            remaining_lines: state.lines.length
          };
        }
      },

      {
        name: 'compute_boq_total',
        description: `Recompute the BOQ totals: subtotal, discount, contingency, VAT, grand total.
Pass discount_pct and/or contingency_pct to apply them (they're saved on the BOQ).
Pass nothing to use the current saved values.

VAT is always 17%. Returned amounts are in NIS, rounded to 2 decimals.`,
        parameters: {
          type: 'object',
          properties: {
            discount_pct: { type: 'number', description: 'Discount % (0-100). Optional.' },
            contingency_pct: { type: 'number', description: 'Contingency % (0-30 typical). Optional.' }
          }
        },
        handler: async (params) => {
          const state = await this.getContext('boq', true);
          if (!state) return { error: 'No active BOQ. Add at least one line first.' };

          if (params.discount_pct !== undefined) state.discount_pct = params.discount_pct;
          if (params.contingency_pct !== undefined) state.contingency_pct = params.contingency_pct;

          const subtotal = state.lines.reduce((s, l) => s + l.line_total_nis, 0);
          const discount = subtotal * (state.discount_pct / 100);
          const afterDiscount = subtotal - discount;
          const contingency = afterDiscount * (state.contingency_pct / 100);
          const beforeVat = afterDiscount + contingency;
          const vat = beforeVat * VAT_RATE;
          const grandTotal = beforeVat + vat;

          await this.writeContext('boq', state, true);

          return {
            boq_id: state.boq_id,
            project: state.project,
            line_count: state.lines.length,
            subtotal_nis: _round2(subtotal),
            discount_pct: state.discount_pct,
            discount_nis: _round2(discount),
            after_discount_nis: _round2(afterDiscount),
            contingency_pct: state.contingency_pct,
            contingency_nis: _round2(contingency),
            before_vat_nis: _round2(beforeVat),
            vat_rate: VAT_RATE,
            vat_nis: _round2(vat),
            grand_total_nis: _round2(grandTotal),
            display_format: 'Show the user a clean summary block, NIS with thousand separators.'
          };
        }
      },

      {
        name: 'commit_boq',
        description: `Mark the active BOQ as ready for client/PM approval. Only call when
the user explicitly confirms they're done. The BOQ is sealed (lines can no
longer be edited from this crew); a notification is logged for the project
manager.`,
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'Optional commit note from the user.' }
          }
        },
        handler: async (params) => {
          const state = await this.getContext('boq', true);
          if (!state) return { error: 'No active BOQ to commit.' };
          if (state.lines.length === 0) return { error: 'BOQ has no lines.' };

          state.status = 'committed';
          state.committed_at = new Date().toISOString();
          state.commit_note = params.note || null;
          await this.writeContext('boq', state, true);

          // Also write a user-level summary (visible across conversations)
          await this.writeContext(`boq_${state.boq_id}_summary`, {
            boq_id: state.boq_id,
            project: state.project,
            line_count: state.lines.length,
            committed_at: state.committed_at
          });

          return {
            committed: true,
            boq_id: state.boq_id,
            line_count: state.lines.length,
            project: state.project,
            committed_at: state.committed_at,
            next_step: 'Confirm to the user and offer to start a new BOQ or switch crews.'
          };
        }
      }
    ];
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const session = await this.getContext('session');
    const state = await this.getContext('boq', true);

    let summary = null;
    if (state) {
      const subtotal = state.lines.reduce((s, l) => s + l.line_total_nis, 0);
      summary = {
        boq_id: state.boq_id,
        project: state.project,
        status: state.status,
        line_count: state.lines.length,
        subtotal_nis: _round2(subtotal),
        discount_pct: state.discount_pct,
        contingency_pct: state.contingency_pct
      };
    }

    return {
      ...baseContext,
      role: 'BOQ Pricer',
      stage: 'Bill of Quantities pricing',
      session: session ? { userRole: session.role, project: session.project } : null,
      activeBOQ: summary,
      lines: state?.lines || [],
      vat_rate: VAT_RATE,
      catalog_categories: ['concrete', 'steel', 'formwork', 'aggregate', 'electrical', 'plumbing', 'earthworks', 'asphalt', 'insulation', 'hardware', 'safety'],
      instruction: !state
        ? 'No BOQ yet. When the user adds the first line, lookup_master_sku → confirm → add_boq_line.'
        : state.status === 'committed'
        ? 'Active BOQ is committed. Tell the user it cannot be edited; offer to start a new BOQ.'
        : `Active BOQ ${state.boq_id} has ${state.lines.length} line(s). Continue editing or compute totals.`
    };
  }
}

module.exports = ForemanBoqPricerCrew;
