/**
 * Task Board — Aspect Module, kind 'app'.
 *
 * Makes the board at `/aspect-tasks` switchable per client instead of being on
 * for everyone who knows the URL. That is the whole job of this file: the board
 * itself lives in `taskboard/`, owns `aspect_tasks_db`, and does not import
 * anything from here.
 *
 * It is an APP module, not a data one. It has no customer schema to audit, no
 * columns for an LLM to map, no DDL to render and nothing to verify — so it
 * declares none of the seven data hooks, and `modules/registry.js` does not ask
 * for them. Enabling it is the entire installation.
 *
 * It is CLIENT-scoped, not dataset-scoped. Aspect and LYBI are clients with no
 * customer schema, and they are exactly who this is for; a dataset-scoped module
 * could not attach to either.
 *
 * Deliberately absent, and worth knowing why:
 *
 *   chatTools / manifestFragment — a data module contributes a tool and a
 *   prompt fragment so the agent can answer from it. This one must not: task
 *   notes are internal, and putting them in front of a client's chat agent is
 *   precisely the leak the separate database exists to prevent.
 *
 *   nightlyBuild — nothing to rebuild. Its storage is its own and survives a
 *   dataset reload because it is not in the dataset's database at all, which is
 *   the trap the Replenishment views hit (OID-bound views die at the swap).
 */
module.exports = {
  id: 'taskboard',
  kind: 'app',
  scope: 'client',
  name: { en: 'Task Board', he: 'לוח משימות' },
  version: 1,

  settingsSchema: [
    {
      key: 'boardName',
      type: 'text',
      required: false,
      default: 'Tasks',
      label: { en: 'Board name', he: 'שם הלוח' },
      hint: {
        en: 'Shown in the board header. Useful when more than one client has one.',
        he: 'מוצג בכותרת הלוח. שימושי כשיש לוח ליותר מלקוח אחד.',
      },
    },
    {
      key: 'allowGuestNames',
      type: 'boolean',
      required: false,
      default: true,
      label: { en: 'Anyone may type their own name', he: 'כל אחד יכול להקליד את שמו' },
      hint: {
        en: 'Off restricts assignment and comments to the roster. There are no '
          + 'accounts yet, so this is a convention rather than a guarantee.',
        he: 'כיבוי מגביל שיוך ותגובות לרשימת האנשים. אין עדיין חשבונות, ולכן זו '
          + 'מוסכמה ולא הבטחה.',
      },
    },
  ],

  // No init and no nightly build, so neither of those events can ever fire.
  notificationEvents: [],
};
