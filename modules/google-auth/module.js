/**
 * Sign-In — Aspect Module, kind 'app'.
 *
 * Who may use this client's surfaces, and how they prove it. Two ways in:
 * Google, or an email and a password. Which of them this client accepts is the
 * module's only setting.
 *
 * A module rather than a platform-wide setting because Shlomi flagged that the
 * customer may want a different mechanism, so "everyone signs in with Google"
 * was never a safe assumption to bake in.
 *
 * APP module: it owns no customer data, has nothing to audit and nothing to
 * build, so it declares none of the data hooks. Enabling it IS the installation.
 * CLIENT scope: the clients that want it are agents, not datasets.
 *
 * No chatTools and no manifestFragment on purpose. Who may log in is not
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
        { value: 'gate', label: { en: 'Gate access — only invited emails may in', he: 'שער כניסה — רק כתובות שהוזמנו' } },
        { value: 'sync', label: { en: 'Save history — anyone may sign in to sync their chats across devices', he: 'שמירת היסטוריה — כל אחד יכול להתחבר ולסנכרן שיחות בין מכשירים' } },
      ],
      label: { en: 'What signing in is for', he: 'למה משמשת ההתחברות' },
      hint: {
        en: 'Gate keeps the surface closed until an invited person signs in. '
          + 'Save history leaves the chat open to everyone and only adds an optional '
          + '"sign in" button — signing in attaches the current chats to the account '
          + 'and the same history follows the person to any other device.',
        he: 'שער חוסם את המסך עד שאדם מוזמן מתחבר. שמירת היסטוריה משאירה את הצ׳אט '
          + 'פתוח לכולם ומוסיפה כפתור "התחברות" לא-חובה — ההתחברות מצמידה את השיחות '
          + 'הנוכחיות לחשבון, ואותה היסטוריה נמשכת לכל מכשיר אחר.',
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
