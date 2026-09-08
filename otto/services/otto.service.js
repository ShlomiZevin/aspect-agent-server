/**
 * Otto — the screen builder.
 *
 * Alfred builds agents and returns JSON. Otto builds operational screens and
 * returns HTML. Everything else is deliberately the same machine, because that
 * shape has already been proven in the builder (see
 * docs/guides/BUILDER_V2_ALFRED.md, decisions 51 and 52):
 *
 *   1. BRAINSTORM — Sonnet. Free conversation about what the user needs. Sees
 *      the data model as prose, never the rows, and cannot write HTML. When
 *      the request is concrete enough it says so and stops asking.
 *   2. PLAN — a separate call that consolidates the conversation into an
 *      action plan: a title, a summary, and the concrete parts of the screen.
 *      The user reads it, edits it, and approves it. This is the gate.
 *   3. BUILD — Opus, a separate call. Receives the approved plan, the schema
 *      and the actual demo rows, and returns one self-contained HTML screen.
 *      It never takes part in the conversation.
 *
 * WHY THREE CALLS AND NOT ONE AGENT. Same reasons Alfred is split: the
 * brainstorm prompt stays small and free of build noise, the builder can run
 * on a stronger and more expensive model only when it is actually building,
 * failures isolate to one phase, and — the point of the whole product — the
 * user can read and edit the plan in the gap between talking and building.
 *
 * Two models on purpose: `claude-sonnet-5` to talk (fast, cheap, many turns)
 * and `claude-opus-5` to build (one call, and the quality of the artifact is
 * the whole deliverable). Both are current-generation and cost the same per
 * token as the 4.x models they replace — $3/$15 and $5/$25 per million.
 */

const llmService = require('../../services/llm');
const { schemaForPrompt, demoData, dataSummary } = require('../data/demo-dataset');

// NOTE: no `temperature` is passed anywhere in this file. The current Opus
// and Sonnet models reject the parameter outright ("temperature is
// deprecated for this model") and fail the whole call with a 400.
const TALK_MODEL = 'claude-sonnet-5';
const BUILD_MODEL = 'claude-opus-5';

/** Everything the user sees is Hebrew, so everything the models write is Hebrew. */
const HEBREW_RULE =
  'כתוב תמיד בעברית. גם ההסברים, גם התוכנית, וגם כל טקסט שמופיע במסך שאתה בונה — כותרות, תוויות, כפתורים והודעות.';

function extractJSON(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new Error('המודל לא החזיר JSON תקין');
}

// ── 1 · Brainstorm ──────────────────────────────────────────────────────────

/**
 * One conversational turn.
 *
 * `readyToPlan` is the model's own judgement that it has enough to build from.
 * It only unlocks the button — the user still decides when to move on, exactly
 * as Alfred's proposal card is a suggestion rather than an action.
 */
async function brainstorm({ messages, currentPlan = null }) {
  // Once a screen exists the conversation is about CHANGING it, not about
  // inventing one. Same chat box, different footing — which is why the page
  // no longer has a separate revision composer that swallowed the user's
  // message instead of showing it in the transcript.
  const existing = currentPlan
    ? `\n\nכבר קיים מסך בנוי בשם "${currentPlan.title}" — ${currentPlan.summary}\nהחלקים שבו: ${currentPlan.parts.map(x => x.name).join(', ')}\n\nהשיחה עכשיו היא על שינוי למסך הזה. הבן בדיוק מה המשתמש רוצה לשנות, להוסיף או להסיר. אל תתכנן מסך חדש מאפס.`
    : '';

  const system = `אתה אוטו — בונה המסכים של מרכז האינטליגנס.

אתה מדבר עם עובד בארגון קמעונאי שאינו מפתח. הוא רוצה מסך תפעולי לעבודה היומיומית שלו: טבלה, סינון, כרטיסי מדדים, גרף, רשימת פעולות. התפקיד שלך בשלב הזה הוא רק להבין בדיוק מה הוא צריך — לא לבנות.

${HEBREW_RULE}

אתה מכיר את הנתונים של הארגון:

${schemaForPrompt()}${existing}

איך אתה מתנהג:
- שאל שאלה אחת או שתיים בכל תור, לא רשימה. אתה בשיחה, לא בטופס.
- הצע ניסוח קונקרטי במקום לשאול שאלה פתוחה. "להציג לפי סניף או לפי ספק?" עדיף על "איך תרצה לראות את זה?".
- אם משהו שהוא ביקש לא אפשרי מהנתונים — אמור זאת מיד ובמפורש, וציין איזו מגבלה חוסמת. אל תבנה משהו דומה בשקט במקום.
- אל תשאל על צבעים, עיצוב או פריסה. זה התפקיד שלך.
- אל תכתוב קוד ואל תתאר HTML. אתה מדבר על מה המסך עושה, לא איך הוא בנוי.
- כשברור לך מה צריך להיבנות או להשתנות — סכם במשפט אחד, ואמור למשתמש שאפשר לעבור לתוכנית. אל תמשיך לשאול.

החזר JSON בלבד:
{
  "reply": "מה שאתה אומר למשתמש. עברית. קצר — שתיים עד ארבע שורות.",
  "readyToPlan": true אם יש לך מספיק כדי לבנות מסך, אחרת false,
  "readySummary": "כשready — משפט אחד שמתאר את המסך שייבנה. אחרת מחרוזת ריקה.",
  "state": "משפט אחד קצר מאוד בגוף ראשון שמתאר איפה אתה עומד — מה כבר ברור לך ומה עוד חסר לך. זה נכתב על לוח המצב שלך, לא בשיחה. לדוגמה: 'יש לי את המטרה ואת החתך — חסר לי טווח התאריכים.' כשready: 'יש לי הכל כדי לתכנן.'"
}`;

  const transcript = messages
    .map(m => `${m.role === 'user' ? 'משתמש' : 'אוטו'}: ${m.content}`)
    .join('\n\n');

  const response = await llmService.sendOneShot(system, transcript, {
    model: TALK_MODEL, maxTokens: 900, jsonOutput: true, context: 'otto_brainstorm',
  });

  const parsed = extractJSON(response);
  return {
    reply: String(parsed.reply || '').trim(),
    readyToPlan: Boolean(parsed.readyToPlan),
    readySummary: String(parsed.readySummary || '').trim(),
    state: String(parsed.state || '').trim(),
  };
}

// ── 2 · Plan ────────────────────────────────────────────────────────────────

/**
 * The conversation, consolidated into something the user can read and correct.
 *
 * This is the gate, and it is the reason the flow has three phases rather than
 * two: a non-developer cannot review generated HTML, but they can absolutely
 * review "a table of items below safety stock, grouped by supplier, with the
 * shortfall and a button to export". Getting it wrong here is cheap; getting
 * it wrong after the build is not.
 */
async function plan({ messages, currentPlan = null }) {
  // A revision plan is not a fresh plan. It states the delta — what changes
  // and what stays — because that is what the user is approving, and because
  // the builder receives the previous screen and must edit it, not redraw it.
  const revising = currentPlan
    ? `\n\nזו אינה תוכנית חדשה. כבר קיים מסך בנוי:\n  שם: ${currentPlan.title}\n  תיאור: ${currentPlan.summary}\n  חלקים: ${currentPlan.parts.map(x => `${x.name} — ${x.detail}`).join(' | ')}\n\nהפק תוכנית שינוי: החזר את התוכנית המלאה של המסך אחרי השינוי, ובנוסף מלא את "changes" עם מה שמשתנה בפועל. שמור על השם הקיים אלא אם המשתמש ביקש לשנות אותו.`
    : '';

  const system = `אתה אוטו. השיחה עם המשתמש הסתיימה. הפוך אותה לתוכנית פעולה ברורה שהמשתמש יאשר לפני שהמסך נבנה.${revising}

${HEBREW_RULE}

הנתונים הזמינים:

${schemaForPrompt()}

התוכנית צריכה להיות קריאה למישהו שאינו מפתח. כל חלק הוא משהו שהוא יראה על המסך, לא רכיב טכני.

החזר JSON בלבד:
{
  "title": "שם המסך. שתיים עד ארבע מילים.",
  "summary": "משפט אחד: מה המסך הזה עושה ולמי הוא מיועד.",
  "parts": [
    { "name": "שם החלק", "detail": "מה הוא מציג ומאיזה נתונים, במשפט אחד" }
  ],
  "notes": ["הסתייגות או מגבלת נתונים שהמשתמש חייב לדעת עליה. מערך ריק אם אין."],
  "changes": ["רק כשמדובר בשינוי למסך קיים: מה משתנה, שורה אחת לכל שינוי. מערך ריק כשזה מסך חדש."]
}

בין שלושה לשישה חלקים. אם משהו בתוכנית נשען על נתון שלא קיים — אל תשמיט אותו בשקט, כתוב אותו ב-notes.`;

  const transcript = messages
    .map(m => `${m.role === 'user' ? 'משתמש' : 'אוטו'}: ${m.content}`)
    .join('\n\n');

  const response = await llmService.sendOneShot(system, transcript, {
    model: TALK_MODEL, maxTokens: 1400, jsonOutput: true, context: 'otto_plan',
  });

  const parsed = extractJSON(response);
  return {
    isChange: Boolean(currentPlan),
    changes: Array.isArray(parsed.changes)
      ? parsed.changes.map(c => String(c).trim()).filter(Boolean).slice(0, 6)
      : [],
    title: String(parsed.title || 'מסך חדש').trim(),
    summary: String(parsed.summary || '').trim(),
    parts: Array.isArray(parsed.parts)
      ? parsed.parts
        .filter(p => p && p.name)
        .slice(0, 8)
        .map(p => ({ name: String(p.name).trim(), detail: String(p.detail || '').trim() }))
      : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(n => String(n).trim()).filter(Boolean).slice(0, 5) : [],
  };
}

// ── 3 · Build ───────────────────────────────────────────────────────────────

/**
 * The approved plan becomes a screen.
 *
 * The rows are embedded rather than fetched: this is the half of Otto that is
 * still a mockup, and inlining the data is what lets the artifact be a single
 * file that genuinely works — sorts, filters and totals for real — without a
 * backend behind it. When Otto is wired to live data this is the one function
 * that changes: the same plan compiles against a query instead of a constant.
 */
function buildPrompts({ plan: approvedPlan, previousHtml = null }) {
  const data = demoData();
  const counts = dataSummary();

  const system = `אתה אוטו, ובונה עכשיו מסך תפעולי אמיתי למרכז האינטליגנס.

${HEBREW_RULE}

אתה מקבל תוכנית שהמשתמש כבר אישר, ואת הנתונים עצמם. בנה בדיוק את מה שבתוכנית — לא פחות, ולא תוספות שלא ביקשו.

הנתונים מוזרקים לקוד שלך כמשתנה גלובלי בשם DATA, עם המבנה הזה:
  DATA.stores      (${counts.stores} רשומות)  { store_id, store_name, region }
  DATA.items       (${counts.items} רשומות)  { item_id, item_name, category, supplier, cost_ex_vat, list_price, safety_stock }
  DATA.suppliers   (${counts.suppliers} רשומות)  { supplier, lead_time_days }
  DATA.inventory   (${counts.inventoryRows} רשומות)  { store_id, item_id, qty_on_hand, qty_on_order }   // store_id = 'WH' הוא המחסן
  DATA.sales       (${counts.salesRows} רשומות)  { date, store_id, item_id, qty_sold, revenue_ex_vat, profit_ex_vat }   // ${counts.firstDate} עד ${counts.lastDate}

${schemaForPrompt()}

כללי בנייה — כולם מחייבים:

1. החזר קטע HTML אחד בלבד. בלי <!DOCTYPE>, בלי <html>, בלי <head> ובלי <body>. סגנון ב-<style> וקוד ב-<script>, בתוך מה שאתה מחזיר.
2. אל תמציא נתונים ואל תכתוב מספרים קשיחים. כל מספר שמופיע על המסך מחושב מ-DATA בזמן ריצה.
3. אל תטען שום דבר מהרשת. בלי CDN, בלי גופנים חיצוניים, בלי תמונות. הכול עומד בפני עצמו.
4. המסך בעברית ובכיוון RTL. עטוף הכול ב-<div dir="rtl">.
5. סכומי כסף בשקלים עם הפרדת אלפים, ללא עשרוניות מיותרות (₪1,240 ולא ₪1240.00). כמויות כמספרים שלמים.
6. אם יש טבלה — כותרות ברורות, מיון בלחיצה על כותרת, ולכל היותר 50 שורות מוצגות עם ציון כמה שורות יש בסך הכול.
7. אם יש סינון — הוא עובד באמת ומעדכן את המספרים.
8. אל תשתמש ב-alert. פעולה שאין לה עדיין חיבור אמיתי (ייצוא, שליחה, יצירת הזמנה) מציגה הודעה קטנה בתוך המסך שהפעולה תופעל כשהמסך יחובר למערכות.
9. עיצוב — יש בעמוד גיליון סגנון מלא של המערכת. השתמש במחלקות ובמשתנים שלו ואל תמציא
   צבעים או מידות משלך:
   var(--otto-text) טקסט · var(--otto-text-secondary) טקסט משני
   var(--otto-surface) רקע כרטיס · var(--otto-surface-subtle) רקע משני · var(--otto-canvas) רקע עמוד
   var(--otto-border) גבול · var(--otto-border-control) גבול של פקד
   var(--otto-accent) הדגשה · var(--otto-radius-md) פינות · var(--otto-space-4) מרווח
   סטטוסים: var(--otto-success-*) · var(--otto-warning-*) · var(--otto-danger-*) · var(--otto-neutral-status-*)
   גרפים: var(--otto-chart-1) עד var(--otto-chart-6), בסדר הזה.

   הכלל החשוב ביותר: הסגול הוא לפעולות בלבד — כפתור ראשי, קישור, פוקוס, פקד מסומן והבחירה
   הנוכחית. אסור סגול ברקעים, בכותרות, בכותרות טבלה, במספרי מדדים, בתגיות סטטוס, בגרדיאנטים
   או בצללים. מסך שסגול בו הוא אווירה נראה כמו דוח BI צבוע, לא כמו כלי.
   בלי אימוג'י בממשק.
10. רוחב מלא של המכל שאתה מקבל — אל תקבע רוחב קבוע ואל תמרכז בכוח.
11. אל תפתח את המסך בכותרת של שם המסך ותיאורו. המערכת שמסביב כבר מציגה את השם — כותרת נוספת היא אותה כותרת פעמיים. התחל ישר בתוכן. אם יש הסתייגות חשובה על הנתונים, כתוב אותה כשורה אחת בראש המסך, בלי כותרת מעליה.
12. אל תעטוף את כל המסך בכרטיס אחד גדול. המסך הוא עמוד: רקע העמוד ואזורים עליו. כרטיס שעוטף את כל שאר הכרטיסים יוצר מסגרת בתוך מסגרת.
13. אל תיצור אזור גלילה פנימי. אסור overflow:auto או overflow:scroll או max-height או height קבוע על
    טבלה, רשימה או מכל כלשהו. התוכן פשוט נמשך למטה והעמוד שמסביב גולל אותו — אחרת המשתמש לא
    מצליח להגיע לסוף הרשימה. היוצא מן הכלל היחיד הוא overflow-x:auto על טבלה רחבה מדי.

החזר את ה-HTML בלבד. בלי הסבר לפניו ובלי הסבר אחריו ובלי גדרות קוד.`;

  const parts = approvedPlan.parts.map((p, i) => `${i + 1}. ${p.name} — ${p.detail}`).join('\n');
  const notes = approvedPlan.notes?.length ? `\n\nהסתייגויות שהמשתמש מודע להן:\n${approvedPlan.notes.map(n => `- ${n}`).join('\n')}` : '';
  // A revision gets the previous screen AND the approved change list, so it
  // edits rather than redraws. Redrawing loses everything the user liked.
  const revision = previousHtml
    ? `\n\nזו גרסה מתוקנת של מסך קיים. השינויים שאושרו:\n${(approvedPlan.changes || []).map(c => `- ${c}`).join('\n') || '- לפי התוכנית שלמעלה'}\n\nשנה רק את מה שברשימה. כל השאר נשאר בדיוק כפי שהוא — אותה פריסה, אותם שמות, אותו סדר. המסך הקודם:\n${previousHtml}`
    : '';

  const user = `שם המסך: ${approvedPlan.title}
מה הוא עושה: ${approvedPlan.summary}

החלקים שאושרו:
${parts}${notes}${revision}`;

  return { system, user, data };
}

async function build(args) {
  const { system, user, data } = buildPrompts(args);
  const response = await llmService.sendOneShot(system, user, {
    model: BUILD_MODEL, maxTokens: 16000, context: 'otto_build',
  });
  return { html: cleanHtml(response), data };
}

/**
 * The same build, streamed, so the page can report what is actually happening.
 *
 * WHY THIS REPLACED A TIMER. The build used to advance three captions on
 * elapsed seconds — the one place in Otto where the UI claimed to know
 * something it did not. Here the PHASE is a real observation: it changes when
 * the model has actually written the thing it names, read off the output as it
 * arrives. A build that stalls now visibly stalls instead of marching on.
 *
 * The PERCENTAGE is still an estimate — the API does not tell us how much is
 * left — but an honest one: for a revision we know the previous screen's exact
 * length, and for a new screen we compare against a typical one. It is capped
 * below 100 until the response actually ends, so it never claims completion.
 */
const TYPICAL_SCREEN_CHARS = 13000;

/**
 * Most advanced milestone first. These are the only landmarks that reliably
 * appear in every screen: an earlier version also required a literal `DATA.`
 * before calling the build finished, and it never fired once — models write
 * `const { inventory } = DATA` at least as often as `DATA.inventory`.
 */
function phaseOf(html) {
  if (/<\/script>/i.test(html)) return 'checking';
  // Interaction is always wired after the computation is written, so the first
  // listener is a real boundary between the two — measured at 92% of a build.
  // A screen with no controls simply never reaches it, which is correct.
  if (/addEventListener/.test(html)) return 'wiring';
  if (/<script[\s>]/i.test(html)) return 'data';
  if (/<\/style>/i.test(html)) return 'markup';
  if (/<style[\s>]/i.test(html)) return 'style';
  return 'structure';
}

async function* buildStream(args) {
  const { system, user, data } = buildPrompts(args);
  const expected = args.previousHtml ? args.previousHtml.length : TYPICAL_SCREEN_CHARS;

  let acc = '';
  let phase = 'structure';
  let lastSent = 0;

  const stream = llmService.sendMessageStreamWithPrompt(user, 'otto-build', {
    prompt: system,
    model: BUILD_MODEL,
    maxTokens: 16000,
    // Stateless: an empty array stops the provider reaching for DB history it
    // would never find, which is what makes this usable as a one-shot.
    historyMessages: [],
  });

  for await (const chunk of stream) {
    if (typeof chunk !== 'string') continue;
    acc += chunk;

    const next = phaseOf(acc);
    const percent = Math.min(96, Math.round((acc.length / expected) * 100));
    // One event per phase change, otherwise no more than one per ~2% — a token
    // is a few characters and we are not going to render 4,000 of these.
    if (next !== phase || percent >= lastSent + 2) {
      phase = next;
      lastSent = percent;
      yield { type: 'progress', phase, percent, chars: acc.length };
    }
  }

  yield { type: 'done', html: cleanHtml(acc), data };
}

/**
 * Models wrap HTML in a fence often enough that stripping it is cheaper than
 * another round trip, and a stray ``` in the iframe is a visible defect.
 */
function cleanHtml(text) {
  let html = String(text || '').trim();
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (fenced) html = fenced[1].trim();
  return html;
}

module.exports = { brainstorm, plan, build, buildStream, TALK_MODEL, BUILD_MODEL };
