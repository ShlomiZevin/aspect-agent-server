/**
 * Smart Replenishment — the module descriptor.
 *
 * This file IS the contract: the admin tab, the init pipeline, the nightly
 * build and the chat integration all read from it, so a second module means
 * writing one of these and nothing else.
 *
 * See tasks/pending/aspect-modules.md section 07 for the settings table and
 * the binding contract this implements.
 */

const { audit } = require('./audit');
const { proposeBinding } = require('./propose-binding');
const { renderInfra } = require('./render-infra');
const { verify } = require('./verify');

module.exports = {
  id: 'replenishment',
  name: { en: 'Smart Replenishment', he: 'חידוש מלאי חכם' },
  version: 1,

  settingsSchema: [
    {
      key: 'defaultLeadTimeDays', type: 'number', required: true, default: 90,
      label: { en: 'Default delivery time (days)', he: 'זמן אספקה ברירת מחדל (ימים)' },
      hint: {
        en: 'Used for any supplier whose real delivery time has not been set. Every recommendation says which it used.',
        he: 'משמש לכל ספק שלא הוגדר לו זמן אספקה אמיתי. כל המלצה מציינת באיזה ערך השתמשה.',
      },
    },
    {
      key: 'defaultReviewDays', type: 'number', required: true, default: 30,
      label: { en: 'Review cycle (days)', he: 'מחזור הזמנה (ימים)' },
      hint: {
        en: 'How long an order must cover beyond the delivery time — usually the gap between two orders to the same supplier.',
        he: 'לכמה זמן ההזמנה צריכה להספיק מעבר לזמן האספקה — בדרך כלל המרווח בין שתי הזמנות לאותו ספק.',
      },
    },
    {
      key: 'defaultSafetyDays', type: 'number', required: true, default: 14,
      label: { en: 'Safety buffer (days of sales)', he: 'מלאי ביטחון (ימי מכירה)' },
      hint: {
        en: 'Used only where the catalogue has no safety stock of its own. Rows say when this was computed rather than given.',
        he: 'משמש רק כשאין מלאי ביטחון בקטלוג. השורות מציינות מתי הערך חושב ולא התקבל מהמערכת.',
      },
    },
    {
      key: 'velocityWindowDays', type: 'number', required: true, default: 90,
      label: { en: 'Sales pace window (days)', he: 'חלון קצב מכירות (ימים)' },
      hint: {
        en: 'Prepared windows are 28, 90 and 365 days; another value uses the nearest and says so.',
        he: 'החלונות המוכנים הם 28, 90 ו-365 ימים; ערך אחר ישתמש בקרוב ביותר ויציין זאת.',
      },
    },
    {
      key: 'initModel', type: 'model', required: true, default: 'claude-sonnet-4-6',
      label: { en: 'Model used to map your data', he: 'מודל למיפוי הנתונים' },
      hint: {
        en: 'Used once, during setup, to map your columns onto the replenishment model. It never computes a recommendation.',
        he: 'משמש פעם אחת בהתקנה, כדי למפות את העמודות שלכם. הוא לעולם לא מחשב המלצה.',
      },
    },
    {
      key: 'notificationEmails', type: 'emails', required: true,
      label: { en: 'Notification emails', he: 'כתובות למשלוח התראות' },
      hint: {
        en: 'Who is told when setup or a nightly rebuild fails.',
        he: 'למי נודע כשההתקנה או הבנייה הלילית נכשלת.',
      },
    },
    {
      key: 'horizonDays', type: 'number', required: false, default: 14,
      label: { en: '"Due soon" window (days)', he: 'חלון "בקרוב" (ימים)' },
      hint: {
        en: 'How far ahead an order still counts as due soon rather than fine.',
        he: 'עד כמה קדימה הזמנה נחשבת "בקרוב" ולא "תקין".',
      },
    },
    {
      key: 'includeStoreStock', type: 'boolean', required: false, default: false,
      label: { en: 'Count branch stock as available', he: 'לספור מלאי סניפים כזמין' },
      hint: {
        en: 'Off by default: stock sitting in branches is usually not available to fulfil central demand.',
        he: 'כבוי כברירת מחדל: מלאי שיושב בסניפים בדרך כלל אינו זמין לביקוש מרכזי.',
      },
    },
    {
      key: 'minOrderUnits', type: 'number', required: false,
      label: { en: 'Minimum order (units)', he: 'הזמנת מינימום (יחידות)' },
      hint: {
        en: 'Raises a real order to this size. Never creates an order that was not needed.',
        he: 'מעלה הזמנה קיימת לגודל הזה. לעולם לא יוצר הזמנה שלא נדרשה.',
      },
    },
    {
      key: 'cartonRounding', type: 'boolean', required: false, default: true,
      label: { en: 'Round up to full cartons', he: 'לעגל לארגז שלם' },
      hint: {
        en: 'Where the catalogue knows the carton size. Rows say when it does not.',
        he: 'במקרים שגודל האריזה ידוע בקטלוג. השורות מציינות כשלא.',
      },
    },
    {
      key: 'clientCanEditLeadTimes', type: 'boolean', required: false, default: true,
      label: { en: 'Let the client set delivery times', he: 'לאפשר ללקוח להגדיר זמני אספקה' },
      hint: {
        en: 'On by default — the buyer owns lead times and is the person who knows them.',
        he: 'דלוק כברירת מחדל — הקניין הוא שמכיר את זמני האספקה.',
      },
    },
    {
      key: 'alertEmails', type: 'emails', required: false,
      label: { en: 'Business alert emails (future)', he: 'התראות עסקיות (עתידי)' },
      hint: {
        en: 'Stored now for the proactive-alerts phase. Nothing is sent today.',
        he: 'נשמר עבור שלב ההתראות היזומות. כרגע לא נשלח דבר.',
      },
    },
  ],

  notificationEvents: ['init_completed', 'init_failed', 'nightly_build_failed', 'verification_degraded'],

  hooks: {
    audit,
    proposeBinding,

    // The SAME binding renders for a scratch schema during init and a shadow
    // schema during the nightly reload — the target is passed in, never
    // baked into the binding, which is why the stored binding stays valid
    // across both paths without modification.
    renderInfra(binding, schema) {
      if (!schema) throw new Error('replenishment.renderInfra: a target schema is required');
      return renderInfra(schema, binding);
    },

    verify,

    async nightlyBuild(ctx) {
      // The nightly path is the same deterministic render as init — the
      // binding is the durable state and the views are rebuilt from it. E1
      // wires this into reload phase 2, against the SHADOW schema.
      const statements = renderInfra(ctx.schemaName, ctx.binding);
      return { statements };
    },

    // Wired in D3. Off until then, and off entirely whenever the module is
    // not enabled+ready — that is what keeps a dataset without this module
    // byte-identical to today.
    chatTools() { return []; },
    manifestFragment() { return null; },
  },
};
