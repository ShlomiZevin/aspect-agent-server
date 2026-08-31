/**
 * Google Sign-In — Aspect Module, kind 'app'.
 *
 * Who may use this client's surfaces, and how they prove it. Switched on per
 * client: the server accepts a verified Google identity for a client that has
 * it, and for no other.
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
  ],

  // Nothing to initialize and no nightly build, so neither event can fire.
  notificationEvents: [],
};
