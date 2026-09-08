/**
 * The demo retail dataset Otto builds against.
 *
 * WHY IT EXISTS. Otto is a working mockup: it really writes the screen, it
 * just is not wired to a customer's database yet. So it needs a data world
 * that is shaped like a real retail dataset — the same measures, the same
 * dimensions, the same awkward edges — and small enough to embed whole inside
 * a generated screen.
 *
 * SHAPED AFTER THE REAL THING. The tables, column names and quirks mirror the
 * live datasets (see agents/zolstock/AGENT.md and
 * services/dataset-manifest/zolstock.manifest.js): sales rows keyed separately
 * from replenishment rows, list-price revenue excluding VAT at 1.18, stock as
 * a dateless snapshot, supplier lead times that come from a person rather than
 * the data. A demo that hides those makes Otto look better than it is and
 * teaches the wrong thing in a client meeting.
 *
 * The rows are invented. The shape is not.
 */

const VAT = 1.18;

/**
 * What Otto is told about the data. This is the "it already knows your data"
 * half of the product — brainstorm reads it to argue about whether a request
 * is answerable, and the builder reads it to know what it may reference.
 */
const SCHEMA = {
  datasetLabel: 'רשת קמעונאית — נתוני הדגמה',
  vatRate: VAT,
  dataThrough: '2026-08-31',

  tables: {
    sales: {
      about: 'שורת מכירה יומית לפי חנות ופריט',
      grain: 'יום × חנות × פריט',
      columns: {
        date: 'תאריך המכירה (YYYY-MM-DD)',
        store_id: 'מזהה חנות → stores.store_id',
        item_id: 'מזהה פריט → items.item_id',
        qty_sold: 'יחידות שנמכרו',
        revenue_ex_vat: `הכנסה ללא מע"מ — מחיר מחירון × כמות ÷ ${VAT}. הערכה, לא קופה: אינה כוללת הנחות ומבצעים`,
        profit_ex_vat: 'רווח גולמי ללא מע"מ — הכנסה פחות עלות',
      },
    },
    inventory: {
      about: 'צילום מצב מלאי נוכחי. אין היסטוריה ואין תאריך — אי אפשר להציג מגמת מלאי',
      grain: 'חנות × פריט (וכן שורת מחסן אחת לפריט)',
      columns: {
        store_id: 'מזהה חנות, או "WH" למחסן המרכזי',
        item_id: 'מזהה פריט',
        qty_on_hand: 'יחידות במלאי כרגע',
        qty_on_order: 'יחידות בהזמנת רכש פתוחה',
      },
    },
    items: {
      about: 'קטלוג פריטים',
      columns: {
        item_id: 'מזהה פריט',
        item_name: 'שם הפריט',
        category: 'קטגוריה',
        supplier: 'ספק מספק (החברה שממנה מזמינים)',
        cost_ex_vat: 'עלות ליחידה ללא מע"מ',
        list_price: 'מחיר מחירון לצרכן — כולל מע"מ',
        safety_stock: 'מלאי ביטחון שהוגדר לפריט',
      },
    },
    stores: {
      about: 'רשימת סניפים',
      columns: {
        store_id: 'מזהה חנות',
        store_name: 'שם הסניף',
        region: 'אזור',
      },
    },
    suppliers: {
      about: 'ספקים וזמן האספקה שלהם',
      columns: {
        supplier: 'שם הספק',
        lead_time_days: 'זמן אספקה בימים — מוזן ידנית, לא קיים בנתונים עצמם',
      },
    },
  },

  /**
   * The honesty layer, in miniature. Otto refuses rather than inventing, and
   * says which of these is the reason.
   */
  limits: [
    'מלאי הוא צילום מצב נוכחי בלבד — אין היסטוריה, ולכן אי אפשר להציג מגמת מלאי לאורך זמן',
    'ההכנסה מחושבת ממחיר מחירון ואינה כוללת הנחות ומבצעים — היא הערכה ולא מחזור בפועל',
    'אין מימד לקוח קצה, אין מוכרן, אין אמצעי תשלום ואין קמפיינים',
    'אין תאריך קבלת סחורה — אי אפשר למדוד זמן אספקה בפועל, רק את מה שהוזן ידנית בטבלת הספקים',
    'הנתונים מגיעים עד 2026-08-31; אין נתונים אחרי התאריך הזה',
  ],
};

const STORES = [
  { store_id: 'S01', store_name: 'תל אביב — דיזנגוף', region: 'מרכז' },
  { store_id: 'S02', store_name: 'רמת גן', region: 'מרכז' },
  { store_id: 'S03', store_name: 'חיפה — גרנד קניון', region: 'צפון' },
  { store_id: 'S04', store_name: 'באר שבע', region: 'דרום' },
  { store_id: 'S05', store_name: 'ירושלים — מלחה', region: 'ירושלים' },
  { store_id: 'S06', store_name: 'נתניה', region: 'שרון' },
];

const SUPPLIERS = [
  { supplier: 'ביתילי אספקה', lead_time_days: 14 },
  { supplier: 'כלים ועוד', lead_time_days: 21 },
  { supplier: 'טקסטיל הגליל', lead_time_days: 30 },
  { supplier: 'פלסטיק דרום', lead_time_days: 7 },
];

const ITEMS = [
  { item_id: 'I1001', item_name: 'סיר נירוסטה 24 ס"מ', category: 'כלי מטבח', supplier: 'ביתילי אספקה', cost_ex_vat: 38.0, list_price: 89.9, safety_stock: 40 },
  { item_id: 'I1002', item_name: 'מחבת טפלון 28 ס"מ', category: 'כלי מטבח', supplier: 'ביתילי אספקה', cost_ex_vat: 29.5, list_price: 69.9, safety_stock: 60 },
  { item_id: 'I1003', item_name: 'סט 6 כוסות זכוכית', category: 'כלי מטבח', supplier: 'כלים ועוד', cost_ex_vat: 14.2, list_price: 39.9, safety_stock: 80 },
  { item_id: 'I2001', item_name: 'מגבת רחצה גדולה', category: 'טקסטיל', supplier: 'טקסטיל הגליל', cost_ex_vat: 21.0, list_price: 59.9, safety_stock: 100 },
  { item_id: 'I2002', item_name: 'סט מצעים זוגי', category: 'טקסטיל', supplier: 'טקסטיל הגליל', cost_ex_vat: 78.0, list_price: 199.0, safety_stock: 25 },
  { item_id: 'I3001', item_name: 'מיכל אחסון 20 ליטר', category: 'אחסון', supplier: 'פלסטיק דרום', cost_ex_vat: 17.5, list_price: 44.9, safety_stock: 120 },
  { item_id: 'I3002', item_name: 'סל כביסה מתקפל', category: 'אחסון', supplier: 'פלסטיק דרום', cost_ex_vat: 12.0, list_price: 34.9, safety_stock: 90 },
  { item_id: 'I4001', item_name: 'קומקום חשמלי 1.7 ליטר', category: 'חשמל', supplier: 'כלים ועוד', cost_ex_vat: 62.0, list_price: 159.0, safety_stock: 30 },
  { item_id: 'I4002', item_name: 'מיקסר יד', category: 'חשמל', supplier: 'כלים ועוד', cost_ex_vat: 88.0, list_price: 219.0, safety_stock: 15 },
  { item_id: 'I5001', item_name: 'נר ריחני', category: 'עונתי', supplier: 'ביתילי אספקה', cost_ex_vat: 6.4, list_price: 19.9, safety_stock: 200 },
];

/**
 * Deterministic pseudo-random so the demo is identical on every machine and in
 * every screenshot. A seeded generator, not Math.random(): a client meeting
 * where the numbers moved between two loads of the same screen would undo the
 * whole point of the product.
 */
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** 120 days of sales, day × store × item, ending on the schema's data-through date. */
function buildSales() {
  const rnd = seeded(20260831);
  const rows = [];
  const end = new Date(`${SCHEMA.dataThrough}T00:00:00Z`);

  for (let back = 119; back >= 0; back--) {
    const d = new Date(end.getTime() - back * 86400000);
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    // Friday is short and Saturday is closed in Israeli retail. A demo whose
    // week is flat reads as fake to anyone who runs a shop.
    const dayFactor = dow === 6 ? 0 : dow === 5 ? 0.45 : dow === 4 ? 1.25 : 1;
    if (dayFactor === 0) continue;

    for (const store of STORES) {
      const storeFactor = 0.7 + (STORES.indexOf(store) % 3) * 0.35;
      for (const item of ITEMS) {
        if (rnd() > 0.62) continue; // not every item sells in every store every day
        const base = item.list_price > 150 ? 2 : item.list_price > 60 ? 6 : 14;
        const qty = Math.max(1, Math.round(base * dayFactor * storeFactor * (0.5 + rnd())));
        const revenue = (qty * item.list_price) / VAT;
        rows.push({
          date,
          store_id: store.store_id,
          item_id: item.item_id,
          qty_sold: qty,
          revenue_ex_vat: Number(revenue.toFixed(2)),
          profit_ex_vat: Number((revenue - qty * item.cost_ex_vat).toFixed(2)),
        });
      }
    }
  }
  return rows;
}

/**
 * Current stock. Deliberately uneven: some items are comfortably above safety
 * stock, some are below it with nothing on order, and one is at zero — so a
 * screen about replenishment has something real to find instead of a flat
 * field of zeros.
 */
function buildInventory() {
  const rnd = seeded(77001);
  const rows = [];
  for (const item of ITEMS) {
    for (const store of STORES) {
      const shortage = rnd() < 0.28;
      const qty = shortage
        ? Math.round(item.safety_stock * rnd() * 0.6)
        : Math.round(item.safety_stock * (1.2 + rnd() * 1.8));
      rows.push({ store_id: store.store_id, item_id: item.item_id, qty_on_hand: qty, qty_on_order: 0 });
    }
    rows.push({
      store_id: 'WH',
      item_id: item.item_id,
      qty_on_hand: Math.round(item.safety_stock * (0.4 + rnd() * 3)),
      qty_on_order: rnd() < 0.35 ? Math.round(item.safety_stock * (1 + rnd())) : 0,
    });
  }
  // One genuine stock-out, so "what must be ordered now" is never empty.
  const out = rows.find(r => r.item_id === 'I4002' && r.store_id === 'WH');
  if (out) { out.qty_on_hand = 0; out.qty_on_order = 0; }
  return rows;
}

const SALES = buildSales();
const INVENTORY = buildInventory();

/** Everything a generated screen may embed. Small enough to inline whole. */
function demoData() {
  return { stores: STORES, items: ITEMS, suppliers: SUPPLIERS, inventory: INVENTORY, sales: SALES };
}

/**
 * The schema as prose, for a prompt. Brainstorm gets this instead of the rows:
 * it has to argue about whether a request is answerable, which needs meaning,
 * not data.
 */
function schemaForPrompt() {
  const tables = Object.entries(SCHEMA.tables).map(([name, t]) => {
    const cols = Object.entries(t.columns).map(([c, d]) => `    - ${c}: ${d}`).join('\n');
    return `  ${name} — ${t.about}${t.grain ? ` (גרעין: ${t.grain})` : ''}\n${cols}`;
  }).join('\n\n');

  return [
    `מערך נתונים: ${SCHEMA.datasetLabel}`,
    `הנתונים מגיעים עד ${SCHEMA.dataThrough}. מע"מ ${SCHEMA.vatRate}.`,
    '',
    'טבלאות:',
    tables,
    '',
    'מגבלות שחייבים לכבד — אם בקשה נשענת על אחת מהן, אמור זאת מפורשות במקום להמציא:',
    SCHEMA.limits.map(l => `  - ${l}`).join('\n'),
  ].join('\n');
}

/** Counts only — the builder is told how much data it is embedding. */
function dataSummary() {
  return {
    stores: STORES.length,
    items: ITEMS.length,
    suppliers: SUPPLIERS.length,
    inventoryRows: INVENTORY.length,
    salesRows: SALES.length,
    firstDate: SALES[0]?.date,
    lastDate: SALES[SALES.length - 1]?.date,
  };
}

module.exports = { SCHEMA, demoData, schemaForPrompt, dataSummary, VAT };
