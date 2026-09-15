/**
 * Otto — the screen builder, as registry module #2.
 *
 * Enabling Otto for a client is what lets that client's users build custom
 * screens; the init pipeline's LLM pass builds Otto's *dataset brief* (his
 * entire knowledge of the client's data) and stores it as this module's
 * `binding`. Everything Otto can discuss, plan or query for a client flows
 * from that brief — see otto/services/brief.service.js and
 * docs/features/otto.md.
 *
 * NOT in the 'apps' group on purpose: Otto is the builder, not a shelf tile
 * of its own. The Apps shelf learns about him through
 * modules/services/apps.service.js (`canCreate`), which is also what makes
 * the "New screen" tile appear.
 *
 * The feature's services live in otto/ (the feature folder, like bi/ and
 * insights/); this descriptor is deliberately thin — it is the contract the
 * admin tab, init pipeline and nightly hook read, nothing more.
 */

const brief = require('../../otto/services/brief.service');

module.exports = {
  id: 'otto',
  name: { en: 'Otto — screen builder', he: 'אוטו — בונה המסכים' },
  version: 1,

  settingsSchema: [
    {
      key: 'initModel', type: 'model', required: true, default: 'claude-sonnet-5',
      label: { en: 'Model used to learn your data', he: 'מודל ללימוד הנתונים' },
      hint: {
        en: 'Used once, when Otto is turned on, to build his brief of your data. It never builds a screen.',
        he: 'משמש פעם אחת, בהפעלה, לבניית היכרות של אוטו עם הנתונים. הוא לעולם לא בונה מסך.',
      },
    },
    {
      key: 'talkModel', type: 'model', required: true, default: 'claude-sonnet-5',
      label: { en: 'Conversation model', he: 'מודל השיחה' },
      hint: {
        en: 'Runs the chat and drafts the plan — fast and cheap, many turns.',
        he: 'מריץ את השיחה ומנסח את התוכנית — מהיר וזול, הרבה תורות.',
      },
    },
    {
      key: 'buildModel', type: 'model', required: true, default: 'claude-opus-5',
      label: { en: 'Screen build model', he: 'מודל בניית המסך' },
      hint: {
        en: 'Composes the screen from the approved plan. One call per build; quality is the deliverable.',
        he: 'מרכיב את המסך מהתוכנית המאושרת. קריאה אחת לבנייה; האיכות היא התוצר.',
      },
    },
    {
      // OPTIONAL, unlike replenishment's: Otto only emits init events and
      // delivery is still the mocked outbox — requiring an address for a
      // channel that sends nothing blocked the first init attempt for
      // ceremony (owner, 2026-09-15).
      key: 'notificationEmails', type: 'emails', required: false,
      label: { en: 'Notification emails', he: 'כתובות למשלוח התראות' },
      hint: {
        en: 'Who is told when setup fails. Optional while delivery is mocked.',
        he: 'למי נודע כשההתקנה נכשלת. אופציונלי כל עוד המשלוח מדומה.',
      },
    },
    {
      key: 'notificationEvents', type: 'event_toggles', required: false,
      label: { en: 'Notify on', he: 'שלח התראה על' },
      hint: {
        en: 'Which events send a notification. All on unless switched off.',
        he: 'על אילו אירועים תישלח התראה. הכול דלוק אלא אם כובה.',
      },
    },
  ],

  notificationEvents: ['init_completed', 'init_failed'],

  hooks: {
    audit: brief.audit,
    proposeBinding: brief.proposeBrief,

    // Otto renders no per-dataset DDL: screens read through compiled queries
    // against the dataset's existing views, and their results are cached, not
    // materialized. Empty DDL also means init needs no scratch schema — the
    // orchestrator skips the build step and verify probes the LIVE schema,
    // which is exactly what the brief should be checked against.
    renderInfra() { return []; },

    verify: brief.verify,

    // Nothing to rebuild nightly — the screen-data cache is keyed by the
    // reload's own completion stamp (otto/services/data.service.js), so a
    // fresh import invalidates it without any hook work here.
    async nightlyBuild() { return { statements: [] }; },

    // Otto owns no crew tools and adds nothing to the manifest: his surface
    // is the builder page, not the chat.
    chatTools() { return []; },
    manifestFragment() { return {}; },
  },
};
