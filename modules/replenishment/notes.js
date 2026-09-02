/**
 * Every sentence this module says to a person, in both languages.
 *
 * WHY THIS FILE EXISTS. The engine used to push finished English prose into
 * `notes[]`, and the screen quoted it verbatim — which is the right rule, and
 * was the reason a Hebrew buyer read "No safety stock is set for this item"
 * under a Hebrew heading, with the sentence reversed by RTL into nonsense. The
 * caveats are the most important text on the page: they are the difference
 * between a number a buyer can act on and one they cannot. Shipping them in a
 * language the reader does not use is worse than not shipping them.
 *
 * The fix is not to translate on the client. That would put the same caveat in
 * three places — the screen, the chat answer and the CSV — free to drift apart,
 * which is exactly what the "quote, never re-word" rule exists to prevent. So
 * the ENGINE emits a code and its numbers, and this file is the single place
 * that turns one into a sentence, in whichever language was asked for.
 *
 * Adding a note: add the code here with both languages, then push
 * `{ code, params }` from the engine. A code with no entry renders as the code
 * itself rather than throwing — a missing translation should look wrong on
 * screen, not take the page down.
 */

/**
 * Grouped digits in the reader's locale.
 *
 * Hebrew uses the same digits and the same separator, so this is about the
 * locale being right rather than the output differing — but a number formatted
 * for the wrong locale is the kind of thing that only shows up in the one case
 * that matters.
 */
function n(value, lang) {
  return Math.round(Number(value) || 0).toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB');
}

/**
 * The catalogue. Each entry is a pair of functions of the note's own params.
 *
 * The Hebrew is a translation of the MEANING, not of the word order: several of
 * these read badly if the English clause order is kept, and a caveat that is
 * hard to parse is a caveat that gets skipped.
 */
const NOTES = {
  window_substituted: {
    en: p => `Sales pace is measured over ${p.days} days — the closest prepared window to the configured ${p.requested}.`,
    he: p => `קצב המכירה נמדד על פני ${p.days} ימים — החלון המוכן הקרוב ביותר ל־${p.requested} שהוגדרו.`,
  },
  thin_history: {
    en: p => `This item first sold ${p.soldForDays} days ago, so its pace is measured over that period rather than the full ${p.days} days — a short history is a less reliable basis.`,
    he: p => `הפריט נמכר לראשונה לפני ${p.soldForDays} ימים, ולכן הקצב נמדד על פני התקופה הזו ולא על פני ${p.days} ימים מלאים — היסטוריה קצרה היא בסיס פחות אמין.`,
  },
  stale_demand: {
    en: p => `No sales in the last ${p.days} days (last sold ${p.lastSold}), so no reorder is suggested even though the item sold earlier.`,
    he: p => `אין מכירות ב־${p.days} הימים האחרונים (נמכר לאחרונה ב־${p.lastSold}), ולכן לא מוצעת הזמנה למרות שהפריט נמכר בעבר.`,
  },
  negative_available: {
    en: p => `Available stock is negative (${n(p.netAvailable, 'en')}). That usually means adjustments are missing from the feed rather than a real shortage — treat this item's figures as suspect.`,
    he: p => `המלאי הזמין שלילי (${n(p.netAvailable, 'he')}). בדרך כלל זה אומר שחסרים תיקוני מלאי בקובץ ולא שיש מחסור אמיתי — יש להתייחס לנתוני הפריט הזה בחשד.`,
  },
  on_order_unverified: {
    en: () => 'The data has no delivery confirmations, so quantities shown as "on the way" may include goods that already arrived.',
    he: () => 'אין בנתונים אישורי קליטה, ולכן כמויות שמוצגות כ"בדרך" עשויות לכלול סחורה שכבר הגיעה.',
  },
  safety_from_pace: {
    en: p => `No safety stock is set for this item, so ${p.safetyDays} days of sales (${n(p.safetyStock, 'en')} units) is used as a buffer.`,
    he: p => `לא הוגדר מלאי ביטחון לפריט הזה, ולכן משמשות ${p.safetyDays} ימי מכירה (${n(p.safetyStock, 'he')} יחידות) כרזרבה.`,
  },
  lead_time_default: {
    en: p => `Delivery time for this supplier has not been set, so the ${p.leadTimeDays}-day default is used. Setting the real one changes when this order is due.`,
    he: p => `לא הוגדר זמן אספקה לספק הזה, ולכן מוחלת ברירת המחדל של ${p.leadTimeDays} ימים. הגדרת הזמן האמיתי תשנה את מועד ההזמנה.`,
  },
  already_out: {
    en: () => 'Nothing is available to sell right now — this order is already overdue by the full delivery time.',
    he: () => 'אין כרגע מלאי זמין למכירה — ההזמנה הזו כבר מאחרת במלוא זמן האספקה.',
  },
  carton_unknown: {
    en: () => 'Carton size is not in the catalogue for this item, so the quantity is not rounded to a full carton.',
    he: () => 'גודל האריזה לא מופיע בקטלוג לפריט הזה, ולכן הכמות אינה מעוגלת לארגז שלם.',
  },
  idle_stock: {
    en: p => `No recent sales, but ${n(p.onHand, 'en')} units are on hand — this is idle stock rather than something to reorder.`,
    he: p => `אין מכירות אחרונות, אך יש ${n(p.onHand, 'he')} יחידות במלאי — זהו מלאי תקוע ולא משהו להזמין מחדש.`,
  },
  unmatched_code: {
    en: () => 'This code is not in the item catalogue, so its name, supplier and price are unknown.',
    he: () => 'הקוד הזה אינו בקטלוג הפריטים, ולכן השם, הספק והמחיר אינם ידועים.',
  },
  cost_estimate: {
    en: () => 'Cost is a list-price estimate excluding VAT and before discounts.',
    he: () => 'העלות היא הערכה לפי מחיר מחירון, ללא מע״מ ולפני הנחות.',
  },
};

/** How the sales pace was measured — shown under the pace figure. */
const BASIS = {
  window_average: {
    en: p => `${p.days}-day average`,
    he: p => `ממוצע ${p.days} ימים`,
  },
  since_first_sale: {
    en: p => `${p.days} days since first sale`,
    he: p => `${p.days} ימים מאז המכירה הראשונה`,
  },
};

/** What was done to the raw quantity — appears inside the derivation sentence. */
const ROUNDING = {
  // Rendered as a phrase rather than the bare word "none", which read as
  // "order 688, none -> 688 units" inside the derivation sentence. The screen
  // drops the clause entirely in this case (see orderQtyRoundingCode below);
  // this wording is what the CSV and the chat answer get.
  none: { en: () => 'no rounding applied', he: () => 'ללא עיגול' },
  cartons: {
    en: p => `rounded up to full cartons of ${p.carton}`,
    he: p => `מעוגל כלפי מעלה לארגזים שלמים של ${p.carton}`,
  },
  carton_rounding_off: {
    en: () => 'carton rounding disabled',
    he: () => 'עיגול לארגז מבוטל',
  },
  carton_unknown: {
    en: () => 'carton size unknown',
    he: () => 'גודל אריזה לא ידוע',
  },
  min_order: {
    en: p => `raised to the ${p.minOrderUnits}-unit minimum order`,
    he: p => `הועלה למינימום הזמנה של ${p.minOrderUnits} יחידות`,
  },
};

function pick(catalogue, entry, lang) {
  if (!entry) return null;
  const spec = catalogue[entry.code];
  // A code with no entry shows as the code. Loud on screen, harmless in
  // production — the alternative is a page that fails to render a caveat.
  if (!spec) return entry.code;
  const fn = spec[lang === 'he' ? 'he' : 'en'] || spec.en;
  try {
    return fn(entry.params || {});
  } catch {
    return entry.code;
  }
}

const renderNote = (entry, lang) => pick(NOTES, entry, lang);
const renderNotes = (list, lang) => (Array.isArray(list) ? list : []).map(e => renderNote(e, lang)).filter(Boolean);
const renderBasis = (entry, lang) => pick(BASIS, entry, lang);
const renderRounding = (entry, lang) => pick(ROUNDING, entry, lang);

/**
 * One recommendation with its three structured fields turned into sentences.
 *
 * Done at the service edge rather than in the engine, so the engine stays a
 * pure function with no opinion about who is reading — the same computation
 * feeds a Hebrew screen, an English CSV and a model prompt.
 */
function localize(rec, lang) {
  if (!rec) return rec;
  return {
    ...rec,
    notes: renderNotes(rec.notes, lang),
    velocityBasis: renderBasis(rec.velocityBasis, lang),
    orderQtyRounding: renderRounding(rec.orderQtyRounding, lang),
    // The code survives the rendering. A screen composing a sentence around
    // this needs to know WHICH case it is - "order 688, no rounding applied ->
    // 688 units" is a clause that should not be there at all - and asking it to
    // pattern-match the rendered text would put the words back in the client,
    // in one language, which is the whole thing this file exists to prevent.
    orderQtyRoundingCode: rec.orderQtyRounding?.code ?? null,
  };
}

module.exports = {
  NOTES, BASIS, ROUNDING,
  renderNote, renderNotes, renderBasis, renderRounding, localize,
};
