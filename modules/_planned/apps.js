/**
 * Apps that are announced but not built yet.
 *
 * The Apps page shows four icons; one of them works. The other three are real
 * plans with real names, and the design shows them greyed out as "Coming soon"
 * — which is a promise to the client, so the platform should hold the list
 * rather than the page hardcoding it. When Warehouse is built it becomes a
 * normal descriptor in registry.js and disappears from here; nothing else has
 * to change.
 *
 * These are NOT descriptors. A descriptor is something the platform knows how
 * to install, and enabling one of these would install nothing. Keeping them in
 * a separate list means `registry.all()` stays the honest answer to "what can
 * actually run", and no operator can switch on an empty module by mistake.
 *
 * `icon` names a shape the client draws. The names are the design's, not
 * free-form: the client maps exactly these four and would rather fail loudly
 * than render a blank square.
 */
const PLANNED_APPS = [
  {
    id: 'warehouse',
    icon: 'warehouse',
    name: { en: 'Warehouse', he: 'מחסן' },
    blurb: {
      en: 'Space planning and slow-mover alerts for the central warehouse — what to move, return or discount.',
      he: 'תכנון מקום והתראות על מוצרים איטיים במחסן המרכזי — מה להזיז, להחזיר או להוזיל.',
    },
  },
  {
    id: 'branches',
    icon: 'branches',
    name: { en: 'Branches', he: 'סניפים' },
    blurb: {
      en: 'Per-branch replenishment — which branch needs which products moved from the warehouse, and when.',
      he: 'חידוש מלאי לכל סניף — לאיזה סניף להעביר אילו מוצרים מהמחסן, ומתי.',
    },
  },
  {
    id: 'pricing',
    icon: 'pricing',
    name: { en: 'Pricing', he: 'תמחור' },
    blurb: {
      en: 'Margin watch and price recommendations.',
      he: 'מעקב רווחיות והמלצות מחיר.',
    },
  },
];

module.exports = { PLANNED_APPS };
