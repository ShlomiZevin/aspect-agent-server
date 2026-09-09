/**
 * Sign-In — Aspect Module, kind 'app'.
 *
 * Who may use this client's surfaces and how they prove it. Access is always by
 * invitation — addresses are added ahead of time on the Access page — and this
 * module only decides two things on top of that:
 *
 *   methods  how a person proves the address is theirs: Google, a password, or either.
 *   purpose  whether the surface is closed until they do ('gate'), or stays open
 *            and sign-in just ties their chat history to an account so it follows
 *            them between devices ('sync').
 *
 * `purpose: sync` never widens access — a stranger still cannot sign in, the
 * chat is simply usable anonymously before anyone does.
 *
 * A module rather than a platform-wide setting because Shlomi flagged that the
 * customer may want a different mechanism, so a single baked-in answer was never
 * safe.
 *
 * APP module: it owns no customer data, has nothing to audit and nothing to
 * build, so it declares none of the data hooks — enabling it IS the
 * installation. CLIENT scope: the things that want it are agents, not datasets.
 *
 * No chatTools and no manifestFragment on purpose: who may log in is not
 * something a chat agent should be able to answer questions about.
 */
module.exports = {
  id: 'google-auth',
  kind: 'app',
  scope: 'client',
  name: { en: 'Sign-In', he: 'התחברות' },
  version: 1,

  settingsSchema: [
    {
      key: 'purpose',
      type: 'select',
      required: false,
      default: 'gate',
      options: [
        { value: 'gate', label: { en: 'Require sign-in to use the agent', he: 'חייב התחברות כדי להשתמש בסוכן' } },
        { value: 'sync', label: { en: 'Optional — sign in to sync chat history across devices', he: 'רשות — התחברות לסנכרון היסטוריית שיחות בין מכשירים' } },
      ],
      label: { en: 'When people sign in', he: 'מתי מתחברים' },
      hint: {
        en: 'Require closes the agent until an invited person signs in. Optional '
          + 'leaves it open for anonymous use and adds a "sign in" button — '
          + 'signing in moves the current chats onto the account and the same '
          + 'history then follows the person to any other device. Either way, only '
          + 'addresses added on the Access page can sign in.',
        he: 'חובה חוסם את הסוכן עד שאדם מוזמן מתחבר. רשות משאיר אותו פתוח לשימוש '
          + 'אנונימי ומוסיף כפתור "התחברות" — ההתחברות מעבירה את השיחות הנוכחיות '
          + 'לחשבון, ואותה היסטוריה נמשכת לכל מכשיר אחר. כך או כך, רק כתובות '
          + 'שנוספו בעמוד ההרשאות יכולות להתחבר.',
      },
    },
    {
      key: 'methods',
      type: 'select',
      required: false,
      default: 'both',
      options: [
        { value: 'both', label: { en: 'Google or password', he: 'Google או סיסמה' } },
        { value: 'google', label: { en: 'Google only', he: 'Google בלבד' } },
        { value: 'password', label: { en: 'Password only', he: 'סיסמה בלבד' } },
      ],
      label: { en: 'How people sign in', he: 'איך מתחברים' },
      hint: {
        en: 'Google only is the strongest: there is no password to leak or reuse. '
          + 'Password only is for people whose organisation has no Google account.',
        he: 'Google בלבד היא האפשרות החזקה ביותר: אין סיסמה שתדלוף. סיסמה בלבד '
          + 'מיועדת למי שאין לו חשבון Google בארגון.',
      },
    },
  ],

  // Nothing to initialize and no nightly build, so neither event can fire.
  notificationEvents: [],
};
