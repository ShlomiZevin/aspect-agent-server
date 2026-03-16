/**
 * Banking Onboarder V2 - Welcome (Hebrew-lean prompt)
 *
 * Short, focused Hebrew guidance. Persona is shared and lean.
 * Handling principles and detailed content live in KB.
 */
const CrewMember = require('../../../crew/base/CrewMember');
const llmService = require('../../../services/llm');
const { getPersona } = require('../banking-onboarder-v2-persona.heb');

class WelcomeCrew extends CrewMember {
  constructor() {
    super({
      name: 'welcome',
      displayName: 'ברוכים הבאים',
      description: 'Warm introduction and eligibility qualification for bank account opening',
      isDefault: true,
      model: 'gemini-2.5-flash',
      maxTokens: 2048,
      persona: getPersona(),
      knowledgeBase: {
        enabled: true,
        sources: [
          { name: 'Onboarding KB' },
        ]
      },
      tools: [],
      fieldsToCollect: [
        { name: 'user_name', ditchIfCollected: true, description: "The user's name or preferred nickname for personal interaction" },
        { name: 'gender', allowedValues: ['male', 'female'], ditchIfCollected: true, description: "User's gender. Extract naturally from user response including typos. Do NOT infer from name alone." },
        { name: 'age', description: "User's age or date of birth to verify eligibility (must be 16+)" },
        { name: 'account_type', allowedValues: ['personal', 'business', 'joint', 'other'], description: "Type of account. Map: אישי/רגיל/פרטי → personal, עסקי → business, משותף → joint, else → other" },
        { name: 'service_consent', type: 'boolean', description: "User's consent to LYBI service terms. Any affirmative response = true (כן, רוצה, מסכים, בסדר, אישור, בוא נתחיל). Any refusal = false." }
      ],
      extractionMode: 'form',
      transitionTo: 'advisor',
    });
  }

  get guidance() {
    return `## התפקיד שלך
את בשלב הקבלה. קבלי את הלקוח בחום, אספי פרטים בסיסיים, והכיני אותו לתהליך פתיחת החשבון.

## הודעה ראשונה
הציגי את עצמך בקצרה — מי את, שאת כאן לעזור עם פתיחת חשבון בבנק דיסקונט, שאפשר לשאול שאלות לאורך הדרך, ושאפשר לעצור ולחזור בכל שלב. בקשי את שם הלקוח.

## מה לאסוף (שדה אחד בכל הודעה)
1. **שם** — בקשי בטבעיות
2. **הסכמה לתנאי שירות** — הסבירי בקצרה שהלקוח מסכים להשתמש בליבי כערוץ לפתיחת חשבון. בקשי כן או לא בהודעה אחת. אם שואל על ההסכמה — ענה מה-KB.
3. **גיל** — הסבירי בקצרה למה צריך. מתחת ל-16: הסבירי בחום שלא ניתן להמשיך.
4. **סוג חשבון** — אישי, עסקי, משותף או אחר. אם לא אישי: הסבירי בחום שכרגע התהליך מתאים לחשבון אישי.

## מצבים מיוחדים
- **לקוח שואל על עמלות או חשבונות לפני שהתחלתם** — נסי להסביר שהתשובה תלויה בפרופיל. אם מתעקש — סקירה כללית מה-KB, ציני שזה לא מותאם אישית.
- **סירוב להסכמה** — הסבירי בחום למה חייבים. הזדמנות נוספת אחת. עדיין מסרב — הציעי ערוצים חלופיים מה-KB וסיימי בחום.
- **הפניה לערוצים אחרים** — חפשי פרטים ב-KB (טלפון, כתובת, שעות) ותני מידע מעשי.

כשכל השדות נאספו — עברי בטבעיות ליועץ.`;
  }

  /**
   * Infer gender from user_name when extracted.
   */
  async onFieldsExtracted(newFields, allFields) {
    if (!newFields.user_name || allFields.gender) return {};

    try {
      const result = await llmService.sendOneShot(
        'You determine gender from Hebrew/English names. Respond with ONLY one word: male, female, or unknown. Nothing else.',
        `Name: ${newFields.user_name}`,
        { model: 'gpt-4o-mini', maxTokens: 16 }
      );
      const inferred = result.trim().toLowerCase();
      if (inferred === 'male' || inferred === 'female') {
        console.log(`   👤 Gender inferred from "${newFields.user_name}": ${inferred}`);
        return { gender: inferred };
      }
      console.log(`   👤 Gender unknown for "${newFields.user_name}", will ask user`);
    } catch (err) {
      console.error(`   ❌ Gender inference failed:`, err.message);
    }
    return {};
  }

  /**
   * Always re-extract service_consent so user can revoke after giving it.
   */
  getFieldsForExtraction(collectedFields) {
    return this.fieldsToCollect.filter(
      f => f.name === 'service_consent' || !collectedFields[f.name]
    );
  }

  /**
   * Inject gender note when known.
   */
  async getAdditionalContext(params) {
    const collectedFields = params.collectedFields || {};
    const notes = [];

    if (collectedFields.gender) {
      const form = collectedFields.gender === 'female' ? 'נקבה' : 'זכר';
      notes.push(`המגדר של הלקוח ${form}. פני אליו רק כ${form}. אל תשתמשי ברבים או בפניה מרובה כגון את/אתה.`);
    } else {
      if (collectedFields.user_name) {
        notes.push(`המגדר של הלקוח לא ידוע. שאלי: "רק שאלה קטנה לפני שממשיכים – איך נכון לפנות אליך, בלשון זכר או נקבה?"`);
      } else {
        notes.push(`המגדר של הלקוח לא ידוע. פני אליו בשפה ניטרלית או בצורה משולבת.`);
      }
    }
    if (collectedFields.user_name) {
      notes.push(`שם הלקוח: ${collectedFields.user_name}`);
    }

    return notes.length > 0 ? { promptNotes: notes.join('\n') } : {};
  }

  async preMessageTransfer(collectedFields) {
    if (!collectedFields.user_name || !collectedFields.age ||
        !collectedFields.account_type || !collectedFields.service_consent) {
      return false;
    }

    const age = parseInt(collectedFields.age, 10);
    if (isNaN(age) || age < 16) return false;

    if (collectedFields.account_type !== 'personal') return false;

    if (collectedFields.service_consent !== 'true') return false;

    await this.writeContext('onboarding_profile', {
      name: collectedFields.user_name,
      age,
      accountType: 'personal',
      startedAt: new Date().toISOString()
    }, true);

    console.log(`   ✅ Welcome complete: ${collectedFields.user_name}, age ${age}`);
    return true;
  }
}

module.exports = WelcomeCrew;
