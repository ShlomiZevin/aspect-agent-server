/**
 * Foreman Quote Parser Crew Member
 *
 * The signature feature of Foreman: parse a supplier price quote (pasted
 * text or extracted PDF) into structured line items, then auto-match each
 * supplier SKU (מק"ט ספק) to the company's Master SKU (מק"ט מאסטר) catalog.
 *
 * This mirrors exactly the use case in the job spec:
 *   "פענוח הצעות מחיר מ-PDF, התאמת מק"טים של ספקים למק"ט מאסטר אוטומטית"
 *
 * Tools:
 *   - parse_quote_text       Pull line items out of pasted/OCR'd quote text
 *   - match_master_sku       Fuzzy-match a supplier SKU + description against master
 *   - confirm_match          User-confirms a high-confidence match (commits)
 *   - flag_for_review        Sends a low-confidence row to the human review queue
 *   - export_matched_lines   Bundle confirmed matches for downstream BOQ pricing
 *
 * State (conversation-level): { lines: [...], matched: [...], flagged: [...] }
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../foreman-persona');

// ---------------------------------------------------------------------------
// Mock Master Catalog (stand-in for the real Supabase 'master_skus' table).
// In production this would be a Supabase query with pgvector for semantic
// similarity. For the mockup we keep ~30 representative items spanning
// concrete, rebar, formwork, electrical, plumbing — enough to demonstrate
// realistic matching behavior across categories.
// ---------------------------------------------------------------------------
const MASTER_CATALOG = [
  // Concrete & cement (בטון ומלט)
  { master_sku: 'CON-B30-RM',  description: 'בטון מובא ב-30 רגיל',                         category: 'concrete',   unit: 'מ"ק',  master_price_nis: 460,    keywords: ['בטון','b30','b-30','מובא'] },
  { master_sku: 'CON-B40-RM',  description: 'בטון מובא ב-40 רגיל',                         category: 'concrete',   unit: 'מ"ק',  master_price_nis: 540,    keywords: ['בטון','b40','b-40','מובא'] },
  { master_sku: 'CON-B50-SCC', description: 'בטון מובא ב-50 SCC (יציקה עצמית)',             category: 'concrete',   unit: 'מ"ק',  master_price_nis: 680,    keywords: ['בטון','scc','יציקה עצמית','b50'] },
  { master_sku: 'CEM-CEM2-50', description: 'מלט CEM II שק 50 ק"ג',                         category: 'concrete',   unit: 'שק',   master_price_nis: 32,     keywords: ['מלט','שק','cem','cem2','50 ק"ג'] },

  // Rebar / steel (ברזל זיון)
  { master_sku: 'STL-REB-12',  description: 'ברזל זיון מצולע קוטר 12 מ"מ',                  category: 'steel',      unit: 'טון', master_price_nis: 3850,   keywords: ['ברזל','זיון','12','מצולע','rebar'] },
  { master_sku: 'STL-REB-16',  description: 'ברזל זיון מצולע קוטר 16 מ"מ',                  category: 'steel',      unit: 'טון', master_price_nis: 3780,   keywords: ['ברזל','זיון','16','מצולע','rebar'] },
  { master_sku: 'STL-REB-20',  description: 'ברזל זיון מצולע קוטר 20 מ"מ',                  category: 'steel',      unit: 'טון', master_price_nis: 3720,   keywords: ['ברזל','זיון','20','מצולע','rebar'] },
  { master_sku: 'STL-MESH-Q188', description: 'רשת מרותכת Q188',                            category: 'steel',      unit: 'מ"ר',  master_price_nis: 28,     keywords: ['רשת','מרותכת','q188','mesh'] },

  // Formwork (תבניות יציקה)
  { master_sku: 'FRM-PLY-18',  description: 'לוח טריפלקס יציקה 18 מ"מ',                     category: 'formwork',   unit: 'מ"ר',  master_price_nis: 78,     keywords: ['טריפלקס','לוח','יציקה','18','plywood'] },
  { master_sku: 'FRM-BEAM-H20',description: 'קורת H20 לתבנית יציקה',                        category: 'formwork',   unit: 'מטר', master_price_nis: 42,     keywords: ['h20','קורת','תבנית','beam'] },

  // Aggregates (אגרגטים)
  { master_sku: 'AGG-SAND-WS', description: 'חול מנופה לבנייה',                              category: 'aggregate',  unit: 'טון', master_price_nis: 95,     keywords: ['חול','מנופה','sand'] },
  { master_sku: 'AGG-GRAVEL-2',description: 'חצץ דרגה 2 (#2) — דרכים ותשתיות',               category: 'aggregate',  unit: 'טון', master_price_nis: 110,    keywords: ['חצץ','דרגה','2','gravel','#2'] },

  // Electrical (חשמל)
  { master_sku: 'ELC-CAB-NYY-3X25', description: 'כבל NYY 3x25 ממ"ר',                       category: 'electrical', unit: 'מטר', master_price_nis: 38,     keywords: ['nyy','3x25','כבל','חשמל'] },
  { master_sku: 'ELC-CAB-NYY-5X16', description: 'כבל NYY 5x16 ממ"ר',                       category: 'electrical', unit: 'מטר', master_price_nis: 52,     keywords: ['nyy','5x16','כבל','חשמל'] },
  { master_sku: 'ELC-PIPE-PVC-50', description: 'צינור PVC חשמל 50 מ"מ',                    category: 'electrical', unit: 'מטר', master_price_nis: 9.5,    keywords: ['pvc','צינור','חשמל','50','שרשורי'] },
  { master_sku: 'ELC-PNL-3F-100A', description: 'לוח חשמל תלת-פאזי 100A',                   category: 'electrical', unit: 'יח׳', master_price_nis: 1850,   keywords: ['לוח','חשמל','תלת','100a','3f'] },

  // Plumbing (אינסטלציה)
  { master_sku: 'PLB-PIPE-PE100-110', description: 'צינור פוליאתילן PE100 קוטר 110',         category: 'plumbing',   unit: 'מטר', master_price_nis: 45,     keywords: ['pe100','פוליאתילן','110','צינור'] },
  { master_sku: 'PLB-VLV-BFLY-100', description: 'מגוף פרפר קוטר 4" עם הילוך',                category: 'plumbing',   unit: 'יח׳', master_price_nis: 480,    keywords: ['מגוף','פרפר','4','butterfly','100'] },
  { master_sku: 'PLB-ELB-PE-110-90', description: 'מעבר 90° פוליאתילן 110',                  category: 'plumbing',   unit: 'יח׳', master_price_nis: 68,     keywords: ['מעבר','90','פוליאתילן','110','elbow'] },

  // Earthworks / asphalt (עפר ואספלט)
  { master_sku: 'EW-FILL-A',    description: 'מילוי מהודק סוג A',                            category: 'earthworks', unit: 'מ"ק',  master_price_nis: 65,     keywords: ['מילוי','מהודק','a','fill'] },
  { master_sku: 'ASP-AC-SMA',   description: 'אספלט SMA שכבה עליונה',                        category: 'asphalt',    unit: 'טון', master_price_nis: 520,    keywords: ['אספלט','sma','עליונה','asphalt'] },
  { master_sku: 'ASP-AC-BC',    description: 'אספלט שכבת מצע BC',                            category: 'asphalt',    unit: 'טון', master_price_nis: 410,    keywords: ['אספלט','bc','מצע','base course'] },

  // Insulation & finishes (איטום וגמר)
  { master_sku: 'INS-BIT-4MM',  description: 'יריעת ביטומן 4 מ"מ',                           category: 'insulation', unit: 'מ"ר',  master_price_nis: 36,     keywords: ['ביטומן','יריעה','4','איטום'] },
  { master_sku: 'INS-XPS-50',   description: 'לוח XPS בידוד 50 מ"מ',                          category: 'insulation', unit: 'מ"ר',  master_price_nis: 48,     keywords: ['xps','בידוד','50','קלקר'] },

  // Hardware (חומרי עזר)
  { master_sku: 'HW-ANCH-HILTI-M12', description: 'עוגן Hilti HSL3 M12',                       category: 'hardware',   unit: 'יח׳', master_price_nis: 24,     keywords: ['hilti','hsl','m12','עוגן','anchor'] },
  { master_sku: 'HW-RBAR-WIRE-1MM',  description: 'תיל קשירה לזיון 1 מ"מ',                    category: 'hardware',   unit: 'ק"ג', master_price_nis: 14,     keywords: ['תיל','קשירה','זיון','1','wire'] },

  // Safety (בטיחות)
  { master_sku: 'SAF-FENCE-2M',  description: 'גדר אתר 2 מ\' מודולרית',                       category: 'safety',     unit: 'מטר', master_price_nis: 95,     keywords: ['גדר','אתר','2','מודולרית','fence'] }
];

/**
 * Naive but realistic SKU matcher — token overlap + Hebrew/English keyword
 * matching + size/dimension heuristics. Returns ranked candidates with
 * confidence scores.
 *
 * In production this would be replaced with pgvector cosine similarity over
 * description embeddings + a learned reranker on transaction history.
 */
function _matchMasterSku(supplierDescription, supplierSku = '') {
  if (!supplierDescription) return [];

  const text = `${supplierDescription} ${supplierSku}`.toLowerCase().replace(/[״"׳']/g, '');
  const tokens = text.split(/[\s\-_/(),.;]+/).filter(t => t.length >= 2);

  const scored = MASTER_CATALOG.map(item => {
    const haystack = `${item.description} ${item.master_sku} ${item.keywords.join(' ')}`.toLowerCase().replace(/[״"׳']/g, '');
    let score = 0;
    let hits = 0;
    for (const tok of tokens) {
      if (!tok) continue;
      if (haystack.includes(tok)) {
        hits++;
        // Reward longer / more distinctive tokens
        score += Math.min(tok.length / 4, 3);
      }
    }
    // Bonus: exact category keyword present
    for (const kw of item.keywords) {
      if (text.includes(kw.toLowerCase())) score += 2;
    }
    // Bonus: dimension match (e.g., "12" in "ברזל 12")
    const sizeMatch = supplierDescription.match(/\d{1,3}/g) || [];
    const masterSizeMatch = item.description.match(/\d{1,3}/g) || [];
    for (const sz of sizeMatch) {
      if (masterSizeMatch.includes(sz)) score += 1.5;
    }
    return { item, score, hits };
  });

  // Filter out zero-hit items, rank, normalize confidence to 0-1
  const ranked = scored
    .filter(s => s.hits > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (ranked.length === 0) return [];

  const topScore = ranked[0].score;
  return ranked.map((s, idx) => ({
    rank: idx + 1,
    master_sku: s.item.master_sku,
    description: s.item.description,
    category: s.item.category,
    unit: s.item.unit,
    master_price_nis: s.item.master_price_nis,
    // Confidence: top match gets full score normalized; subsequent decay
    confidence: Math.min(1, +(s.score / Math.max(topScore + 1, 5)).toFixed(2))
  }));
}

class ForemanQuoteParserCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'quote_parser',
      displayName: 'פענוח הצעות מחיר',
      description: 'מפענח הצעות מחיר מספקים ומתאים מק"טי ספק למק"ט המאסטר',
      isDefault: false,

      // No transitionTo — user navigates back manually via crew selector
      // (This crew is a long-running workspace, not a one-shot stage)

      guidance: `## Your Role in This Stage
You are the Quote Parser & SKU Matcher. The user pastes (or uploads) a
supplier price quote — usually messy text extracted from a PDF, often in
Hebrew with mixed English brand names, inconsistent units, and supplier-
specific SKU codes. Your job: turn it into structured, master-matched
line items the user can trust.

## The Two-Step Workflow

### Step 1 — Parse
When the user pastes a quote (or describes what's in it), call
\`parse_quote_text\` with the full text. The tool returns extracted
line items. Show the user a clean table of what you parsed:

| # | Supplier SKU | Description | Qty | Unit | Unit Price | Total |
|---|--------------|-------------|-----|------|-----------:|------:|

If parsing missed something obvious (e.g., the user mentioned 3 line items
but you got 2), say so and ask for clarification.

### Step 2 — Match
For each parsed line, call \`match_master_sku\` with the supplier
description (and SKU if available). The tool returns up to 5 ranked
candidates with confidence scores. Present them to the user like this:

> Line 2: "ברזל זיון 16 מ"מ" → top match: **STL-REB-16** "ברזל זיון מצולע
> קוטר 16 מ"מ" (confidence 0.94). Confirm?

**Confidence handling rules:**
- ≥ 0.85 → say "high confidence" and offer to confirm immediately.
- 0.55–0.85 → say "medium confidence — please verify", show top 2-3
  candidates, ask the user to pick one or flag for review.
- < 0.55 → DO NOT auto-confirm. Show the candidates only as references and
  call \`flag_for_review\`.

When the user confirms a match (yes/אישור/קונפירם/this one), call
\`confirm_match\` with the line index and chosen master_sku. When they
reject all candidates or nothing fits, call \`flag_for_review\`.

### Step 3 — Export
When all lines are resolved (confirmed or flagged), offer to call
\`export_matched_lines\` which bundles the confirmed lines for downstream
BOQ pricing. Then suggest switching to the BOQ Pricer crew.

## Hard Rules
- NEVER invent a supplier SKU or master SKU. If the supplier didn't write
  one, leave it null in the parse step.
- NEVER confirm a match for the user. The user must explicitly say yes.
- NEVER claim a price is "before VAT" or "including VAT" unless the source
  text says so. If unclear, ASK before recording the price.
- For Hebrew quotes, preserve Hebrew descriptions in the parsed output —
  don't translate to English.

## Tone
Operator-fast. Lead with the table, then the matches, then the question.
No corporate fluff. No "let me know if you have any questions" closers —
finish with the next concrete action ("Confirm line 1?", "Ready for line
4 — או נדלג עליו?").`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2048,

      tools: [], // Set after super() so handlers can access this.getContext / writeContext
      knowledgeBase: { enabled: false }
    });

    // ---- Tools (defined here so handlers close over `this`) ----
    this.tools = [
      {
        name: 'parse_quote_text',
        description: `Parse a supplier price quote from raw text (pasted or PDF-extracted).
Returns structured line items: supplier_sku, description, qty, unit, unit_price_nis, total_nis, vat_treatment.

Call this ONCE per quote, with the full quote text. The text may be Hebrew
or English or both, may have noisy OCR artifacts, and may include header
fields (supplier name, quote number, date, validity).

Examples of when to call:
  - User pastes a block of text that looks like a quote
  - User says "here's the quote from גילי גרניט"
  - User uploads a file (the file content arrives as text)

Do NOT call this for general questions or for matching — it's for parsing only.`,
        parameters: {
          type: 'object',
          properties: {
            raw_text: {
              type: 'string',
              description: 'The full raw text of the supplier quote.'
            },
            supplier_name: {
              type: 'string',
              description: 'Supplier name if extractable from the text or known from the conversation. Example: "מפעלי ברזל אביב", "Hilti Israel".'
            }
          },
          required: ['raw_text']
        },
        handler: async (params) => {
          const { raw_text, supplier_name = null } = params;

          // Lightweight line extractor — looks for table-like rows. Splits on
          // tab / multi-space / pipe separators, so the trailing numeric block
          // (qty / unit_price / total) is identified without destroying
          // dimensional digits that live inside the description ("16 מ\"מ",
          // "B30", "Q188" — all of which matter for SKU matching).
          const VAT_RX = /(?:^|\s)(?:כולל\s*מע"?מ|לא\s*כולל\s*מע"?מ|לפני\s*מע"?מ|incl\.?\s*vat|excl\.?\s*vat)(?:\s|$)/i;
          const KNOWN_UNITS = ['מ"ק','מ"ר','מטר','טון','יח׳','יח\'','יח"','שק','ק"ג','kg','m2','m3','ton','unit','each'];
          const SKU_RX = /^[A-Z][A-Z0-9][A-Z0-9\-_/.]{1,}$/i;
          const rawLines = String(raw_text || '').split(/\r?\n/);

          const lineItems = [];
          for (const rawLine of rawLines) {
            const line = rawLine.trim();
            if (line.length < 8) continue;
            if (!/\d/.test(line)) continue;
            if (/^(תאריך|date|טל|tel|phone|הצעה|quote\s*(no|number)?|לקוח|customer)[:\s]/i.test(line)) continue;

            // Detect VAT marker on this line (we'll strip it later)
            const lineVatTreatment = /כולל\s*מע"?מ|incl\.?\s*vat/i.test(line) ? 'including_vat'
              : /לפני\s*מע"?מ|לא\s*כולל\s*מע"?מ|excl\.?\s*vat/i.test(line) ? 'excluding_vat'
              : 'unknown';
            const cleanedLine = line.replace(VAT_RX, ' ').replace(/\s{2,}/g, ' ').trim();

            // Split into table-like fields: tab, pipe, or 2+ spaces.
            let fields = cleanedLine.split(/\t+|\s*\|\s*|\s{2,}/).map(s => s.trim()).filter(Boolean);
            // If the heuristic split didn't yield enough columns, fall back to
            // single-space split — but only the trailing tail.
            if (fields.length < 3) {
              const tokens = cleanedLine.split(/\s+/);
              // Walk from the end and peel off purely-numeric tokens
              const trailingNumbers = [];
              while (tokens.length > 1 && /^[\d,]+\.?\d*$/.test(tokens[tokens.length - 1])) {
                trailingNumbers.unshift(tokens.pop());
              }
              if (trailingNumbers.length >= 2) {
                // tokens may include a unit token; split off if so
                let unit = null;
                if (tokens.length > 1 && KNOWN_UNITS.some(u => tokens[tokens.length - 1] === u)) {
                  unit = tokens.pop();
                }
                // Numbers in the middle of tokens (between description and trailing
                // numerics) are typically qty. Peel one off if it's a clean number
                // and at least 2 description tokens remain after.
                let qtyTok = null;
                if (trailingNumbers.length >= 3) {
                  qtyTok = trailingNumbers.shift();
                } else if (tokens.length >= 3 && /^[\d,]+\.?\d*$/.test(tokens[tokens.length - 1])) {
                  qtyTok = tokens.pop();
                }
                // Peel a leading SKU token (e.g., "BR-12", "HSL3M12") so it's
                // captured separately rather than swallowed by the description.
                let leadingSku = null;
                if (tokens.length > 0 && SKU_RX.test(tokens[0]) && tokens[0].length <= 24) {
                  leadingSku = tokens.shift();
                }
                fields = [];
                if (leadingSku) fields.push(leadingSku);
                fields.push(tokens.join(' '));
                if (qtyTok) fields.push(qtyTok);
                if (unit) fields.push(unit);
                fields.push(...trailingNumbers);
              } else {
                continue; // Not a line item
              }
            }

            // Identify trailing numeric fields (qty/unit_price/total).
            const numericFields = [];
            while (fields.length > 1 && /^[\d,]+\.?\d*$/.test(fields[fields.length - 1])) {
              numericFields.unshift(parseFloat(fields.pop().replace(/,/g, '')));
            }
            if (numericFields.length < 2) continue;

            // A unit field may sit between description and numbers
            let unit = null;
            if (fields.length > 1 && KNOWN_UNITS.some(u => fields[fields.length - 1] === u)) {
              unit = fields.pop();
            }

            // qty / unit_price / total assignment
            let qty = null, unit_price, total;
            if (numericFields.length >= 3) {
              [qty, unit_price, total] = numericFields.slice(-3);
            } else {
              [unit_price, total] = numericFields.slice(-2);
              if (total > unit_price * 0.5 && total < unit_price * 1e6) {
                // Common case: qty implied = total / unit_price (rounded)
                const inferredQty = total / unit_price;
                if (Number.isFinite(inferredQty) && inferredQty > 0) qty = +inferredQty.toFixed(3);
              }
            }

            // Remaining fields = supplier SKU (optional) + description
            let supplier_sku = null;
            let description = fields.join(' ').trim();
            if (fields.length > 0 && SKU_RX.test(fields[0]) && fields[0].length <= 24) {
              supplier_sku = fields[0];
              description = fields.slice(1).join(' ').trim();
            }
            description = description.replace(/^[#\-•*.\s]+/, '').replace(/\s{2,}/g, ' ').trim();
            if (description.length < 3) continue;

            // Fallback unit detection from description
            if (!unit) {
              const um = description.match(/(מ"ק|מ"ר|מטר|טון|יח['׳"]|שק|ק"ג|kg|m2|m3|ton)/i);
              if (um) unit = um[0];
            }

            lineItems.push({
              line_no: lineItems.length + 1,
              supplier_sku,
              description,
              original_line_text: rawLine.trim(),
              qty,
              unit,
              unit_price_nis: unit_price,
              total_nis: total,
              vat_treatment: lineVatTreatment
            });
          }

          // Persist to conversation-level state
          const state = (await this.getContext('quote_parse', true)) || { quotes: [] };
          const quoteId = `Q-${Date.now()}`;
          state.quotes.push({
            quote_id: quoteId,
            supplier_name,
            parsed_at: new Date().toISOString(),
            lines: lineItems,
            matches: {},
            flagged: []
          });
          state.active_quote_id = quoteId;
          await this.writeContext('quote_parse', state, true);

          return {
            quote_id: quoteId,
            supplier_name,
            lines_parsed: lineItems.length,
            lines: lineItems,
            next_step: lineItems.length > 0
              ? `Show the parsed table to the user, then start matching with match_master_sku for line 1.`
              : `No line items detected. Ask the user to paste a more complete quote or describe the items manually.`
          };
        }
      },

      {
        name: 'match_master_sku',
        description: `Match a single supplier line (description + supplier SKU) against the master SKU catalog.
Returns up to 5 ranked candidates with confidence scores (0..1).

Call this for EACH parsed line item, one at a time, before asking the user to confirm.
Confidence interpretation:
  >= 0.85 — high confidence, offer to confirm immediately
  0.55-0.85 — medium, show top candidates and ask user to pick
  < 0.55 — low, do NOT auto-confirm, suggest flag_for_review

Examples:
  match_master_sku({ description: "ברזל זיון 16 מ\"מ", supplier_sku: "BR-16" })
  match_master_sku({ description: "Hilti M12 anchor", supplier_sku: "HSL3M12" })`,
        parameters: {
          type: 'object',
          properties: {
            line_no: {
              type: 'number',
              description: 'The line number from the parsed quote (1-indexed). Used to record the match.'
            },
            description: {
              type: 'string',
              description: 'The supplier line description (Hebrew or English, as it appeared in the quote).'
            },
            supplier_sku: {
              type: 'string',
              description: "The supplier's SKU code if present. Pass empty string if not."
            }
          },
          required: ['line_no', 'description']
        },
        handler: async (params) => {
          const { line_no, description, supplier_sku = '' } = params;
          const candidates = _matchMasterSku(description, supplier_sku);

          if (candidates.length === 0) {
            return {
              line_no,
              candidates: [],
              top_confidence: 0,
              recommendation: 'flag_for_review',
              message: 'No master SKU candidates found. Recommend flagging for human review.'
            };
          }

          const top = candidates[0];
          const recommendation = top.confidence >= 0.85
            ? 'auto_confirm_eligible'
            : top.confidence >= 0.55
            ? 'user_pick'
            : 'flag_for_review';

          return {
            line_no,
            top_confidence: top.confidence,
            top_master_sku: top.master_sku,
            top_description: top.description,
            top_master_price_nis: top.master_price_nis,
            top_unit: top.unit,
            candidates,
            recommendation,
            message: recommendation === 'auto_confirm_eligible'
              ? `High confidence (${top.confidence}). Offer to confirm: ${top.master_sku} — "${top.description}".`
              : recommendation === 'user_pick'
              ? `Medium confidence (${top.confidence}). Show top 2-3 candidates and ask the user to pick.`
              : `Low confidence (${top.confidence}). Do not auto-confirm. Show candidates as reference only and call flag_for_review.`
          };
        }
      },

      {
        name: 'confirm_match',
        description: `Record a confirmed match between a supplier line and a master SKU.
Call ONLY after the user explicitly confirms (yes / אישור / זה הנכון / confirm / ok).
Never call on your own initiative.`,
        parameters: {
          type: 'object',
          properties: {
            line_no: { type: 'number', description: 'Line number from the parsed quote.' },
            master_sku: { type: 'string', description: 'The master SKU code the user confirmed.' },
            confidence: { type: 'number', description: 'The confidence score from match_master_sku (for audit trail).' }
          },
          required: ['line_no', 'master_sku']
        },
        handler: async (params) => {
          const { line_no, master_sku, confidence = null } = params;
          const state = (await this.getContext('quote_parse', true)) || { quotes: [] };
          const quote = state.quotes.find(q => q.quote_id === state.active_quote_id);
          if (!quote) {
            return { error: 'No active quote. Parse a quote first.' };
          }

          quote.matches[line_no] = {
            master_sku,
            confidence,
            confirmed_at: new Date().toISOString()
          };
          await this.writeContext('quote_parse', state, true);

          const matchedCount = Object.keys(quote.matches).length;
          const flaggedCount = quote.flagged.length;
          const totalLines = quote.lines.length;
          const remaining = totalLines - matchedCount - flaggedCount;

          return {
            recorded: true,
            line_no,
            master_sku,
            quote_progress: {
              total: totalLines,
              matched: matchedCount,
              flagged: flaggedCount,
              remaining
            },
            next_step: remaining > 0
              ? `Move to the next unresolved line.`
              : `All ${totalLines} lines resolved. Offer to call export_matched_lines.`
          };
        }
      },

      {
        name: 'flag_for_review',
        description: `Flag a line for human review when no master SKU is a confident match,
or when the user can't decide. The line will appear in the procurement
team's review queue. Always provide a short reason.`,
        parameters: {
          type: 'object',
          properties: {
            line_no: { type: 'number' },
            reason: {
              type: 'string',
              description: 'Why this line needs human review. Examples: "no candidates above 0.5 confidence", "user unsure between two options", "supplier description too vague".'
            }
          },
          required: ['line_no', 'reason']
        },
        handler: async (params) => {
          const { line_no, reason } = params;
          const state = (await this.getContext('quote_parse', true)) || { quotes: [] };
          const quote = state.quotes.find(q => q.quote_id === state.active_quote_id);
          if (!quote) return { error: 'No active quote.' };

          quote.flagged.push({
            line_no,
            reason,
            flagged_at: new Date().toISOString()
          });
          await this.writeContext('quote_parse', state, true);

          return {
            recorded: true,
            line_no,
            review_queue_position: quote.flagged.length,
            message: `Line ${line_no} flagged. The procurement team will see it in the review queue.`
          };
        }
      },

      {
        name: 'export_matched_lines',
        description: `Bundle all confirmed matches from the active quote into a structured
payload ready for downstream BOQ pricing. Call this when the user is done
matching and wants to move on. Returns a summary plus the export payload.`,
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const state = (await this.getContext('quote_parse', true)) || { quotes: [] };
          const quote = state.quotes.find(q => q.quote_id === state.active_quote_id);
          if (!quote) return { error: 'No active quote.' };

          const exported = quote.lines
            .map(line => {
              const match = quote.matches[line.line_no];
              if (!match) return null;
              return {
                line_no: line.line_no,
                supplier_sku: line.supplier_sku,
                supplier_description: line.description,
                qty: line.qty,
                unit: line.unit,
                supplier_unit_price_nis: line.unit_price_nis,
                vat_treatment: line.vat_treatment,
                master_sku: match.master_sku,
                match_confidence: match.confidence
              };
            })
            .filter(Boolean);

          return {
            quote_id: quote.quote_id,
            supplier_name: quote.supplier_name,
            exported_lines: exported.length,
            flagged_lines: quote.flagged.length,
            payload: exported,
            next_step: `Switch to the BOQ Pricer crew to price these lines into a Bill of Quantities.`
          };
        }
      }
    ];
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const session = await this.getContext('session');
    const state = (await this.getContext('quote_parse', true)) || { quotes: [] };

    const activeQuote = state.quotes.find(q => q.quote_id === state.active_quote_id);

    return {
      ...baseContext,
      role: 'Quote Parser & SKU Matcher',
      stage: 'Quote intake → Master-SKU matching',
      session: session ? {
        userRole: session.role,
        project: session.project
      } : null,
      activeQuote: activeQuote ? {
        quote_id: activeQuote.quote_id,
        supplier_name: activeQuote.supplier_name,
        total_lines: activeQuote.lines.length,
        matched_lines: Object.keys(activeQuote.matches).length,
        flagged_lines: activeQuote.flagged.length,
        next_unresolved_line: activeQuote.lines.find(l =>
          !activeQuote.matches[l.line_no] &&
          !activeQuote.flagged.some(f => f.line_no === l.line_no)
        )?.line_no || null
      } : null,
      masterCatalogSize: MASTER_CATALOG.length,
      instruction: !activeQuote
        ? 'No active quote yet. Wait for the user to paste a quote, then call parse_quote_text.'
        : Object.keys(activeQuote.matches).length + activeQuote.flagged.length >= activeQuote.lines.length
        ? 'All lines resolved. Offer to call export_matched_lines and switch to the BOQ Pricer.'
        : 'Continue matching the next unresolved line. Use match_master_sku, then ask the user to confirm.'
    };
  }
}

module.exports = ForemanQuoteParserCrew;
