/**
 * Synthetic dataset for the real-estate developer demo ("אופק יזמות", a
 * fictional residential developer selling apartments off-plan).
 *
 * Like the TechZone demo (scripts/seed-aspect-synthetic.js) there is no client
 * feed: this CREATEs the `realestate` schema and fills it with generated data —
 * 5 projects, ~500 apartments, ~9k leads with buyer profiles, their sales
 * activity, campaigns and signed deals, January 2025 to today.
 *
 * The data is generated from a model of the business, not sampled at random,
 * so the demo has real findings to discover (each one is visible only in the
 * data — nothing is labelled):
 *   - fairs, launch evenings and referrals bring few leads but convert several
 *     times better than Facebook / Instagram, so their cost per deal is lowest;
 *   - leads answered within the hour convert far better than next-day ones —
 *     and Haifa's conversion fell when its slow rep took over in May 2026;
 *   - one rep gives roughly 2.5x the company's average discount;
 *   - Haifa's 5-room north-facing units were priced ~14% too high and sit unsold;
 *   - each buyer segment closes best on a different benefit (20/80 for first
 *     homes, a price cut for investors, parking for parents buying for their
 *     children), while the benefits are offered at random today;
 *   - "buying for the children" is a growing share of leads.
 *
 * Safe to re-run: DROPs and recreates the schema each time.
 *
 * Usage (through the Cloud SQL Proxy, customer-data DB):
 *   node scripts/seed-realestate-synthetic.js
 *   node scripts/seed-realestate-synthetic.js --dry          # generate only, print the findings, no DB
 *   node scripts/seed-realestate-synthetic.js --views-only   # recreate only the views, no data touched
 */

require('dotenv').config();
const DRY_RUN = process.argv.includes('--dry');
const VIEWS_ONLY = process.argv.includes('--views-only');
const { getPool } = DRY_RUN ? { getPool: null } : require('../services/db.realestate');

const S = 'realestate';

// Deterministic PRNG (mulberry32), same as the TechZone generator.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261124);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const randFloat = (min, max) => min + rand() * (max - min);
const chance = (p) => rand() < p;
/** Picks a key of `weights` ({key: weight}) proportionally. */
function weighted(weights) {
  const entries = Object.entries(weights);
  let r = rand() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return entries[entries.length - 1][0];
}
/** Log-normal around a median, for response times. */
const lognormal = (median, sigma) => median * Math.exp(sigma * Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand()));

const DAY = 86400000;
const END_DATE = new Date();
END_DATE.setHours(12, 0, 0, 0); // midday, so toISOString() never slips a day across UTC
const START_DATE = new Date('2025-01-01T12:00:00');
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const daysBetween = (a, b) => Math.round((b - a) / DAY);

// ── Projects ────────────────────────────────────────────────────────────────
// sqmPrice = list price per built sqm at marketing start (₪).
const PROJECTS = [
  { project_id: 1, project_name: 'אופק פארק', city: 'ראשון לציון', region: 'מרכז', start: '2025-01-12', delivery: '2027-06-30', buildings: 2, floors: 16, sqmPrice: 33500, leadsPerDay: 3.6, nearby: ['ראשון לציון', 'חולון', 'בת ים', 'נס ציונה', 'רחובות', 'תל אביב'] },
  { project_id: 2, project_name: 'אופק ים', city: 'נתניה', region: 'שרון', start: '2025-04-06', delivery: '2027-12-31', buildings: 1, floors: 22, sqmPrice: 32000, leadsPerDay: 3.0, nearby: ['נתניה', 'כפר יונה', 'הרצליה', 'רעננה', 'תל אביב', 'חדרה'] },
  { project_id: 3, project_name: 'אופק כרמל', city: 'חיפה', region: 'צפון', start: '2025-02-16', delivery: '2027-09-30', buildings: 3, floors: 8, sqmPrice: 21000, leadsPerDay: 2.9, nearby: ['חיפה', 'קריית אתא', 'קריית ביאליק', 'נשר', 'טירת כרמל', 'יקנעם'] },
  { project_id: 4, project_name: 'אופק הנגב', city: 'באר שבע', region: 'דרום', start: '2026-03-01', delivery: '2028-06-30', buildings: 4, floors: 7, sqmPrice: 15500, leadsPerDay: 4.4, nearby: ['באר שבע', 'אופקים', 'דימונה', 'קריית גת', 'אשקלון', 'תל אביב'] },
  { project_id: 5, project_name: 'אופק העיר', city: 'ירושלים', region: 'ירושלים', start: '2025-09-07', delivery: '2028-03-31', buildings: 2, floors: 10, sqmPrice: 30500, leadsPerDay: 2.4, nearby: ['ירושלים', 'מבשרת ציון', 'בית שמש', 'מודיעין', 'גבעת זאב'] },
];
for (const p of PROJECTS) p.startDate = new Date(`${p.start}T12:00:00`);
// Price list rises 0.4% a month after launch — the developer's normal escalation.
const escalation = (p, date) => 1 + 0.004 * Math.max(0, daysBetween(p.startDate, date) / 30.4);

// ── Units ───────────────────────────────────────────────────────────────────
// Per standard floor: 3, 4, 4, 5 rooms. Ground floor = garden units, top floor
// = penthouse + mini-penthouse. Directions flip between odd and even buildings
// so every project has north- and south-facing 5-room units.
const DIRS_ODD = ['צפון-מזרח', 'צפון-מערב', 'דרום-מערב', 'דרום-מזרח'];
const DIRS_EVEN = ['דרום-מערב', 'דרום-מזרח', 'צפון-מזרח', 'צפון-מערב'];
const UNITS = [];
let unitSeq = 1;
for (const p of PROJECTS) {
  for (let b = 1; b <= p.buildings; b++) {
    // Haifa's buildings 2 and 3 both turn their 5-room units north.
    const dirs = (p.project_id === 3 ? b === 1 : b % 2) ? DIRS_ODD : DIRS_EVEN;
    for (let floor = 0; floor <= p.floors; floor++) {
      const slots = floor === 0
        ? [{ pos: 1, rooms: 4, sqm: 104, outdoor: 70, type: 'דירת גן' }, { pos: 2, rooms: 3, sqm: 82, outdoor: 45, type: 'דירת גן' }, { pos: 3, rooms: 4, sqm: 106, outdoor: 65, type: 'דירת גן' }, { pos: 4, rooms: 5, sqm: 126, outdoor: 90, type: 'דירת גן' }]
        : floor === p.floors
          ? [{ pos: 1, rooms: 6, sqm: 168, outdoor: 75, type: 'פנטהאוז' }, { pos: 3, rooms: 5, sqm: 138, outdoor: 45, type: 'מיני פנטהאוז' }]
          : [{ pos: 1, rooms: 3, sqm: 78, outdoor: 12, type: 'דירה' }, { pos: 2, rooms: 4, sqm: 99, outdoor: 14, type: 'דירה' }, { pos: 3, rooms: 4, sqm: 103, outdoor: 14, type: 'דירה' }, { pos: 4, rooms: 5, sqm: 123, outdoor: 16, type: 'דירה' }];
      for (const s of slots) {
        const direction = dirs[s.pos - 1];
        const sqm = s.sqm + randInt(-3, 3);
        const seaView = p.project_id === 2 && direction.includes('מערב') && floor >= 12;
        const view = seaView ? 'נוף לים' : floor >= p.floors - 3 ? 'נוף פתוח' : 'עירוני';
        let factor = (1 + 0.012 * floor) * (direction.startsWith('דרום') ? 1.02 : 0.98) *
          (s.type === 'פנטהאוז' ? 1.18 : s.type === 'מיני פנטהאוז' ? 1.10 : s.type === 'דירת גן' ? 1.06 : 1) *
          (seaView ? 1.08 : 1);
        // The pricing mistake the demo uncovers: Haifa's north-facing 5-room units.
        const overpriced = p.project_id === 3 && s.rooms === 5 && direction.startsWith('צפון') && s.type === 'דירה';
        if (overpriced) factor *= 1.14;
        UNITS.push({
          unit_id: unitSeq++,
          project_id: p.project_id,
          building: b,
          floor,
          position: s.pos,
          unit_number: floor * 4 + s.pos,
          rooms: s.rooms,
          unit_type: s.type,
          sqm,
          outdoor_sqm: s.outdoor,
          direction,
          view,
          parking_spots: s.rooms >= 5 ? 2 : 1,
          has_storage: s.rooms >= 4,
          base_price: (sqm + s.outdoor * 0.3) * p.sqmPrice * factor,
          overpriced,
          status: 'פנויה',
          listed_date: p.start,
          sold_date: null,
        });
      }
    }
  }
}

// ── Sales reps ──────────────────────────────────────────────────────────────
// responseMedian = minutes to the first call back. discountMean = % off list.
const REPS = [
  { rep_id: 1, rep_name: 'רונן לוי', projects: [1, 2], from: '2025-01-01', to: null, responseMedian: 35, discountMean: 6.8 },
  { rep_id: 2, rep_name: 'שירן כהן', projects: [1], from: '2025-01-01', to: null, responseMedian: 25, discountMean: 2.4 },
  { rep_id: 3, rep_name: 'יעל מזרחי', projects: [2], from: '2025-04-01', to: null, responseMedian: 70, discountMean: 2.7 },
  { rep_id: 4, rep_name: 'מיכל אברהם', projects: [3], from: '2025-02-01', to: '2026-04-30', responseMedian: 30, discountMean: 2.6 },
  { rep_id: 5, rep_name: 'אלון ברק', projects: [3], from: '2026-05-01', to: null, responseMedian: 1350, discountMean: 2.9 },
  { rep_id: 6, rep_name: 'דניאל פרץ', projects: [4], from: '2026-02-15', to: null, responseMedian: 45, discountMean: 2.2 },
  { rep_id: 7, rep_name: 'נועה ביטון', projects: [4], from: '2026-02-15', to: null, responseMedian: 90, discountMean: 2.5 },
  { rep_id: 8, rep_name: 'אבי גולן', projects: [5], from: '2025-09-01', to: null, responseMedian: 60, discountMean: 2.8 },
];
const repsFor = (projectId, dateIso) => REPS.filter(r => r.projects.includes(projectId) && r.from <= dateIso && (!r.to || r.to >= dateIso));

// ── Campaigns (marketing spend, per project) ────────────────────────────────
const CAMPAIGNS = [];
let campSeq = 1;
function addCampaign(p, source, name, start, end, budget) {
  if (start > END_DATE) return null;
  const c = { campaign_id: campSeq++, project_id: p.project_id, source, campaign_name: `${name} - ${p.project_name}`, start_date: iso(start), end_date: iso(end > END_DATE ? END_DATE : end), budget_ils: Math.round(budget / 1000) * 1000, startDate: start, endDate: end };
  CAMPAIGNS.push(c);
  return c;
}
// One-day events add a burst of their own leads.
const EVENTS = []; // { date, project, source, campaign, leads }
const FAIRS = [
  { name: 'יריד הנדל"ן תל אביב', dates: ['2025-03-20', '2025-10-15', '2026-03-18', '2026-10-14'], projects: [1, 2, 5] },
  { name: 'יריד הנדל"ן חיפה', dates: ['2025-06-10', '2026-06-09'], projects: [3] },
  { name: 'יריד הנדל"ן באר שבע', dates: ['2026-04-22', '2026-09-23'], projects: [4] },
];
for (const p of PROJECTS) {
  const launch = addDays(p.startDate, 10);
  const c = addCampaign(p, 'ערב השקה', 'ערב השקה', launch, launch, randFloat(70000, 90000));
  if (c) EVENTS.push({ date: iso(launch), project: p, source: 'ערב השקה', campaign: c, leads: randInt(34, 48) });
  for (const f of FAIRS) {
    if (!f.projects.includes(p.project_id)) continue;
    for (const d of f.dates) {
      const date = new Date(`${d}T12:00:00`);
      if (date < p.startDate) continue;
      const fc = addCampaign(p, 'יריד נדל"ן', f.name, date, date, randFloat(38000, 48000));
      if (fc) EVENTS.push({ date: d, project: p, source: 'יריד נדל"ן', campaign: fc, leads: randInt(22, 40) });
    }
  }
  // Facebook: a 6-week burst every ~4 months. Google: every quarter. Instagram: twice a year.
  for (let d = new Date(p.startDate); d <= END_DATE; d = addDays(d, 122)) addCampaign(p, 'פייסבוק', 'קמפיין פייסבוק', d, addDays(d, 42), randFloat(65000, 90000));
  for (let d = new Date(p.startDate); d <= END_DATE; d = addDays(d, 91)) addCampaign(p, 'גוגל', 'גוגל ממומן', d, addDays(d, 90), randFloat(40000, 55000));
  for (let d = addDays(p.startDate, 60); d <= END_DATE; d = addDays(d, 182)) addCampaign(p, 'אינסטגרם', 'קמפיין אינסטגרם', d, addDays(d, 35), randFloat(28000, 38000));
  for (let d = new Date(p.startDate); d <= END_DATE; d = addDays(d, 365)) {
    addCampaign(p, 'יד2', 'מודעות יד2', d, addDays(d, 364), randFloat(20000, 26000));
    addCampaign(p, 'מדלן', 'מודעות מדלן', d, addDays(d, 364), randFloat(15000, 20000));
  }
  addCampaign(p, 'שלט באתר הבנייה', 'שילוט באתר', p.startDate, addDays(p.startDate, 900), randFloat(22000, 30000));
}
const activeCampaign = (projectId, source, date) =>
  CAMPAIGNS.find(c => c.project_id === projectId && c.source === source && c.startDate <= date && date <= addDays(c.endDate, 0));

// ── People ──────────────────────────────────────────────────────────────────
const MALE = ['יוסי', 'דוד', 'משה', 'אבי', 'איתי', 'עומר', 'נועם', 'אורי', 'יונתן', 'אריאל', 'רועי', 'עידו', 'גיא', 'אלון', 'תומר', 'עמית', 'ניר', 'אסף', 'יואב', 'שי', 'אליעזר', 'חיים', 'יעקב', 'מאור', 'אלעד', 'רון', 'דן', 'בן', 'עזרא', 'שלמה'];
const FEMALE = ['מיכל', 'נועה', 'שירה', 'יעל', 'תמר', 'מאיה', 'רוני', 'הילה', 'ליאת', 'אורית', 'דנה', 'שני', 'עדי', 'קרן', 'אפרת', 'רחל', 'שרה', 'לימור', 'סיגל', 'מירב', 'גלית', 'אסתר', 'חן', 'ענבל', 'אביטל', 'טל', 'נטע', 'ליה', 'רינת', 'אילנה'];
const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'דהן', 'אברהם', 'פרידמן', 'שפירא', 'גולן', 'אזולאי', 'מלכה', 'חדד', 'עמר', 'אוחיון', 'יוסף', 'בן דוד', 'שושן', 'רוזנברג', 'קליין', 'וקנין', 'אשכנזי', 'סויסה', 'גבאי', 'נחום', 'בירנבאום', 'טל', 'ברק', 'קפלן', 'סלע', 'רבינוביץ', 'אלמוג', 'זילברמן', 'חזן', 'בוזגלו', 'גרינברג'];
const PROFESSIONS = {
  high: [['רופא', 'רופאה'], ['עורך דין', 'עורכת דין'], ['מהנדס תוכנה', 'מהנדסת תוכנה'], ['רואה חשבון', 'רואת חשבון'], ['מנהל בהייטק', 'מנהלת בהייטק'], ['בעל עסק', 'בעלת עסק'], ['יועץ השקעות', 'יועצת השקעות'], ['אדריכל', 'אדריכלית']],
  mid: [['מורה', 'מורה'], ['אח', 'אחות'], ['טכנאי', 'טכנאית'], ['איש מכירות', 'אשת מכירות'], ['עובד מדינה', 'עובדת מדינה'], ['שוטר', 'שוטרת'], ['מנהל חשבונות', 'מנהלת חשבונות'], ['איש צבא קבע', 'אשת צבא קבע'], ['גרפיקאי', 'גרפיקאית'], ['מנהל לוגיסטיקה', 'מנהלת לוגיסטיקה']],
  retired: [['פנסיונר', 'פנסיונרית']],
};

const PURPOSES = ['דירה ראשונה', 'משפרי דיור', 'השקעה', 'עבור הילדים'];
function purposeFor(p, date) {
  const progress = Math.max(0, Math.min(1, daysBetween(START_DATE, date) / daysBetween(START_DATE, END_DATE)));
  const parents = 0.07 + 0.13 * progress + (p.project_id === 5 ? 0.05 : 0);
  const investors = p.project_id === 4 ? 0.30 : p.project_id === 2 ? 0.24 : 0.18;
  const first = p.project_id === 4 ? 0.40 : p.project_id === 1 ? 0.34 : 0.28;
  return weighted({ 'דירה ראשונה': first, 'משפרי דיור': Math.max(0.1, 1 - first - investors - parents), 'השקעה': investors, 'עבור הילדים': parents });
}

// ── Funnel model ────────────────────────────────────────────────────────────
// Multiplier on the chance a contacted lead comes to the sales office.
const SOURCE_VISIT = { 'פייסבוק': 0.42, 'אינסטגרם': 0.33, 'גוגל': 0.95, 'יד2': 0.85, 'מדלן': 0.9, 'יריד נדל"ן': 2.4, 'ערב השקה': 2.7, 'המלצת חבר': 3.0, 'שלט באתר הבנייה': 1.8, 'אתר החברה': 1.25, 'מתווך': 2.0 };
const SOURCE_BASE = { 'פייסבוק': 0.12, 'אינסטגרם': 0.05, 'גוגל': 0.15, 'יד2': 0.10, 'מדלן': 0.07, 'שלט באתר הבנייה': 0.09, 'אתר החברה': 0.10, 'המלצת חבר': 0.07, 'מתווך': 0.05 };
const BENEFITS = ['מימון 20/80', 'מטבח מתנה', 'הנחה במחיר', 'שדרוג מפרט', 'חניה נוספת'];
// How much each benefit raises the close rate of each segment (1 = no effect).
const BENEFIT_MATCH = {
  'דירה ראשונה': { 'מימון 20/80': 2.3, 'מטבח מתנה': 1.0, 'הנחה במחיר': 1.1, 'שדרוג מפרט': 0.85, 'חניה נוספת': 0.7 },
  'משפרי דיור': { 'מימון 20/80': 0.9, 'מטבח מתנה': 1.6, 'הנחה במחיר': 1.0, 'שדרוג מפרט': 1.8, 'חניה נוספת': 1.2 },
  'השקעה': { 'מימון 20/80': 1.2, 'מטבח מתנה': 0.6, 'הנחה במחיר': 2.1, 'שדרוג מפרט': 0.6, 'חניה נוספת': 0.8 },
  'עבור הילדים': { 'מימון 20/80': 0.8, 'מטבח מתנה': 1.1, 'הנחה במחיר': 1.0, 'שדרוג מפרט': 1.3, 'חניה נוספת': 2.0 },
};
const BENEFIT_COST = { 'מימון 20/80': (price) => price * 0.03, 'מטבח מתנה': () => 45000, 'הנחה במחיר': (price) => price * 0.02, 'שדרוג מפרט': () => 60000, 'חניה נוספת': () => 140000 };
const PROJECT_CLOSE = { 1: 0.9, 2: 1.05, 3: 1.0, 4: 0.95, 5: 0.8 };
const LOST = {
  'חדש': ['לא ענה'],
  'בטיפול': ['לא רלוונטי כרגע', 'מיקום לא מתאים', 'מחיר גבוה מדי', 'רק בדק מחירים'],
  'ביקר במשרד': ['מחיר גבוה מדי', 'לא מצא דירה מתאימה', 'קנה אצל מתחרה', 'מיקום לא מתאים'],
  'משא ומתן': ['לא קיבל משכנתא', 'קנה אצל מתחרה', 'מחיר גבוה מדי', 'החליט לחכות'],
};

// ── Leads, activities, deals ────────────────────────────────────────────────
const LEADS = [];
const ACTIVITIES = [];
const SIGNINGS = []; // leads that would sign, resolved against unit stock afterwards
let leadSeq = 1;

function makeLead(p, date, source, campaign) {
  const dateIso = iso(date);
  const purpose = purposeFor(p, date);
  const gender = chance(0.55) ? 'גבר' : 'אישה';
  const g = gender === 'גבר' ? 0 : 1;
  const age = purpose === 'דירה ראשונה' ? randInt(25, 37) : purpose === 'משפרי דיור' ? randInt(34, 52) : purpose === 'השקעה' ? randInt(36, 64) : randInt(52, 74);
  const decile = Math.min(10, purpose === 'דירה ראשונה' ? randInt(4, 8) : purpose === 'משפרי דיור' ? randInt(6, 9) : randInt(7, 10));
  const family = purpose === 'דירה ראשונה' ? weighted({ 'רווק/ה': 0.33, 'נשוי/אה': 0.5, 'זוג ידועים בציבור': 0.17 })
    : purpose === 'משפרי דיור' ? weighted({ 'נשוי/אה': 0.85, 'גרוש/ה': 0.15 })
      : weighted({ 'נשוי/אה': 0.75, 'גרוש/ה': 0.15, 'אלמן/ה': purpose === 'עבור הילדים' ? 0.1 : 0.02 });
  const children = purpose === 'דירה ראשונה' ? (family === 'נשוי/אה' ? randInt(0, 2) : 0) : purpose === 'משפרי דיור' ? randInt(1, 4) : randInt(1, 4);
  const profTier = age >= 67 ? 'retired' : decile >= 8 ? 'high' : decile >= 6 ? (chance(0.35) ? 'high' : 'mid') : 'mid';
  const rooms = purpose === 'דירה ראשונה' ? weighted({ 3: 0.55, 4: 0.45 }) : purpose === 'משפרי דיור' ? weighted({ 4: 0.38, 5: 0.52, 6: 0.10 }) : purpose === 'השקעה' ? weighted({ 3: 0.75, 4: 0.25 }) : weighted({ 3: 0.6, 4: 0.4 });
  const typicalSqm = { 3: 80, 4: 102, 5: 125, 6: 168 }[rooms];
  const budget = Math.round(typicalSqm * p.sqmPrice * escalation(p, date) * randFloat(0.86, 1.14) / 10000) * 10000;
  const owned = purpose === 'דירה ראשונה' ? 0 : purpose === 'משפרי דיור' ? 1 : purpose === 'השקעה' ? randInt(1, 3) : randInt(1, 2);
  const mortgage = chance(purpose === 'השקעה' ? 0.45 : 0.30);
  const reps = repsFor(p.project_id, dateIso);
  const rep = pick(reps.length ? reps : REPS.filter(r => r.projects.includes(p.project_id)));
  const response = Math.max(3, Math.round(lognormal(rep.responseMedian, 0.9)));
  const first = pick(g ? FEMALE : MALE);
  const last = pick(LAST);
  const leadTs = new Date(date.getTime() + randInt(-3, 9) * 3600000 + randInt(0, 59) * 60000);

  const lead = {
    lead_id: leadSeq++, lead_date: dateIso, lead_ts: leadTs.toISOString(), project_id: p.project_id, source, campaign_id: campaign ? campaign.campaign_id : null,
    first_name: first, last_name: last, full_name: `${first} ${last}`, gender, age, family_status: family, children,
    profession: pick(PROFESSIONS[profTier])[g], income_decile: decile, city_of_residence: pick(p.nearby),
    purchase_purpose: purpose, owned_apartments: owned, rooms_wanted: rooms, budget, mortgage_preapproved: mortgage,
    rep_name: rep.rep_name, first_response_minutes: response, status: 'חדש', lost_reason: null,
    visit_date: null, negotiation_date: null, offered_benefit: null,
    phone_masked: `05${randInt(0, 8)}-•••-${String(randInt(0, 9999)).padStart(4, '0')}`,
  };
  LEADS.push(lead);

  // Funnel. Each step happens on a date; a step still in the future stays open.
  const fast = response <= 60, ok = response <= 240, slow = response > 1440;
  const act = (ts, type, outcome = null) => { if (ts <= END_DATE) ACTIVITIES.push({ lead_id: lead.lead_id, activity_ts: ts.toISOString(), activity_type: type, rep_name: rep.rep_name, outcome }); };
  const firstCall = new Date(leadTs.getTime() + response * 60000);
  const contacted = chance(fast ? 0.95 : ok ? 0.9 : slow ? 0.55 : 0.8);
  let stageDate = leadTs;
  let stage = 'חדש';
  if (!contacted) {
    for (let i = 0; i < randInt(1, 3); i++) act(new Date(firstCall.getTime() + i * 2 * DAY), 'שיחה ללא מענה');
  } else if (firstCall <= END_DATE) {
    stage = 'בטיפול'; stageDate = firstCall;
    act(firstCall, 'שיחה יוצאת', 'שיחת היכרות');
    const visitChance = 0.25 * SOURCE_VISIT[source] * (fast ? 1.35 : ok ? 1.0 : slow ? 0.5 : 0.8) * (mortgage ? 1.2 : 1);
    if (chance(Math.min(0.85, visitChance))) {
      const visit = addDays(firstCall, randInt(3, 24));
      act(addDays(firstCall, randInt(1, 2)), 'וואטסאפ', 'נשלח מפרט ותוכניות');
      if (visit <= END_DATE) {
        stage = 'ביקר במשרד'; stageDate = visit; lead.visit_date = iso(visit);
        act(visit, 'ביקור במשרד המכירות');
        if (chance(0.45)) {
          const nego = addDays(visit, randInt(4, 28));
          if (nego <= END_DATE) {
            stage = 'משא ומתן'; stageDate = nego; lead.negotiation_date = iso(nego);
            lead.offered_benefit = pick(BENEFITS); // offered at random today — the finding
            act(nego, 'שליחת הצעת מחיר', lead.offered_benefit);
            const close = 0.22 * BENEFIT_MATCH[purpose][lead.offered_benefit] * (mortgage ? 1.6 : 0.85) * PROJECT_CLOSE[p.project_id];
            const sign = addDays(nego, randInt(7, 40));
            if (chance(Math.min(0.9, close))) {
              act(addDays(nego, randInt(2, 6)), 'פגישת משא ומתן');
              if (sign <= END_DATE) SIGNINGS.push({ lead, date: sign, rep });
            }
          }
        }
      }
    }
  }
  lead.status = stage;
  // Follow-ups after the last stage — reps stop following up on some open leads,
  // which is what the "who to call today" list is for.
  const keepsFollowing = chance(0.6);
  for (let i = 1; i <= randInt(0, 3); i++) {
    const ts = addDays(stageDate, i * randInt(2, 6));
    if (!keepsFollowing && daysBetween(stageDate, END_DATE) < 40 && i > 0) break;
    act(ts, pick(['שיחה יוצאת', 'וואטסאפ', 'שיחה נכנסת']), 'מעקב');
  }
  // Old leads that never moved on are lost.
  if (stage !== 'נחתם חוזה' && daysBetween(stageDate, END_DATE) > (stage === 'משא ומתן' ? 60 : 35)) {
    if (!SIGNINGS.length || SIGNINGS[SIGNINGS.length - 1].lead !== lead) {
      lead.lost_reason = pick(LOST[stage]);
      lead.status = 'אבוד';
    }
  }
}

for (const p of PROJECTS) {
  for (let d = new Date(p.startDate); d <= END_DATE; d = addDays(d, 1)) {
    const dow = d.getDay();
    const dayFactor = dow === 5 ? 0.55 : dow === 6 ? 0.4 : 1.1;
    const weights = { ...SOURCE_BASE };
    if (activeCampaign(p.project_id, 'פייסבוק', d)) weights['פייסבוק'] *= 4;
    if (activeCampaign(p.project_id, 'אינסטגרם', d)) weights['אינסטגרם'] *= 3;
    const boost = (activeCampaign(p.project_id, 'פייסבוק', d) ? 1.45 : 1) * (activeCampaign(p.project_id, 'אינסטגרם', d) ? 1.15 : 1);
    // Demand cools as a project sells and picks up again with each launch wave.
    const age = daysBetween(p.startDate, d);
    const lifecycle = age < 90 ? 1.25 : age < 365 ? 1.0 : 0.85;
    const n = Math.round(p.leadsPerDay * dayFactor * boost * lifecycle * randFloat(0.6, 1.4));
    for (let i = 0; i < n; i++) {
      const source = weighted(weights);
      makeLead(p, d, source, activeCampaign(p.project_id, source, d) || null);
    }
  }
}
for (const e of EVENTS) {
  const date = new Date(`${e.date}T12:00:00`);
  if (date > END_DATE) continue;
  for (let i = 0; i < e.leads; i++) makeLead(e.project, date, e.source, e.campaign);
}

// Resolve signings against the stock, in date order: the buyer takes the unit
// that suits them best among those still free. Overpriced units mostly lose the
// buyer instead — that is how the Haifa 5-room north units end up stuck.
const DEALS = [];
SIGNINGS.sort((a, b) => a.date - b.date);
for (const s of SIGNINGS) {
  const { lead, date, rep } = s;
  const free = UNITS.filter(u => u.project_id === lead.project_id && u.status === 'פנויה');
  let options = free.filter(u => u.rooms === Number(lead.rooms_wanted));
  if (!options.length) options = free.filter(u => Math.abs(u.rooms - lead.rooms_wanted) === 1);
  if (!options.length) { lead.status = 'אבוד'; lead.lost_reason = 'לא מצא דירה מתאימה'; continue; }
  const score = (u) => {
    let w = 1;
    if (lead.purchase_purpose === 'השקעה') w *= 1 + u.floor * 0.08;
    if (lead.purchase_purpose === 'משפרי דיור' && u.direction.startsWith('דרום')) w *= 1.6;
    if (u.view === 'נוף לים') w *= 1.5;
    if (u.overpriced) w *= 0.25;
    return w * randFloat(0.7, 1.3);
  };
  const unit = options.reduce((best, u) => (score(u) > score(best) ? u : best), options[0]);
  if (unit.overpriced && chance(0.75)) { lead.status = 'אבוד'; lead.lost_reason = 'מחיר גבוה מדי'; continue; }

  const project = PROJECTS.find(p => p.project_id === lead.project_id);
  const listPrice = Math.round(unit.base_price * escalation(project, date) / 1000) * 1000;
  const discountPct = Math.max(0, Math.min(12, rep.discountMean + (rand() * 2 - 1) * 1.6 + (lead.offered_benefit === 'הנחה במחיר' ? 2 : 0)));
  const finalPrice = Math.round(listPrice * (1 - discountPct / 100) / 1000) * 1000;
  unit.status = 'נמכרה';
  unit.sold_date = iso(date);
  lead.status = 'נחתם חוזה';
  lead.lost_reason = null;
  ACTIVITIES.push({ lead_id: lead.lead_id, activity_ts: date.toISOString(), activity_type: 'חתימת חוזה', rep_name: rep.rep_name, outcome: `דירה ${unit.unit_number}, בניין ${unit.building}` });
  DEALS.push({
    deal_id: DEALS.length + 1, lead_id: lead.lead_id, unit_id: unit.unit_id, project_id: lead.project_id, signed_date: iso(date), rep_name: rep.rep_name,
    list_price: listPrice, discount_pct: Math.round(discountPct * 100) / 100, discount_ils: listPrice - finalPrice, final_price: finalPrice,
    benefit: lead.offered_benefit, benefit_cost_ils: Math.round(BENEFIT_COST[lead.offered_benefit](listPrice)),
    payment_plan: lead.offered_benefit === 'מימון 20/80' ? '20/80' : chance(0.8) ? 'לפי התקדמות הבנייה' : '10/90',
    with_mortgage: chance(lead.purchase_purpose === 'השקעה' ? 0.5 : 0.75),
  });
}

// Sources paid per deal or per year rather than per campaign: broker commission
// (1.5% of the price), the referral bonus, and the company website. Booked as
// one yearly line per project so every source carries its real cost per deal.
for (const p of PROJECTS) {
  for (let d = new Date(p.startDate); d <= END_DATE; d = addDays(d, 365)) {
    const yearEnd = addDays(d, 364);
    const inYear = (l) => l.project_id === p.project_id && l.lead_date >= iso(d) && l.lead_date <= iso(yearEnd);
    const dealsOf = (source) => DEALS.filter(x => { const l = LEADS[x.lead_id - 1]; return l.source === source && inYear(l); });
    addCampaign(p, 'מתווך', 'עמלות מתווכים', d, yearEnd, dealsOf('מתווך').reduce((a, x) => a + x.final_price * 0.015, 0) || 1000);
    addCampaign(p, 'המלצת חבר', 'חבר מביא חבר', d, yearEnd, dealsOf('המלצת חבר').length * 7500 || 1000);
    addCampaign(p, 'אתר החברה', 'אתר החברה ו-SEO', d, yearEnd, randFloat(28000, 36000));
  }
}
// Leads from those sources belong to that year's line.
for (const l of LEADS) {
  if (l.campaign_id || !['מתווך', 'המלצת חבר', 'אתר החברה'].includes(l.source)) continue;
  const c = activeCampaign(l.project_id, l.source, new Date(`${l.lead_date}T12:00:00`));
  if (c) l.campaign_id = c.campaign_id;
}

// Open negotiations from the last three weeks hold a reservation on a unit.
for (const lead of LEADS) {
  if (lead.status !== 'משא ומתן' || daysBetween(new Date(`${lead.negotiation_date}T12:00:00`), END_DATE) > 21) continue;
  const unit = UNITS.find(u => u.project_id === lead.project_id && u.status === 'פנויה' && u.rooms === Number(lead.rooms_wanted) && !u.overpriced);
  if (unit) { unit.status = 'שמורה'; unit.reserved_by_lead = lead.lead_id; }
}
// Today's price list.
for (const u of UNITS) {
  const p = PROJECTS.find(x => x.project_id === u.project_id);
  u.list_price = Math.round(u.base_price * escalation(p, END_DATE) / 1000) * 1000;
}

// ── Schema ──────────────────────────────────────────────────────────────────
const DDL = `
DROP SCHEMA IF EXISTS ${S} CASCADE;
CREATE SCHEMA ${S};

CREATE TABLE ${S}.projects (
  project_id        INTEGER PRIMARY KEY,
  project_name      TEXT NOT NULL,
  city              TEXT NOT NULL,
  region            TEXT NOT NULL,
  marketing_start   DATE NOT NULL,
  expected_delivery DATE NOT NULL,
  buildings         INTEGER NOT NULL,
  floors            INTEGER NOT NULL,
  total_units       INTEGER NOT NULL
);

CREATE TABLE ${S}.units (
  unit_id          INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES ${S}.projects(project_id),
  building         INTEGER NOT NULL,
  floor            INTEGER NOT NULL,
  position         INTEGER NOT NULL,
  unit_number      INTEGER NOT NULL,
  rooms            INTEGER NOT NULL,
  unit_type        TEXT NOT NULL,
  sqm              INTEGER NOT NULL,
  outdoor_sqm      INTEGER NOT NULL,
  direction        TEXT NOT NULL,
  view             TEXT NOT NULL,
  parking_spots    INTEGER NOT NULL,
  has_storage      BOOLEAN NOT NULL,
  list_price       NUMERIC(12,0) NOT NULL,
  status           TEXT NOT NULL,
  listed_date      DATE NOT NULL,
  sold_date        DATE
);

CREATE TABLE ${S}.sales_reps (
  rep_id      INTEGER PRIMARY KEY,
  rep_name    TEXT NOT NULL,
  project_ids INTEGER[] NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE
);

CREATE TABLE ${S}.campaigns (
  campaign_id   INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES ${S}.projects(project_id),
  source        TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  budget_ils    NUMERIC(12,0) NOT NULL
);

CREATE TABLE ${S}.leads (
  lead_id                INTEGER PRIMARY KEY,
  lead_date              DATE NOT NULL,
  lead_ts                TIMESTAMP NOT NULL,
  project_id             INTEGER NOT NULL REFERENCES ${S}.projects(project_id),
  source                 TEXT NOT NULL,
  campaign_id            INTEGER REFERENCES ${S}.campaigns(campaign_id),
  first_name             TEXT NOT NULL,
  last_name              TEXT NOT NULL,
  full_name              TEXT NOT NULL,
  phone_masked           TEXT NOT NULL,
  gender                 TEXT NOT NULL,
  age                    INTEGER NOT NULL,
  family_status          TEXT NOT NULL,
  children               INTEGER NOT NULL,
  profession             TEXT NOT NULL,
  income_decile          INTEGER NOT NULL,
  city_of_residence      TEXT NOT NULL,
  purchase_purpose       TEXT NOT NULL,
  owned_apartments       INTEGER NOT NULL,
  rooms_wanted           INTEGER NOT NULL,
  budget                 NUMERIC(12,0) NOT NULL,
  mortgage_preapproved   BOOLEAN NOT NULL,
  rep_name               TEXT NOT NULL,
  first_response_minutes INTEGER NOT NULL,
  status                 TEXT NOT NULL,
  lost_reason            TEXT,
  visit_date             DATE,
  negotiation_date       DATE,
  offered_benefit        TEXT
);

CREATE TABLE ${S}.activities (
  activity_id   BIGSERIAL PRIMARY KEY,
  lead_id       INTEGER NOT NULL REFERENCES ${S}.leads(lead_id),
  activity_ts   TIMESTAMP NOT NULL,
  activity_type TEXT NOT NULL,
  rep_name      TEXT NOT NULL,
  outcome       TEXT
);

CREATE TABLE ${S}.deals (
  deal_id          INTEGER PRIMARY KEY,
  lead_id          INTEGER NOT NULL REFERENCES ${S}.leads(lead_id),
  unit_id          INTEGER NOT NULL UNIQUE REFERENCES ${S}.units(unit_id),
  project_id       INTEGER NOT NULL REFERENCES ${S}.projects(project_id),
  signed_date      DATE NOT NULL,
  rep_name         TEXT NOT NULL,
  list_price       NUMERIC(12,0) NOT NULL,
  discount_pct     NUMERIC(5,2) NOT NULL,
  discount_ils     NUMERIC(12,0) NOT NULL,
  final_price      NUMERIC(12,0) NOT NULL,
  benefit          TEXT,
  benefit_cost_ils NUMERIC(12,0) NOT NULL,
  payment_plan     TEXT NOT NULL,
  with_mortgage    BOOLEAN NOT NULL
);

CREATE INDEX idx_re_leads_project_date ON ${S}.leads(project_id, lead_date);
CREATE INDEX idx_re_leads_status ON ${S}.leads(status);
CREATE INDEX idx_re_leads_campaign ON ${S}.leads(campaign_id);
CREATE INDEX idx_re_activities_lead ON ${S}.activities(lead_id, activity_ts);
CREATE INDEX idx_re_units_project ON ${S}.units(project_id, building, floor);
CREATE INDEX idx_re_deals_lead ON ${S}.deals(lead_id);
`;

// Views hold the business logic once, so chat, Intelligence and the building
// board all compute "sold", "stuck", "cost per deal" the same way.
const VIEWS = `
DROP VIEW IF EXISTS ${S}.v_units, ${S}.v_project_sellout, ${S}.v_stuck_units, ${S}.v_source_performance,
  ${S}.v_campaign_roi, ${S}.v_rep_performance, ${S}.v_segment_benefit, ${S}.v_call_today, ${S}.v_deals,
  ${S}.v_conversion_monthly CASCADE;

-- Conversion per project per month of lead arrival, with who handled the leads
-- and how fast they called back. Only cohorts at least 3 months old: younger
-- leads have not had time to sign, and comparing them reads as a fake collapse.
CREATE VIEW ${S}.v_conversion_monthly AS
SELECT p.project_name, p.city, DATE_TRUNC('month', l.lead_date)::date AS lead_month,
       COUNT(*) AS leads,
       COUNT(*) FILTER (WHERE l.visit_date IS NOT NULL) AS office_visits,
       COUNT(*) FILTER (WHERE l.status = 'נחתם חוזה') AS deals,
       ROUND(100.0 * COUNT(*) FILTER (WHERE l.status = 'נחתם חוזה') / COUNT(*), 2) AS conversion_pct,
       STRING_AGG(DISTINCT l.rep_name, ', ') AS reps,
       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY l.first_response_minutes)::numeric) AS median_first_response_minutes,
       ROUND(100.0 * COUNT(*) FILTER (WHERE l.first_response_minutes <= 60) / COUNT(*), 1) AS pct_answered_within_hour
  FROM ${S}.leads l JOIN ${S}.projects p USING (project_id)
 WHERE l.lead_date < DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months'
 GROUP BY p.project_name, p.city, DATE_TRUNC('month', l.lead_date);

-- Every unit with its project, price per sqm and days on the market.
CREATE VIEW ${S}.v_units AS
SELECT u.unit_id, u.project_id, p.project_name, p.city, p.region, u.building, u.floor, u.unit_number, u.rooms, u.unit_type,
       u.sqm, u.outdoor_sqm, u.direction, u.view, u.parking_spots, u.has_storage, u.list_price,
       ROUND(u.list_price / u.sqm) AS price_per_sqm, u.status, u.listed_date, u.sold_date,
       COALESCE(u.sold_date, CURRENT_DATE) - u.listed_date AS days_on_market
  FROM ${S}.units u JOIN ${S}.projects p USING (project_id);

-- Every signed deal with its unit, buyer and project.
CREATE VIEW ${S}.v_deals AS
SELECT d.deal_id, d.signed_date, p.project_name, p.city, u.building, u.floor, u.unit_number, u.rooms, u.unit_type, u.sqm, u.direction,
       d.rep_name, d.list_price, d.discount_pct, d.discount_ils, d.final_price, ROUND(d.final_price / u.sqm) AS final_price_per_sqm,
       d.benefit, d.benefit_cost_ils, d.payment_plan, d.with_mortgage,
       l.lead_id, l.full_name AS buyer_name, l.source, l.purchase_purpose, l.age, l.gender, l.profession, l.income_decile,
       l.family_status, l.children, l.city_of_residence, l.owned_apartments, l.lead_date, d.signed_date - l.lead_date AS days_lead_to_deal
  FROM ${S}.deals d
  JOIN ${S}.units u USING (unit_id)
  JOIN ${S}.projects p ON p.project_id = d.project_id
  JOIN ${S}.leads l ON l.lead_id = d.lead_id;

-- Per project: stock, sales pace over the last 90 days, and the sell-out forecast at that pace.
CREATE VIEW ${S}.v_project_sellout AS
WITH s AS (
  SELECT u.project_id, COUNT(*) AS total_units,
         COUNT(*) FILTER (WHERE u.status = 'נמכרה') AS sold_units,
         COUNT(*) FILTER (WHERE u.status = 'שמורה') AS reserved_units,
         COUNT(*) FILTER (WHERE u.status = 'פנויה') AS available_units,
         COUNT(*) FILTER (WHERE u.status = 'נמכרה' AND u.sold_date >= CURRENT_DATE - 90) AS sold_last_90_days,
         SUM(u.list_price) FILTER (WHERE u.status <> 'נמכרה') AS unsold_inventory_value
    FROM ${S}.units u GROUP BY u.project_id
), r AS (
  SELECT project_id, SUM(final_price) AS signed_revenue FROM ${S}.deals GROUP BY project_id
)
SELECT p.project_id, p.project_name, p.city, p.region, p.marketing_start, p.expected_delivery,
       s.total_units, s.sold_units, s.reserved_units, s.available_units,
       ROUND(100.0 * s.sold_units / s.total_units, 1) AS pct_sold,
       s.sold_last_90_days, ROUND(s.sold_last_90_days / 3.0, 1) AS monthly_sales_pace,
       CEIL((s.available_units + s.reserved_units) / NULLIF(s.sold_last_90_days / 3.0, 0))::int AS months_to_sell_out,
       (CURRENT_DATE + MAKE_INTERVAL(months => CEIL((s.available_units + s.reserved_units) / NULLIF(s.sold_last_90_days / 3.0, 0))::int))::date AS forecast_sell_out_date,
       COALESCE(r.signed_revenue, 0) AS signed_revenue, s.unsold_inventory_value
  FROM ${S}.projects p JOIN s USING (project_id) LEFT JOIN r USING (project_id);

-- Unsold units on the market over 180 days, priced against what the same kind of
-- unit (room count + type: a garden unit's price includes its garden) actually
-- sold for in the project.
CREATE VIEW ${S}.v_stuck_units AS
WITH sold AS (
  SELECT u.project_id, u.rooms, u.unit_type, AVG(d.final_price / u.sqm) AS sold_price_per_sqm, COUNT(*) AS sold_count
    FROM ${S}.deals d JOIN ${S}.units u USING (unit_id) GROUP BY 1, 2, 3
), demand AS (
  SELECT project_id, rooms_wanted AS rooms, COUNT(*) AS leads_last_90_days
    FROM ${S}.leads WHERE lead_date >= CURRENT_DATE - 90 GROUP BY 1, 2
)
SELECT v.unit_id, v.project_name, v.city, v.building, v.floor, v.unit_number, v.rooms, v.unit_type, v.sqm, v.direction, v.view,
       v.list_price, v.price_per_sqm, v.days_on_market,
       ROUND(s.sold_price_per_sqm) AS avg_sold_price_per_sqm_same_rooms,
       ROUND(100.0 * (v.price_per_sqm / NULLIF(s.sold_price_per_sqm, 0) - 1), 1) AS price_premium_pct,
       COALESCE(dm.leads_last_90_days, 0) AS leads_wanting_this_size_last_90_days
  FROM ${S}.v_units v
  LEFT JOIN sold s ON s.project_id = v.project_id AND s.rooms = v.rooms AND s.unit_type = v.unit_type
  LEFT JOIN demand dm ON dm.project_id = v.project_id AND dm.rooms = v.rooms
 WHERE v.status = 'פנויה' AND v.days_on_market > 180;

-- Lead source economics: volume, funnel, deals, spend and cost per deal.
CREATE VIEW ${S}.v_source_performance AS
WITH l AS (
  SELECT l.source, COUNT(*) AS leads,
         COUNT(*) FILTER (WHERE l.visit_date IS NOT NULL) AS office_visits,
         COUNT(d.deal_id) AS deals, COALESCE(SUM(d.final_price), 0) AS signed_revenue
    FROM ${S}.leads l LEFT JOIN ${S}.deals d ON d.lead_id = l.lead_id GROUP BY l.source
), c AS (
  SELECT source, SUM(budget_ils) AS marketing_spend FROM ${S}.campaigns GROUP BY source
)
SELECT l.source, l.leads, l.office_visits, l.deals,
       ROUND(100.0 * l.office_visits / NULLIF(l.leads, 0), 1) AS visit_rate_pct,
       ROUND(100.0 * l.deals / NULLIF(l.leads, 0), 2) AS conversion_pct,
       COALESCE(c.marketing_spend, 0) AS marketing_spend,
       ROUND(c.marketing_spend / NULLIF(l.leads, 0)) AS cost_per_lead,
       ROUND(c.marketing_spend / NULLIF(l.deals, 0)) AS cost_per_deal,
       l.signed_revenue
  FROM l LEFT JOIN c USING (source);

-- Per campaign: spend, leads, visits, deals, revenue, cost per lead and per deal.
CREATE VIEW ${S}.v_campaign_roi AS
SELECT c.campaign_id, c.campaign_name, c.source, p.project_name, c.start_date, c.end_date, c.budget_ils,
       COUNT(l.lead_id) AS leads,
       COUNT(l.lead_id) FILTER (WHERE l.visit_date IS NOT NULL) AS office_visits,
       COUNT(d.deal_id) AS deals,
       COALESCE(SUM(d.final_price), 0) AS signed_revenue,
       ROUND(c.budget_ils / NULLIF(COUNT(l.lead_id), 0)) AS cost_per_lead,
       ROUND(c.budget_ils / NULLIF(COUNT(d.deal_id), 0)) AS cost_per_deal
  FROM ${S}.campaigns c
  JOIN ${S}.projects p ON p.project_id = c.project_id
  LEFT JOIN ${S}.leads l ON l.campaign_id = c.campaign_id
  LEFT JOIN ${S}.deals d ON d.lead_id = l.lead_id
 GROUP BY c.campaign_id, c.campaign_name, c.source, p.project_name, c.start_date, c.end_date, c.budget_ils;

-- Per sales rep: speed to first call, conversion, discounts — and the discount given above the company average.
CREATE VIEW ${S}.v_rep_performance AS
WITH avgd AS (SELECT AVG(discount_pct) AS company_avg_discount_pct FROM ${S}.deals),
l AS (
  SELECT rep_name, COUNT(*) AS leads,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_response_minutes)::numeric) AS median_first_response_minutes,
         ROUND(100.0 * COUNT(*) FILTER (WHERE first_response_minutes <= 60) / COUNT(*), 1) AS pct_answered_within_hour
    FROM ${S}.leads GROUP BY rep_name
),
d AS (
  SELECT d.rep_name, COUNT(*) AS deals, SUM(d.final_price) AS signed_revenue,
         ROUND(AVG(d.discount_pct), 2) AS avg_discount_pct, SUM(d.discount_ils) AS total_discount_ils,
         ROUND(SUM(GREATEST(d.discount_pct - a.company_avg_discount_pct, 0) / 100 * d.list_price)) AS discount_above_company_avg_ils
    FROM ${S}.deals d CROSS JOIN avgd a GROUP BY d.rep_name
)
SELECT l.rep_name, l.leads, l.median_first_response_minutes, l.pct_answered_within_hour,
       COALESCE(d.deals, 0) AS deals, ROUND(100.0 * COALESCE(d.deals, 0) / l.leads, 2) AS conversion_pct,
       COALESCE(d.signed_revenue, 0) AS signed_revenue, d.avg_discount_pct,
       ROUND((SELECT company_avg_discount_pct FROM avgd), 2) AS company_avg_discount_pct,
       COALESCE(d.total_discount_ils, 0) AS total_discount_ils, COALESCE(d.discount_above_company_avg_ils, 0) AS discount_above_company_avg_ils
  FROM l LEFT JOIN d USING (rep_name);

-- Close rate of each buyer segment by the benefit it was offered (decided negotiations only).
CREATE VIEW ${S}.v_segment_benefit AS
SELECT purchase_purpose, offered_benefit,
       COUNT(*) AS negotiations,
       COUNT(*) FILTER (WHERE status = 'נחתם חוזה') AS signed,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'נחתם חוזה') / COUNT(*), 1) AS close_rate_pct
  FROM ${S}.leads
 WHERE offered_benefit IS NOT NULL AND status IN ('נחתם חוזה', 'אבוד')
 GROUP BY purchase_purpose, offered_benefit;

-- Open leads worth a call today: how far along they are, whether they can buy,
-- whether a fitting unit is free, and how long nobody has talked to them.
CREATE VIEW ${S}.v_call_today AS
WITH last AS (
  SELECT lead_id, MAX(activity_ts) AS last_contact_ts FROM ${S}.activities GROUP BY lead_id
), avail AS (
  SELECT project_id, rooms, MIN(list_price) AS cheapest_free_price, COUNT(*) AS free_units
    FROM ${S}.units WHERE status = 'פנויה' GROUP BY 1, 2
), base AS (
  SELECT l.lead_id, l.full_name, l.phone_masked AS phone, p.project_name, l.status, l.purchase_purpose, l.rooms_wanted, l.budget,
         l.mortgage_preapproved, l.source, l.rep_name, l.visit_date, l.offered_benefit,
         CURRENT_DATE - last.last_contact_ts::date AS days_without_contact,
         a.cheapest_free_price, COALESCE(a.free_units, 0) AS free_units_of_wanted_size,
         (a.cheapest_free_price IS NOT NULL AND a.cheapest_free_price <= l.budget * 1.05) AS budget_fits
    FROM ${S}.leads l
    JOIN ${S}.projects p ON p.project_id = l.project_id
    JOIN last ON last.lead_id = l.lead_id
    LEFT JOIN avail a ON a.project_id = l.project_id AND a.rooms = l.rooms_wanted
   WHERE l.status IN ('בטיפול', 'ביקר במשרד', 'משא ומתן')
)
SELECT b.*,
       LEAST(100, (CASE b.status WHEN 'משא ומתן' THEN 40 WHEN 'ביקר במשרד' THEN 25 ELSE 8 END)
         + (CASE WHEN b.mortgage_preapproved THEN 20 ELSE 0 END)
         + (CASE WHEN b.budget_fits THEN 20 ELSE 0 END)
         + (CASE WHEN b.source IN ('המלצת חבר', 'יריד נדל"ן', 'ערב השקה') THEN 10 ELSE 0 END)
         + LEAST(10, b.days_without_contact)) AS lead_score,
       CONCAT_WS(' · ',
         CASE b.status WHEN 'משא ומתן' THEN 'בשלב משא ומתן' WHEN 'ביקר במשרד' THEN 'ביקר במשרד המכירות' ELSE 'בטיפול' END,
         CASE WHEN b.mortgage_preapproved THEN 'משכנתא מאושרת' END,
         CASE WHEN b.budget_fits THEN 'יש דירת ' || b.rooms_wanted || ' חד׳ פנויה שמתאימה לתקציב' END,
         CASE WHEN b.source IN ('המלצת חבר', 'יריד נדל"ן', 'ערב השקה') THEN 'הגיע מ' || b.source END,
         'אין קשר כבר ' || b.days_without_contact || ' ימים') AS reason
  FROM base b
 WHERE b.days_without_contact >= 3;
`;

async function insertBatch(pool, table, columns, rows) {
  if (rows.length === 0) return;
  const values = [];
  const params = [];
  let p = 1;
  for (const row of rows) {
    values.push(`(${columns.map(() => `$${p++}`).join(',')})`);
    for (const col of columns) params.push(row[col]);
  }
  await pool.query(`INSERT INTO ${S}.${table} (${columns.join(',')}) VALUES ${values.join(',')}`, params);
}
async function insertAll(pool, table, columns, rows, size = 1000) {
  for (let i = 0; i < rows.length; i += size) await insertBatch(pool, table, columns, rows.slice(i, i + size));
  console.log(`[seed-realestate] ${table}: ${rows.length.toLocaleString()} rows`);
}

/** The findings the demo relies on, from the generated data — the sanity check. */
function printFindings() {
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
  console.log(`\nleads ${LEADS.length}, activities ${ACTIVITIES.length}, deals ${DEALS.length}, units ${UNITS.length}, campaigns ${CAMPAIGNS.length}`);
  console.table(PROJECTS.map(p => {
    const us = UNITS.filter(u => u.project_id === p.project_id);
    const ls = LEADS.filter(l => l.project_id === p.project_id);
    return { project: p.project_name, units: us.length, sold: pct(us.filter(u => u.status === 'נמכרה').length, us.length), reserved: us.filter(u => u.status === 'שמורה').length, leads: ls.length, conv: pct(ls.filter(l => l.status === 'נחתם חוזה').length, ls.length) };
  }));
  const bySource = {};
  for (const l of LEADS) { const s = bySource[l.source] ||= { leads: 0, deals: 0, spend: 0 }; s.leads++; if (l.status === 'נחתם חוזה') s.deals++; }
  for (const c of CAMPAIGNS) (bySource[c.source] ||= { leads: 0, deals: 0, spend: 0 }).spend += c.budget_ils;
  console.table(Object.entries(bySource).map(([source, s]) => ({ source, leads: s.leads, deals: s.deals, conv: pct(s.deals, s.leads), costPerDeal: s.deals ? Math.round(s.spend / s.deals) : null })));
  const resp = (f) => { const ls = LEADS.filter(f); return `${pct(ls.filter(l => l.status === 'נחתם חוזה').length, ls.length)} of ${ls.length}`; };
  console.log('answered <=1h:', resp(l => l.first_response_minutes <= 60), '| >24h:', resp(l => l.first_response_minutes > 1440));
  const haifa = (from, to) => resp(l => l.project_id === 3 && l.lead_date >= from && l.lead_date < to);
  console.log('Haifa conversion Jun25-Apr26:', haifa('2025-06-01', '2026-04-01'), '| May26-Sep26:', haifa('2026-05-01', '2026-10-01'));
  console.table(REPS.map(r => { const ds = DEALS.filter(d => d.rep_name === r.rep_name); return { rep: r.rep_name, deals: ds.length, avgDiscount: ds.length ? (ds.reduce((a, d) => a + d.discount_pct, 0) / ds.length).toFixed(2) : '-', discountIls: ds.reduce((a, d) => a + d.discount_ils, 0) }; }));
  const seg = {};
  for (const l of LEADS) {
    if (!l.offered_benefit || !['נחתם חוזה', 'אבוד'].includes(l.status)) continue;
    const k = `${l.purchase_purpose} | ${l.offered_benefit}`;
    const s = seg[k] ||= { n: 0, signed: 0 }; s.n++; if (l.status === 'נחתם חוזה') s.signed++;
  }
  console.table(Object.entries(seg).sort().map(([k, s]) => ({ segment_benefit: k, n: s.n, close: pct(s.signed, s.n) })));
  const stuck = UNITS.filter(u => u.status === 'פנויה' && daysBetween(new Date(`${u.listed_date}T12:00:00`), END_DATE) > 180);
  console.log('stuck units (>180d):', stuck.length, '| of them Haifa 5-room north:', stuck.filter(u => u.overpriced).length, '/', UNITS.filter(u => u.overpriced).length);
  const halves = ['2025-01-01', '2025-07-01', '2026-01-01', '2026-07-01', '2027-01-01'];
  for (let i = 0; i < 4; i++) { const ls = LEADS.filter(l => l.lead_date >= halves[i] && l.lead_date < halves[i + 1]); console.log(`for-children share ${halves[i]}: ${pct(ls.filter(l => l.purchase_purpose === 'עבור הילדים').length, ls.length)}`); }
}

async function main() {
  if (DRY_RUN) { printFindings(); return; }
  const pool = getPool();
  // The SQL generator reads a CACHED schema description (public.schema_descriptions
  // in this same DB) and never re-reads it on its own — a renamed view column
  // stays invisible to it until regenerated, exactly as a reload's swap does.
  const refreshDescription = () => require('../services/schema-descriptor.service').getDescription(S, true, pool, pool);

  if (VIEWS_ONLY) {
    await pool.query(VIEWS);
    await refreshDescription();
    console.log('[seed-realestate] views recreated');
    await pool.end();
    return;
  }

  console.log('[seed-realestate] creating schema...');
  await pool.query(DDL);
  await insertAll(pool, 'projects', ['project_id', 'project_name', 'city', 'region', 'marketing_start', 'expected_delivery', 'buildings', 'floors', 'total_units'],
    PROJECTS.map(p => ({ ...p, marketing_start: p.start, expected_delivery: p.delivery, total_units: UNITS.filter(u => u.project_id === p.project_id).length })));
  await insertAll(pool, 'units', ['unit_id', 'project_id', 'building', 'floor', 'position', 'unit_number', 'rooms', 'unit_type', 'sqm', 'outdoor_sqm', 'direction', 'view', 'parking_spots', 'has_storage', 'list_price', 'status', 'listed_date', 'sold_date'], UNITS);
  await insertAll(pool, 'sales_reps', ['rep_id', 'rep_name', 'project_ids', 'start_date', 'end_date'], REPS.map(r => ({ ...r, project_ids: r.projects, start_date: r.from, end_date: r.to })));
  await insertAll(pool, 'campaigns', ['campaign_id', 'project_id', 'source', 'campaign_name', 'start_date', 'end_date', 'budget_ils'], CAMPAIGNS);
  await insertAll(pool, 'leads', ['lead_id', 'lead_date', 'lead_ts', 'project_id', 'source', 'campaign_id', 'first_name', 'last_name', 'full_name', 'phone_masked', 'gender', 'age', 'family_status', 'children', 'profession', 'income_decile', 'city_of_residence', 'purchase_purpose', 'owned_apartments', 'rooms_wanted', 'budget', 'mortgage_preapproved', 'rep_name', 'first_response_minutes', 'status', 'lost_reason', 'visit_date', 'negotiation_date', 'offered_benefit'], LEADS, 500);
  await insertAll(pool, 'activities', ['lead_id', 'activity_ts', 'activity_type', 'rep_name', 'outcome'], ACTIVITIES, 2000);
  await insertAll(pool, 'deals', ['deal_id', 'lead_id', 'unit_id', 'project_id', 'signed_date', 'rep_name', 'list_price', 'discount_pct', 'discount_ils', 'final_price', 'benefit', 'benefit_cost_ils', 'payment_plan', 'with_mortgage'], DEALS);
  await pool.query(VIEWS);
  await pool.query(`ANALYZE ${S}.leads; ANALYZE ${S}.activities; ANALYZE ${S}.units; ANALYZE ${S}.deals; ANALYZE ${S}.campaigns;`);
  await refreshDescription();
  printFindings();
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed-realestate] FAILED:', err);
    process.exit(1);
  });
}
