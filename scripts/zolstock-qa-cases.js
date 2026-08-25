/**
 * ZolStock production-readiness question set.
 *
 * REWRITTEN 2026-08-19 for the four-file delivery. The previous set was built
 * against a data model that no longer exists — it asked about sellers,
 * campaigns, discounts, invoices, retail customers and actual revenue, none of
 * which survive in the new feed. Keeping those questions would have measured
 * the wrong thing: they would "fail" correctly while telling us nothing about
 * whether the rebuild works.
 *
 * The classes are deliberate, because each fails differently:
 *   · simple / complex         — does it aggregate correctly at all
 *   · English / Hebrew / mixed — these clients work in Hebrew; language and
 *                                correctness are independent failure modes
 *   · absent                   — must say "not available", never substitute a
 *                                near-neighbour. This is what C3's PLAN
 *                                contract exists to catch, and every absent
 *                                case below was a REAL column in the retired
 *                                file — so the plausible wrong answer is right
 *                                there to be reached for
 *   · listprice                — money is DERIVED from item list prices, so the
 *                                answer must say so rather than present an
 *                                estimate as takings
 *   · nodate                   — inventory rows carry no date, so a date filter
 *                                on them can never match; the answer must say
 *                                that rather than report "no data" (C4)
 *   · stale                    — sales end 2026-08-17, so "today" is
 *                                legitimately empty; say so, don't imply a fault
 *   · partial                  — the trailing month is incomplete and must be
 *                                labelled as such (C5)
 */

/** ~35 investigation prompts (the "reports" side). */
const REPORT_CASES = [
  // ── proposed chips + bootstrap set (these ship to users — must be verified)
  { id: 'R01', kind: 'chip',      lang: 'en', prompt: 'Main risks for the next few months' },
  { id: 'R02', kind: 'chip',      lang: 'en', prompt: 'What are the top 10 items by quantity sold' },
  { id: 'R03', kind: 'chip',      lang: 'en', prompt: 'Which product category has the steepest margin decline' },
  { id: 'R04', kind: 'bootstrap', lang: 'en', prompt: 'Which stores have the steepest sales decline recently' },
  { id: 'R05', kind: 'bootstrap', lang: 'en', prompt: 'Which items are below their safety stock level in the warehouse' },
  { id: 'R06', kind: 'bootstrap', lang: 'en', prompt: 'What is the monthly sales trend across the chain' },
  { id: 'R07', kind: 'bootstrap', lang: 'en', prompt: 'Which product categories generate the most gross profit' },

  // ── simple English
  { id: 'R08', kind: 'simple',  lang: 'en', prompt: 'How many units did we sell in total?' },
  { id: 'R09', kind: 'simple',  lang: 'en', prompt: 'What are the top 10 stores by units sold?' },
  { id: 'R10', kind: 'simple',  lang: 'en', prompt: 'How many stores and how many items do we have?' },
  { id: 'R11', kind: 'simple',  lang: 'en', prompt: 'Which product categories sell the most units?' },

  // ── complex English
  { id: 'R12', kind: 'complex', lang: 'en', prompt: 'Which product categories generate the most profit, and what is their margin?' },
  { id: 'R13', kind: 'complex', lang: 'en', prompt: 'How concentrated are sales across stores — do a few stores drive most of the volume?' },
  { id: 'R14', kind: 'complex', lang: 'en', prompt: 'Which suppliers have the highest-margin products?' },
  { id: 'R15', kind: 'complex', lang: 'en', prompt: 'Compare units sold this year against the same months last year' },
  { id: 'R16', kind: 'complex', lang: 'en', prompt: 'Which items sell well but have low warehouse stock right now?' },
  { id: 'R17', kind: 'complex', lang: 'en', prompt: 'What is on order from suppliers, and for which items?' },
  { id: 'R18', kind: 'complex', lang: 'en', prompt: 'Do Jewish holidays measurably change our sales volume?' },

  // ── Hebrew only
  { id: 'R19', kind: 'simple',  lang: 'he', prompt: 'כמה יחידות נמכרו בכל חנות?' },
  { id: 'R20', kind: 'simple',  lang: 'he', prompt: 'מהם 10 הפריטים הנמכרים ביותר לפי כמות?' },
  { id: 'R21', kind: 'complex', lang: 'he', prompt: 'אילו קטגוריות מוצרים מניבות את הרווח הגבוה ביותר?' },
  { id: 'R22', kind: 'complex', lang: 'he', prompt: 'אילו חנויות מראות את הירידה החדה ביותר במכירות?' },
  { id: 'R23', kind: 'simple',  lang: 'he', prompt: 'מהי מגמת המכירות החודשית?' },
  { id: 'R24', kind: 'complex', lang: 'he', prompt: 'אילו פריטים נמצאים מתחת למלאי הביטחון במחסן?' },

  // ── mixed Hebrew + English
  { id: 'R25', kind: 'mixed',   lang: 'mix', prompt: 'תראה לי top 10 stores לפי units sold' },
  { id: 'R26', kind: 'mixed',   lang: 'mix', prompt: 'מה ה-profit margin לפי category?' },
  { id: 'R27', kind: 'mixed',   lang: 'mix', prompt: 'אילו items יש להם הכי הרבה stock במחסן?' },

  // ── data that genuinely does not exist — must decline, never substitute
  { id: 'R28', kind: 'absent',  lang: 'en', prompt: 'Which sales staff sell the most?' },
  { id: 'R29', kind: 'absent',  lang: 'en', prompt: 'How much revenue did we lose to discounts and promotions?' },
  { id: 'R30', kind: 'absent',  lang: 'en', prompt: 'Which retail customers buy the most from us?' },
  { id: 'R31', kind: 'absent',  lang: 'he', prompt: 'מהי העמלה של כל מוכרן?' },

  // ── list-price honesty: money is derived, and the answer must say so
  { id: 'R32', kind: 'listprice', lang: 'en', prompt: 'What is our total revenue and gross profit?' },

  // ── inventory has no dates — a date filter on it can never match (C4)
  { id: 'R33', kind: 'nodate',  lang: 'en', prompt: 'How did our warehouse stock change over the last three months?' },

  // ── trailing period incomplete (C5) / data cutoff (stale)
  { id: 'R34', kind: 'partial', lang: 'en', prompt: 'How did we perform this month compared with last month?' },
  { id: 'R35', kind: 'stale',   lang: 'he', prompt: 'מה המכירות שלנו היום?' },
];

/** ~30 direct questions (the Data Chat side — same NL->SQL engine, no write-up). */
const CHAT_CASES = [
  // simple English
  { id: 'C01', kind: 'simple',  lang: 'en', q: 'What is the total quantity sold?' },
  { id: 'C02', kind: 'simple',  lang: 'en', q: 'What are the top 10 items by quantity sold?' },
  { id: 'C03', kind: 'simple',  lang: 'en', q: 'What are the units sold by store?' },
  { id: 'C04', kind: 'simple',  lang: 'en', q: 'How many stores do we have?' },
  { id: 'C05', kind: 'simple',  lang: 'en', q: 'How many items are in the catalogue?' },
  { id: 'C06', kind: 'simple',  lang: 'en', q: 'What is the monthly sales trend?' },
  { id: 'C07', kind: 'simple',  lang: 'en', q: 'How much stock is in the central warehouse?' },
  { id: 'C08', kind: 'simple',  lang: 'en', q: 'What are the top 10 product categories by units sold?' },

  // complex English
  { id: 'C09', kind: 'complex', lang: 'en', q: 'What is the gross margin percentage by product category?' },
  { id: 'C10', kind: 'complex', lang: 'en', q: 'Which 10 items have the highest warehouse stock value?' },
  { id: 'C11', kind: 'complex', lang: 'en', q: 'Which stores had the biggest drop in units between June and July 2026?' },
  { id: 'C12', kind: 'complex', lang: 'en', q: 'Which suppliers have the most items in the catalogue?' },
  { id: 'C13', kind: 'complex', lang: 'en', q: 'Show units sold by category for the last 3 months of available data' },
  { id: 'C14', kind: 'complex', lang: 'en', q: 'Which items are below their safety stock in the warehouse?' },
  { id: 'C15', kind: 'complex', lang: 'en', q: 'What quantity is currently on open purchase orders?' },

  // Hebrew only
  { id: 'C16', kind: 'simple',  lang: 'he', q: 'מה סך הכמות שנמכרה?' },
  { id: 'C17', kind: 'simple',  lang: 'he', q: 'מהן 10 החנויות המובילות לפי כמות?' },
  { id: 'C18', kind: 'simple',  lang: 'he', q: 'כמה פריטים יש בקטלוג?' },
  { id: 'C19', kind: 'complex', lang: 'he', q: 'מה אחוז הרווח לפי קטגוריה?' },
  { id: 'C20', kind: 'complex', lang: 'he', q: 'אילו פריטים מתחת למלאי הביטחון?' },
  { id: 'C21', kind: 'simple',  lang: 'he', q: 'מהי מגמת המכירות החודשית?' },

  // mixed
  { id: 'C22', kind: 'mixed',   lang: 'mix', q: 'מה ה-total units לפי store?' },
  { id: 'C23', kind: 'mixed',   lang: 'mix', q: 'תן לי top 10 items לפי quantity' },
  { id: 'C24', kind: 'mixed',   lang: 'mix', q: 'מה ה-margin הכולל?' },
  { id: 'C25', kind: 'mixed',   lang: 'mix', q: 'כמה stock יש לנו per store?' },

  // absent data
  { id: 'C26', kind: 'absent',  lang: 'en', q: 'Who are our top 10 sales staff by revenue?' },
  { id: 'C27', kind: 'absent',  lang: 'en', q: 'What is the average discount percentage per sale?' },
  { id: 'C28', kind: 'absent',  lang: 'he', q: 'כמה חשבוניות הופקו החודש?' },

  // list-price honesty
  { id: 'C29', kind: 'listprice', lang: 'en', q: 'What is our total revenue?' },

  // stale period
  { id: 'C30', kind: 'stale',   lang: 'en', q: 'What was the revenue today?' },
];

module.exports = { REPORT_CASES, CHAT_CASES };
