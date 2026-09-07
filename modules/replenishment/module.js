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

  // The ID is the durable key: it is in `client_modules` rows, in the stored
  // binding, in the chat tool's name and in every run this module has logged.
  // The NAME is what the client reads, and the redesign renames it Procurement
  // — the app on the Apps page, with Purchase as the section inside it.
  // Renaming the id to match would buy nothing and cost a migration over live
  // rows, so the two deliberately differ.
  name: { en: 'Procurement', he: 'רכש' },

  // The Apps shelf: the icon grid of business apps running on the client's own
  // data. This is what makes the Apps tab appear for a dataset at all.
  group: 'apps',
  icon: 'procurement',
  blurb: {
    en: 'Order recommendations per supplier — how much to order, when to send it and what it costs.',
    he: 'המלצות הזמנה לכל ספק — כמה להזמין, מתי לשלוח וכמה זה עולה.',
  },

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
      // NOTE THE NAME COLLISION, which the plan's settings table specifies:
      // the descriptor's own `notificationEvents` (below) is the list of
      // events this module CAN emit; this SETTING is the per-event on/off
      // map an admin edits. They are different things with the same name.
      //
      // It was missing at first, and saveSettings correctly dropped it as an
      // unknown key — so the toggles in the admin mockup could never actually
      // switch anything off. A guard doing its job is not the same as the
      // feature working.
      key: 'notificationEvents', type: 'event_toggles', required: false,
      label: { en: 'Notify on', he: 'שלח התראה על' },
      hint: {
        en: 'Which events send a notification. All on unless switched off.',
        he: 'על אילו אירועים תישלח התראה. הכול דלוק אלא אם כובה.',
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
    // ── Procurement Groups + Smart Tune (spec sections 3.1/3.4/3.7) ──
    {
      key: 'paceModel', type: 'select', required: false, default: 'simple',
      options: ['simple', 'weighted_seasonal'],
      label: { en: 'Sales-pace model', he: 'מודל קצב המכירות' },
      hint: {
        en: '"weighted_seasonal" doubles the last 60 days and adjusts by each item\'s own prior-year season. Applies only once the views carry the inputs; every row states the model that actually ran.',
        he: '"weighted_seasonal" מכפיל את משקל 60 הימים האחרונים ומתאם לעונת השנה הקודמת של הפריט. כל שורה מציינת את המודל שרץ בפועל.',
      },
    },
    {
      key: 'paceFadingRatio', type: 'number', required: false, default: 0.5,
      label: { en: 'Fading threshold (28d vs 90d pace)', he: 'סף דעיכה (קצב 28 מול 90 יום)' },
      hint: {
        en: 'Below this ratio an item is grouped as Fading — its recent pace collapsed versus the 90-day average.',
        he: 'מתחת ליחס זה פריט מסווג כדועך — הקצב האחרון קרס מול ממוצע 90 הימים.',
      },
    },
    {
      key: 'seasonalMinUnits', type: 'number', required: false, default: 200,
      label: { en: 'Seasonality: minimum prior-year units', he: 'עונתיות: מינימום יחידות בשנה קודמת' },
      hint: {
        en: 'Below this, an item has too little prior-year history for the seasonal index to apply.',
        he: 'מתחת לכך אין מספיק היסטוריה משנה קודמת להפעלת מדד עונתי.',
      },
    },
    {
      key: 'seasonalLowShare', type: 'number', required: false, default: 0.5,
      label: { en: 'Out-of-season threshold (vs uniform)', he: 'סף מחוץ לעונה (מול אחיד)' },
      hint: {
        en: 'An item whose coming-90-days share last year was below this fraction of the uniform share is grouped Out of season.',
        he: 'פריט שחלקו בשנה שעברה ב-90 הימים הקרובים היה מתחת לשיעור זה מהחלק האחיד מסווג מחוץ לעונה.',
      },
    },
    {
      key: 'staleOnOrderDays', type: 'number', required: false, default: 180,
      label: { en: 'Open order counts as stale after (days)', he: 'הזמנה פתוחה נחשבת ישנה אחרי (ימים)' },
      hint: {
        en: 'An item with an open purchase order older than this is grouped as Needs checking.',
        he: 'פריט עם הזמנת רכש פתוחה ישנה מכך מסווג כדורש בדיקה.',
      },
    },
    {
      key: 'absentStockMeansZero', type: 'boolean', required: false, default: true,
      label: { en: 'Absent from stock file means zero', he: 'היעדר מקובץ המלאי פירושו אפס' },
      hint: {
        en: 'The client\'s answer switch: true = the warehouse export is complete, absence is truly zero. False routes selling items missing from the file to Needs checking.',
        he: 'מתג התשובה של הלקוח: אמת = קובץ המחסן מלא והיעדר הוא אפס אמיתי. שקר מעביר פריטים נמכרים שחסרים בקובץ לדורש בדיקה.',
      },
    },
    {
      key: 'clientCanAssignGroups', type: 'boolean', required: false, default: true,
      label: { en: 'Let the client move items between groups', he: 'לאפשר ללקוח להעביר פריטים בין קבוצות' },
      hint: {
        en: 'On by default — the buyer\'s verdicts are the correction layer for the classifier, and they run Smart Tune.',
        he: 'דלוק כברירת מחדל — הכרעות הקניין הן שכבת התיקון של הסיווג.',
      },
    },
    {
      key: 'proposalMaxItems', type: 'number', required: false, default: 1000,
      label: { en: 'Smart Tune: max items per change', he: 'כוונון חכם: מקסימום פריטים לשינוי' },
      hint: {
        en: 'The largest bulk change one previewed proposal may carry.',
        he: 'השינוי המרבי שהצעה אחת עם תצוגה מקדימה יכולה לשאת.',
      },
    },
    {
      key: 'proposalExpiryHours', type: 'number', required: false, default: 24,
      label: { en: 'Smart Tune: preview valid for (hours)', he: 'כוונון חכם: תוקף תצוגה מקדימה (שעות)' },
      hint: {
        en: 'How long a previewed change stays executable before it must be asked again.',
        he: 'כמה זמן שינוי שהוצג נשאר ניתן לביצוע לפני שיש לבקש שוב.',
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

    /**
     * The crew tool — structured args, never generated SQL, so the same
     * question asked five ways returns identical numbers.
     *
     * Returned only when the caller has already established the module is
     * live; the crew asks for tools through moduleService, which filters.
     */
    chatTools(ctx) {
      return [require('./chat-tool').buildTool(ctx.datasetId)];
    },

    /**
     * Scoped chat sessions this module offers (Smart Tune). A scoped turn's
     * tool set comes from HERE ONLY — the dataset's general SQL tool is
     * deliberately absent, which is the isolation guarantee: this chat can
     * discuss only what the module knows.
     */
    chatScopes(ctx) {
      return [{
        scopeId: 'tune',
        title: { en: 'Smart Tune', he: 'כוונון חכם' },
        tools: (tctx) => [
          require('./chat-tool').buildTool(tctx.datasetId),
          require('./tune-tools').buildProposeTool(tctx.datasetId, {
            settings: tctx.settings,
            conversationId: tctx.conversationId,
            scopeContext: tctx.context,
          }),
        ],
        // D8: ask-AND-act, the model decides per message; the action appears
        // only when the user asked for one (that is when the proposal tool is
        // called); ambiguity gets words, not proposals.
        promptFragment: (context) => {
          const group = context.group || 'order_now';
          const count = context.itemCount != null ? ` (${context.itemCount} items)` : '';
          return 'This conversation is the SMART TUNE panel of the Procurement screen, '
            + `opened on the group "${group}"${count}. You have exactly two tools.\n`
            + '1. READ questions ("how many…", "which items…") → answer with '
            + 'fetch_replenishment. Default the scope to this panel\'s group '
            + `(currentGroup-equivalent filters) unless the user widens it.\n`
            + '2. CHANGE requests ("move…", "reject…", "park…", "reclassify…") → answer '
            + 'AND call propose_group_change. Present its preview and interpretation; the '
            + 'user applies it with the Process button — NEVER say items were moved.\n'
            + '3. AMBIGUOUS ("these look wrong") → answer, and offer the move in words '
            + 'without proposing.\n'
            + 'RESOLUTION for a change — match the filter to the user\'s vocabulary: '
            + 'a department/category/supplier → its exact label as delivered; a product '
            + 'kind named by words ("the umbrellas") → the name filter, which matches '
            + 'word starts only and is safe for this; an explicit SKU list only when the '
            + 'user pasted one or you resolved the set COMPLETELY — never hand-built '
            + 'from a paged read result, which silently drops everything beyond the '
            + 'page. Verify the filter with the READ tool (its scoped TOTAL is the '
            + 'whole set, not the page), then call propose_group_change ONCE per user '
            + 'request — proposing is the commit, not the exploration, and a new '
            + 'proposal cancels this conversation\'s previous open one.\n'
            + 'Never refuse because of vocabulary — map it to the tools\' filters '
            + '(name text, category, supplier, SKU list). Mirror the user\'s language; '
            + 'Hebrew in the data says nothing about the language to answer in. '
            + 'Carry every data-contract caveat the tools return.';
        },
      }];
    },

    /**
     * Additions to the dataset's capability manifest.
     *
     * NOTE ON WHAT IS AND IS NOT HERE. The truths about the FEED — that no
     * goods receipt exists, that a delivery time can only be configured
     * rather than measured — are properties of the client's data and hold
     * whether or not this module is switched on. Those live permanently in
     * services/dataset-manifest/zolstock.manifest.js, not here, because a
     * refusal that only appears when a module happens to be enabled is not
     * an honesty layer.
     *
     * What IS here is what only exists BECAUSE the module exists: the two
     * derived measures and the vocabulary for them.
     */
    manifestFragment() {
      return {
        measures: {
          'replenishment need / order quantity': {
            fidelity: 'estimate',
            basis: 'computed from sales pace, stock, open orders and a CONFIGURED supplier delivery time — not a figure from the source system',
          },
          'estimated order cost': {
            fidelity: 'estimate',
            basis: 'order quantity x catalogue cost, excluding VAT and before discounts',
          },
        },
        dimensions: {
          'supplier lead time': {
            // A status the base manifest vocabulary does not have: the value
            // is real and used, but a human supplied it — it was not measured
            // from the data and cannot be.
            status: 'configured',
            detail: 'user-supplied per supplier, with a dataset default for any not set. Every answer states which was used.',
          },
        },
        vocabulary: [
          { terms: ['זמן אספקה', 'לי טיים', 'lead time', 'delivery time'], resolution: 'field',
            detail: 'configured per supplier on the Procurement screen; not derivable from the data' },
          { terms: ['נקודת הזמנה', 'reorder point'], resolution: 'field',
            detail: 'computed: sales pace x delivery time + safety stock' },
          { terms: ['מלאי ביטחון', 'safety stock'], resolution: 'field',
            detail: 'items.safety_stock where present (5% of items); otherwise computed from sales pace' },
          { terms: ['הזמנה פתוחה', 'open order', 'on order'], resolution: 'field',
            detail: 'purchase_order rows — but with no goods-receipt data an old order still looks open' },
        ],
      };
    },
  },
};
