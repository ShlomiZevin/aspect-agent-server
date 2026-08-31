/**
 * Google Sign-In — Aspect Module, kind 'app'.
 *
 * Makes Google authentication switchable per client. Where it is off, the login
 * page is exactly what it is today: a name and a phone number. Where it is on,
 * a Google button appears beside that and the server will accept a verified
 * Google identity for this client and no other.
 *
 * A module rather than a platform-wide setting because Shlomi flagged that the
 * customer may want a different mechanism — so "everyone signs in with Google"
 * was never a safe assumption to bake in. It also means turning it on for one
 * client cannot change how anyone else logs in.
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
  name: { en: 'Google Sign-In', he: 'התחברות עם Google' },
  version: 1,

  settingsSchema: [
    {
      key: 'allowedDomain',
      type: 'text',
      required: false,
      default: '',
      label: { en: 'Auto-approve this email domain', he: 'אישור אוטומטי לדומיין' },
      hint: {
        en: 'Anyone signing in with an address at this domain is let in without '
          + 'being invited first — e.g. "acme.co.il". Leave empty to require an '
          + 'invitation for every person.',
        he: 'כל מי שמתחבר עם כתובת בדומיין הזה ייכנס בלי הזמנה מראש — למשל '
          + '"acme.co.il". השאירו ריק כדי לדרוש הזמנה לכל אדם.',
      },
    },
    {
      key: 'allowPasswordlessFallback',
      type: 'boolean',
      required: false,
      default: true,
      label: { en: 'Keep the name and phone login', he: 'להשאיר כניסה עם שם וטלפון' },
      hint: {
        en: 'On, both ways in are offered. Off, Google is the only way — which '
          + 'locks out anyone who has not been invited yet, so turn it off only '
          + 'once the invitations are in place.',
        he: 'כשמופעל, שתי הדרכים זמינות. כשכבוי, Google היא הדרך היחידה — מה '
          + 'שחוסם כל מי שטרם הוזמן, אז כבו רק אחרי שההזמנות מוכנות.',
      },
    },
  ],

  // Nothing to initialize and no nightly build, so neither event can fire.
  notificationEvents: [],
};
