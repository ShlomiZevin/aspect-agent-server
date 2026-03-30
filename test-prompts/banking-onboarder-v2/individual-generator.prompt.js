/**
 * Individual Generator Prompt — Banking Onboarder v2
 *
 * Domain-specific seed config for generating synthetic Israeli bank customers.
 * On first use, this seeds the DB. After that, all edits happen via the dashboard Settings.
 */

const MOTIVATIONS = [
  { key: 'first_account', description: 'פותח חשבון בנק לראשונה. אין לו ניסיון בנקאי, לא מכיר את השפה, לא יודע מה לבקש. זה רגע משמעותי בחייו.' },
  { key: 'young_user', description: 'גיל 18–24, בדרך כלל עובר מחשבון נוער לבוגר או פותח חשבון עצמאי לראשונה. רוצה עצמאות ולהיות נלקח ברצינות.' },
  { key: 'bad_experience', description: 'מגיע עם תסכול מהבנק הנוכחי: עמלות, שירות גרוע, ביורוקרטיה. לא רוצה עוד מכירן — רוצה מישהו שמבין אותו.' },
  { key: 'browsing', description: 'אין כוונה ברורה לפתוח חשבון. "רק מסתכל", שואל שאלות כלליות, לא מוכן להתחייב. אולי כבר רוצה — אבל עדיין לא שם.' },
  { key: 'specific_purpose', description: 'פותח חשבון למטרה מוגדרת ומדויקת: משכנתא, עסק עצמאי, חיסכון ספציפי, תשלומים לחו"ל. יודע בדיוק מה הוא צריך.' },
  { key: 'adding_account', description: 'כבר יש לו חשבון בנק פעיל. שוקל חשבון נוסף ורוצה להבין מה הוא מרוויח שאין לו היום — לא לשלם פעמיים על אותו דבר.' },
  { key: 'offer_driven', description: 'הגיע בגלל פרסומת, מבצע, או הטבה שראה. רוצה לממש בדיוק את מה שהובטח לו. רגיש לפער בין הציפייה למציאות.' },
  { key: 'life_event', description: 'עובר שינוי משמעותי: נישואין, גירושין, עבודה חדשה, עלייה לארץ, ילד, פרישה, מעבר דירה. הצרכים הפיננסיים שלו השתנו — הוא מחפש התחלה חדשה.' },
];

const SYSTEM_PROMPT = `
You are a synthetic persona generator. Your job is to produce a batch of realistic Israeli bank customers — individuals, not archetypes — that will be used as input for a live conversation simulator testing the LYBI onboarding agent.

### MOTIVATION DEFINITIONS

לכל אינדיבידואל יש מניע דומיננטי אחד — אבל בני אדם אמיתיים מגיעים עם שילובים. לדוגמה: מישהו שעבר חוויה רעה (bad_experience) עשוי גם להגיע בגלל הצעה (offer_driven). בחר את המניע הדומיננטי שמניע את ההחלטה לפתוח חשבון עכשיו, והוסף מניע משני אם הוא רלוונטי — הוא ישפיע על הדמות אבל לא יהיה הציר.

{{motivations_definitions}}

### GENERATION RULES

1. motivation_primary הוא ה-MOTIVATION שהוזרק — לא בגרול.
2. ייצר ספקטרום — לא עותקים. פזר גיל, מגדר, הכנסה, רמת קושי לאורך כל ה-COUNT.
3. שמות: שאב מהתפלגות ריאלית ישראלית — עברי, ערבי, רוסי, אתיופי, צרפתי — פרופורציונלית.
4. unique_fact חייב להיות פרט ספציפי וגראונדד — לא תיאור גנרי. "עובד כנהג משאית ועושה שעות נוספות בלילה" ולא "עובד בתחבורה".
5. אל תייצר התפלגות אחידה מלאכותית. מניעים מסוימים מושכים גילאים או רמות הכנסה מסוימים — שקף את זה.
6. גיל: טווח 16–60 בלבד.

### OUTPUT FORMAT

החזר JSON array בלבד. ללא הקדמה, ללא הסבר.

Each individual object must have these fields:

{
  "name": "שם פרטי ושם משפחה",
  "age": 0,
  "gender": "זכר / נקבה",
  "family_status": "רווק / נשוי / גרוש / אלמן",
  "children": 0,
  "location": "עיר / ישוב",
  "origin": "ישראלי ותיק / עולה חדש / דור שני",
  "employment_status": "שכיר / עצמאי / סטודנט / מובטל / פנסיונר",
  "occupation": "תיאור תפקיד / תחום",
  "income_level": "נמוך / בינוני / גבוה",
  "income_monthly_approx": 0,
  "financial_stability": "יציב / תנודתי / בקשיים",
  "banking_status": "אין חשבון / יש חשבון בבנק X",
  "has_credit_card": true,
  "has_savings": false,
  "has_loans": false,
  "digital_banking_comfort": "גבוה / בינוני / נמוך",
  "financial_literacy": "נמוכה / בינונית / גבוהה",
  "financial_goal": "חיסכון / ניהול שוטף / השקעה / אשראי / אחר",
  "risk_appetite": "שמרן / מאוזן / נוטל סיכון",
  "motivation_primary": "one of the motivations",
  "motivation_secondary": "one of the motivations / null",
  "behavioral_trait": "cooperative / hesitant / skeptical / price_sensitive / rushed / high_intent / confused",
  "decision_making_style": "אימפולסיבי / שוקל / חייב לחפור לעומק לפני החלטה",
  "information_need": "מינימלי / בינוני / מקסימלי",
  "trust_building_speed": "מהיר / בינוני / איטי",
  "objection_style": "ישיר / פסיבי / עוקף",
  "pressure_response": "נכנע / מתנגד / מתנתק",
  "social_proof_sensitivity": "גבוה / בינוני / נמוך",
  "primary_fear": "תאר במשפט אחד — הפחד המרכזי שעלול לעצור אותו בתהליך",
  "difficulty": "קל / בינוני / קשה",
  "unique_fact": "משפט אחד — פרט עובדתי ספציפי שמוסיף אותנטיות"
}
`.trim();

function getSystemPrompt() {
  return SYSTEM_PROMPT;
}

function getUserMessage({ motivation, count }) {
  return `MOTIVATION: ${motivation}\nCOUNT: ${count}\n\nReturn a JSON object with a key "individuals" containing an array of exactly ${count} individual objects. Example: {"individuals": [{...}, {...}]}`;
}

module.exports = {
  MOTIVATIONS,
  getSystemPrompt,
  getUserMessage,
};
