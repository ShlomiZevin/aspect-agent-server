/**
 * Smart Replenishment — the audit hook (A1–A12, generalized).
 *
 * READ-ONLY. No LLM, no writes, no DDL. It runs FIRST in the init pipeline,
 * before any binding exists, so it cannot be driven by one — it introspects
 * the live schema and measures what is actually there. Its output is what
 * the binding proposal is then grounded in.
 *
 * WHY THIS STEP EXISTS AT ALL, AND WHY IT IS A GATE: the client's roadmap is
 * "all suppliers, then warehouse, then branches", but a replenishment
 * recommendation needs an item to have a replenishment key, a supplier, and
 * demand history. On ZolStock only ~4.9% of catalogue items have a SKU. If
 * most suppliers turn out to have almost no coded items, the honest move is
 * to re-scope — not to ship a screen that recommends nothing. That decision
 * needs numbers, and these are the numbers.
 *
 * Everything is measured, nothing is assumed: the discriminator column, the
 * candidate keys, the supplier column, goods-receipt evidence — all are
 * detected from the schema and the data, then reported with counts. Where a
 * concept cannot be found, the audit says so rather than guessing.
 *
 * `--format=hebrew` renders the plain-Hebrew "what is missing" summary that
 * gets forwarded to the client's BI developer.
 */

const coverageService = require('../../services/coverage.service');

/** Column-name patterns for concepts we need to locate. Deliberately broad —
 *  the audit REPORTS candidates; the LLM picks, and probes verify. */
const PATTERNS = {
  supplier: /supplier|ספק|vendor|manufactur/i,
  replenishmentKey: /^sku$|_sku$|^sku_|barcode|catalog_?num/i,
  carton: /carton|pack_?size|units_per|case_?qty|אריזה/i,
  safety: /safety|min_?stock|minimum_?stock|reorder|מלאי_?ביטחון/i,
  price: /consumer_price|retail_price|list_price|^price$|מחיר/i,
  cost: /cost/i,
  qty: /qty|quantity|units|amount|כמות/i,
  date: /date|יום|תאריך/i,
  /** The whole point of A6: is there ANY evidence goods were received? */
  goodsReceipt: /receipt|received|receiv|grn|arriv|delivered|delivery_date|goods_in|קליטה|קבלה|הגעה/i,
};

async function q(pool, sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

/** Every table and materialized view in the schema, with row counts. */
async function listRelations(pool, schema) {
  const rows = await q(pool, `
    SELECT c.relname AS name,
           CASE c.relkind WHEN 'r' THEN 'table' WHEN 'm' THEN 'matview' WHEN 'v' THEN 'view' END AS kind,
           COALESCE(s.n_live_tup, 0) AS approx_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE n.nspname = $1 AND c.relkind IN ('r','m','v')
     ORDER BY 1`, [schema]);
  return rows;
}

async function listColumns(pool, schema, table) {
  return q(pool, `
    SELECT column_name AS name, data_type AS type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`, [schema, table]);
}

function findColumns(columns, pattern) {
  return columns.filter(c => pattern.test(c.name)).map(c => c.name);
}

/**
 * Detect a row-kind discriminator: a low-cardinality text column that splits
 * one wide table into several logical ones. ZolStock's `record_type` is
 * generated at load precisely because guessing the kind from NULL patterns
 * produced silently-empty answers before.
 */
async function detectDiscriminator(pool, schema, table, columns) {
  const candidates = columns.filter(c =>
    /char|text/.test(c.type) && /type|kind|category_?code|record/i.test(c.name));
  for (const c of candidates) {
    const rows = await q(pool,
      `SELECT ${c.name} AS value, COUNT(*)::bigint AS n
         FROM ${schema}.${table} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
    if (rows.length >= 2 && rows.length <= 12) {
      return { column: c.name, values: rows.map(r => ({ value: r.value, rows: Number(r.n) })) };
    }
  }
  return null;
}

/** Null rate + distinct count for one column, on a bounded sample of the table. */
async function columnCoverage(pool, schema, table, column, filter = null) {
  const whereClause = filter ? `WHERE ${filter}` : '';
  const [row] = await q(pool, `
    SELECT COUNT(*)::bigint                                    AS total,
           COUNT(${column})::bigint                            AS non_null,
           COUNT(DISTINCT ${column})::bigint                   AS distinct_values
      FROM ${schema}.${table} ${whereClause}`);
  const total = Number(row.total);
  const nonNull = Number(row.non_null);
  return {
    total,
    nonNull,
    nullRate: total ? 1 - nonNull / total : null,
    coverage: total ? nonNull / total : null,
    distinctValues: Number(row.distinct_values),
  };
}

/**
 * The audit hook.
 *
 * @param {object} ctx { schemaName, pool, settings }
 * @returns {object} the audit document — stored on the run and fed to
 *                   proposeBinding
 */
async function audit(ctx) {
  const { schemaName: schema, pool } = ctx;
  if (!pool) throw new Error('replenishment/audit: no pool for this dataset');

  const startedAt = new Date().toISOString();
  const findings = { schema, startedAt, measurements: {}, gaps: [] };
  const gap = (code, key, title, detail, params = {}) =>
    findings.gaps.push({ code, key, title, detail, params });

  // ── structure ──
  const relations = await listRelations(pool, schema);
  findings.measurements.relations = relations.map(r => ({
    name: r.name, kind: r.kind, approxRows: Number(r.approx_rows),
  }));

  const baseTables = relations.filter(r => r.kind === 'table');
  if (baseTables.length === 0) {
    gap('A0', 'no_base_tables', 'No base tables', `Schema ${schema} contains no ordinary tables.`);
    return findings;
  }

  // The fact table is the biggest base table; the catalogue is the one whose
  // columns look most like a product master. Both are REPORTED as guesses —
  // the LLM confirms them and the probes verify.
  const factTable = baseTables.slice().sort((a, b) => Number(b.approx_rows) - Number(a.approx_rows))[0];
  const factCols = await listColumns(pool, schema, factTable.name);

  const catalogCandidates = [];
  for (const t of baseTables) {
    if (t.name === factTable.name) continue;
    const cols = await listColumns(pool, schema, t.name);
    const score = [PATTERNS.replenishmentKey, PATTERNS.supplier, PATTERNS.carton,
                   PATTERNS.safety, PATTERNS.price, PATTERNS.cost]
      .reduce((n, p) => n + (findColumns(cols, p).length ? 1 : 0), 0);
    catalogCandidates.push({ table: t.name, rows: Number(t.approx_rows), score, columns: cols });
  }
  catalogCandidates.sort((a, b) => b.score - a.score || b.rows - a.rows);
  const catalog = catalogCandidates[0] || null;

  findings.measurements.detected = {
    factTable: { name: factTable.name, approxRows: Number(factTable.approx_rows) },
    catalogTable: catalog ? { name: catalog.table, approxRows: catalog.rows, matchScore: catalog.score } : null,
  };

  // ── A9 / discriminator: what kinds of row does the fact table hold? ──
  const discriminator = await detectDiscriminator(pool, schema, factTable.name, factCols);
  findings.measurements.discriminator = discriminator;
  if (!discriminator) {
    gap('A9', 'no_discriminator', 'No row-kind discriminator found',
      `${factTable.name} appears to hold one kind of row, or the kinds are implied by which columns are populated. If several kinds are mixed, a discriminator column is needed — inferring the kind from NULL patterns is how answers end up silently empty.`);
  }

  if (!catalog) {
    gap('A1', 'no_catalogue', 'No product catalogue table found',
      'Nothing in the schema looks like an item master (no supplier / SKU / price columns).');
    findings.finishedAt = new Date().toISOString();
    return findings;
  }

  // ── A1 / A2: supplier columns ──
  const supplierCols = findColumns(catalog.columns, PATTERNS.supplier);
  findings.measurements.supplierColumns = [];
  for (const col of supplierCols) {
    const cov = await columnCoverage(pool, schema, catalog.table, col);
    findings.measurements.supplierColumns.push({ column: col, ...cov });
  }
  if (supplierCols.length === 0) {
    gap('A1', 'no_supplier_col', 'No supplier column in the catalogue',
      'Without a supplier, recommendations cannot be grouped into an order for anyone.');
  } else if (supplierCols.length > 1) {
    // ZolStock has exactly this trap: `positive_supplier` is the supplying
    // company a buyer means, `supplier` is the manufacturer with Latin values
    // stored character-reversed.
    gap('A2', 'many_supplier_cols', 'More than one supplier-like column',
      `Found ${supplierCols.join(', ')}. These usually mean different things (supplying company vs manufacturer) — the wrong one produces a supplier list nobody recognises.`,
      { columns: supplierCols });
  }

  // ── A3: the replenishment key. THE gate number. ──
  //
  // Chosen by MEASURED JOIN RATE, never by column name or by which column is
  // most populated. Name-matching picked `barcode_key` here (100% populated,
  // and it matches /barcode/) over the real key `sku` (5% populated), which
  // made every per-supplier coverage figure read 100% — the exact number the
  // gate exists to judge, silently wrong. A key that does not join to the
  // stock rows is not a key, however full the column is.
  const rKeyCandidates = findColumns(catalog.columns, PATTERNS.replenishmentKey);
  const stockKeyCols = findColumns(factCols, PATTERNS.replenishmentKey);

  // Prefer the WAREHOUSE grain: that is what phase 1 recommends against, and
  // it is the one that must join. A generic "inventory" kind can be the
  // per-store snapshot, which on ZolStock is 85% unattributable by design —
  // judging the key on that would understate a key that is actually fine.
  const inventoryKinds = (discriminator?.values || [])
    .filter(v => /warehouse|stock|inventory|מלאי/i.test(String(v.value)));
  const stockKind = inventoryKinds.find(v => /warehouse|מחסן/i.test(String(v.value)))
    || inventoryKinds[0];

  findings.measurements.replenishmentKeyColumns = [];
  let bestKey = null;
  for (const col of rKeyCandidates) {
    const cov = await columnCoverage(pool, schema, catalog.table, col);
    let joinRate = null;
    let joinedRows = null;
    let stockRows = null;

    // Measure against the stock rows: what fraction of them find a catalogue
    // match on this column. The fact-side column is matched by name, but the
    // VERDICT is the measured rate, so a wrong guess simply scores 0.
    const factSideCol = stockKeyCols.find(c => c === col) || stockKeyCols[0];
    if (factSideCol && stockKind && discriminator) {
      const [r] = await q(pool, `
        SELECT COUNT(*)::bigint AS stock_rows,
               COUNT(cat.k)::bigint AS joined
          FROM ${schema}.${factTable.name} f
          LEFT JOIN (SELECT DISTINCT ${col} AS k FROM ${schema}.${catalog.table} WHERE ${col} IS NOT NULL) cat
                 ON cat.k = f.${factSideCol}
         WHERE f.${discriminator.column} = $1`, [stockKind.value]);
      stockRows = Number(r.stock_rows);
      joinedRows = Number(r.joined);
      joinRate = stockRows ? joinedRows / stockRows : null;
    }

    const entry = { column: col, ...cov, factSideColumn: factSideCol || null, stockRows, joinedRows, joinRate };
    findings.measurements.replenishmentKeyColumns.push(entry);

    // Rank by join rate first; population is only a tie-breaker.
    const better = !bestKey
      || (joinRate ?? -1) > (bestKey.joinRate ?? -1)
      || ((joinRate ?? -1) === (bestKey.joinRate ?? -1) && cov.nonNull > bestKey.nonNull);
    if (better) bestKey = entry;
  }
  if (bestKey && (bestKey.joinRate === null || bestKey.joinRate === 0)) {
    gap('A3', 'key_joins_nothing', 'No catalogue column joins to the stock rows',
      `Tried ${rKeyCandidates.join(', ')}; none matched any stock row. Stock and orders cannot be attributed to a product at all.`);
  }
  if (!bestKey) {
    gap('A3', 'no_key_col', 'No replenishment key in the catalogue',
      'Stock and orders need a key to join on. Without one no item can be recommended.');
  } else if (bestKey.coverage < 0.5) {
    gap('A3', 'key_sparse_in_catalogue', 'Most catalogue items have no replenishment key',
      `Only ${bestKey.nonNull.toLocaleString('en-GB')} of ${bestKey.total.toLocaleString('en-GB')} items (${(bestKey.coverage * 100).toFixed(1)}%) carry ${bestKey.column}. Items without one can be seen in sales but can never receive an order recommendation.`,
      { withKey: bestKey.nonNull, total: bestKey.total, coverage: bestKey.coverage, column: bestKey.column });
  }

  findings.measurements.chosenReplenishmentKey = bestKey
    ? { ...bestKey, measuredAgainstKind: stockKind?.value ?? null }
    : null;

  // Join rate of the CHOSEN key against every row kind that has one. This is
  // what tells a reviewer where the key works and where it does not — on
  // ZolStock the warehouse joins cleanly while the per-store snapshot does
  // not, and those are two different conversations with the client.
  if (bestKey && discriminator && bestKey.factSideColumn) {
    const perKind = [];
    for (const kind of discriminator.values) {
      const [r] = await q(pool, `
        SELECT COUNT(*)::bigint AS rows,
               COUNT(f.${bestKey.factSideColumn})::bigint AS keyed_rows,
               COUNT(cat.k)::bigint AS joined
          FROM ${schema}.${factTable.name} f
          LEFT JOIN (SELECT DISTINCT ${bestKey.column} AS k
                       FROM ${schema}.${catalog.table} WHERE ${bestKey.column} IS NOT NULL) cat
                 ON cat.k = f.${bestKey.factSideColumn}
         WHERE f.${discriminator.column} = $1`, [kind.value]);
      const rows = Number(r.rows);
      const keyed = Number(r.keyed_rows);
      perKind.push({
        kind: kind.value,
        rows,
        rowsCarryingKey: keyed,
        joined: Number(r.joined),
        keyPresentRate: rows ? keyed / rows : null,
        joinRate: rows ? Number(r.joined) / rows : null,
        joinRateAmongKeyed: keyed ? Number(r.joined) / keyed : null,
      });
    }
    findings.measurements.keyJoinRateByRowKind = perKind;

    for (const k of perKind) {
      // A kind that carries the key but fails to resolve it is a real
      // mapping problem. A kind that simply has no key at all is a feed gap,
      // reported separately below rather than blamed on the mapping.
      if (k.rowsCarryingKey > 0 && k.joinRateAmongKeyed !== null && k.joinRateAmongKeyed < 0.9
          && /warehouse|order|מחסן/i.test(String(k.kind))) {
        gap('A11', 'codes_not_in_catalogue', `"${k.kind}" codes are not all in the catalogue`,
          `${(100 - k.joinRateAmongKeyed * 100).toFixed(1)}% of ${k.kind} rows carry a code with no matching item. Their name, supplier and price will be blank.`,
          { kind: k.kind, missingRate: 1 - k.joinRateAmongKeyed });
      }
      if (k.rows > 1000 && k.keyPresentRate !== null && k.keyPresentRate < 0.5
          && /inventory|stock|מלאי/i.test(String(k.kind))) {
        gap('A3', 'rows_without_code', `Most "${k.kind}" rows carry no item code`,
          `${((1 - k.keyPresentRate) * 100).toFixed(1)}% of ${k.rows.toLocaleString('en-GB')} rows have no code, so they cannot be attributed to a product. This blocks that grain until the client sends an item-keyed export.`,
          { kind: k.kind, rows: k.rows, missingRate: 1 - k.keyPresentRate });
      }
    }
  }

  // ── A3 continued: per-supplier item counts vs items WITH a key ──
  const supplierCol = supplierCols[0] || null;
  if (supplierCol && bestKey) {
    const perSupplier = await q(pool, `
      SELECT COALESCE(${supplierCol}, '(none)')                       AS supplier,
             COUNT(*)::bigint                                          AS items,
             COUNT(${bestKey.column})::bigint                          AS items_with_key
        FROM ${schema}.${catalog.table}
       GROUP BY 1
       ORDER BY 3 DESC, 2 DESC
       LIMIT 50`);
    findings.measurements.perSupplier = perSupplier.map(r => ({
      supplier: r.supplier,
      items: Number(r.items),
      itemsWithKey: Number(r.items_with_key),
      keyCoverage: Number(r.items) ? Number(r.items_with_key) / Number(r.items) : 0,
    }));

    const withAny = findings.measurements.perSupplier.filter(s => s.itemsWithKey > 0);
    // "Has at least one keyed item" is far too generous a bar: a supplier with
    // 1 keyed item out of 16,648 counts under it, and on ZolStock 13 suppliers
    // qualify that way while only two have coverage you could actually order
    // against. ACTIONABLE means a real share of the catalogue is keyed AND
    // there are enough items for a purchase order to be worth raising.
    const actionable = findings.measurements.perSupplier.filter(
      s => s.keyCoverage >= 0.5 && s.itemsWithKey >= 20);
    findings.measurements.supplierSummary = {
      totalSuppliersListed: findings.measurements.perSupplier.length,
      suppliersWithAnyKeyedItem: withAny.length,
      actionableSuppliers: actionable.length,
      actionableSupplierNames: actionable.map(s => s.supplier),
    };
    if (actionable.length <= 2) {
      gap('A3', 'few_suppliers_keyed', 'Almost no supplier has usable key coverage',
        `Only ${actionable.length} supplier(s) have at least half their catalogue keyed and 20+ keyed items` +
        (actionable.length ? ` (${actionable.map(s => s.supplier).join(', ')})` : '') +
        `. ${withAny.length} more have a token handful. A purchasing screen would recommend nothing for the rest — start with the covered supplier(s) and expand once the data is completed.`,
        { actionableSuppliers: actionable.length, names: actionable.map(s => s.supplier),
          suppliersWithKeyedItems: withAny.length });
    }
  }

  // ── A7 / A8: safety stock and carton size ──
  for (const [code, label, pattern] of [
    ['A7', 'safetyStock', PATTERNS.safety],
    ['A8', 'unitsPerCarton', PATTERNS.carton],
  ]) {
    const cols = findColumns(catalog.columns, pattern);
    const measured = [];
    for (const col of cols) measured.push({ column: col, ...(await columnCoverage(pool, schema, catalog.table, col)) });
    findings.measurements[label] = measured;
    if (measured.length === 0) {
      gap(code, label === 'safetyStock' ? 'no_safety_col' : 'no_carton_col',
        `No ${label === 'safetyStock' ? 'safety stock' : 'carton size'} column`,
        label === 'safetyStock'
          ? 'Safety stock will be computed from sales variability instead, and presented as a computed value.'
          : 'Order quantities cannot be rounded to a full carton. A recommendation of 1,000 units when the carton holds 144 marks the system as a toy.');
    } else {
      const best = measured.reduce((a, b) => (b.nonNull > a.nonNull ? b : a));
      if (best.coverage !== null && best.coverage < 0.2) {
        gap(code, label === 'safetyStock' ? 'safety_sparse' : 'carton_sparse',
          `${label === 'safetyStock' ? 'Safety stock' : 'Carton size'} is mostly empty`,
          `${best.column} is populated on ${(best.coverage * 100).toFixed(1)}% of items (${best.nonNull.toLocaleString('en-GB')} of ${best.total.toLocaleString('en-GB')}).`,
          { nonNull: best.nonNull, total: best.total, coverage: best.coverage, column: best.column });
      }
    }
  }

  // ── A6: goods-receipt evidence, ANYWHERE in the schema ──
  const receiptHits = [];
  for (const t of baseTables) {
    const cols = t.name === factTable.name ? factCols : await listColumns(pool, schema, t.name);
    for (const c of cols) {
      if (PATTERNS.goodsReceipt.test(c.name)) receiptHits.push(`${t.name}.${c.name}`);
    }
  }
  findings.measurements.goodsReceiptEvidence = receiptHits;
  if (receiptHits.length === 0) {
    // This is R1 from the feasibility brief, and it is the single biggest
    // threat to correctness: with no receipts, an order placed long ago still
    // looks open, supply is over-counted, and the system UNDER-orders.
    gap('A6', 'no_goods_receipt', 'No goods-receipt data anywhere in the feed',
      'Nothing records goods arriving. Two consequences: supplier lead time can never be measured, only entered by hand; and "already on the way" may include stock that arrived months ago, which makes the system under-order. This is the most important gap on this list.');
  }

  // ── A5 / A10 / A12: date ranges per row kind ──
  const dateCols = findColumns(factCols, PATTERNS.date);
  findings.measurements.dateColumns = dateCols;
  if (dateCols.length > 0 && discriminator) {
    const dateCol = dateCols[0];
    const ranges = await q(pool, `
      SELECT ${discriminator.column} AS kind,
             COUNT(*)::bigint        AS rows,
             MIN(${dateCol})         AS from_date,
             MAX(${dateCol})         AS to_date,
             COUNT(${dateCol})::bigint AS dated_rows
        FROM ${schema}.${factTable.name}
       GROUP BY 1 ORDER BY 2 DESC`);
    findings.measurements.rowKinds = ranges.map(r => ({
      kind: r.kind,
      rows: Number(r.rows),
      datedRows: Number(r.dated_rows),
      from: r.from_date, to: r.to_date,
    }));

    for (const k of findings.measurements.rowKinds) {
      if (k.datedRows === 0) {
        gap('A10', 'rows_without_date', `"${k.kind}" rows carry no date`,
          `${k.rows.toLocaleString('en-GB')} rows with no date at all — a snapshot, not history. It cannot be trended, and demand must come from sales rows only.`,
          { kind: k.kind, rows: k.rows });
      }
    }
  } else if (dateCols.length === 0) {
    gap('A10', 'no_date_col', 'No date column on the fact table',
      'Without dates there is no demand history and no sales pace can be computed.');
  }

  // ── A10: is the last delivered day complete? ──
  // Reuses the platform's existing partial-last-day detector rather than
  // re-implementing it — it already fired on a real 27%-complete delivery.
  try {
    const manifest = require('../../services/dataset-manifest').get(schema);
    if (manifest?.coverage) {
      const cov = await coverageService.get(pool, manifest);
      findings.measurements.coverage = cov;
      if (cov?.partialLastDay) {
        gap('A10', 'partial_last_day', 'The last delivered day is incomplete',
          `${cov.dataThrough} looks partial. A recommendation computed on a partial day sees a demand crash that did not happen.`,
          { dataThrough: cov.dataThrough });
      }
    }
  } catch (e) {
    findings.measurements.coverage = { error: e.message };
  }

  findings.finishedAt = new Date().toISOString();
  findings.measurementGroups = Object.keys(findings.measurements).length;
  return findings;
}

/**
 * Plain-Hebrew "what is missing" summary.
 *
 * This is written to be FORWARDED — to the client's BI developer and to the
 * client — so it names what is missing and what it costs, without codes,
 * table names or jargon. It never claims a gap that was not measured.
 *
 * Translations are keyed by the gap's STABLE KEY, never by its English title
 * or by its A-code. Both were tried and both were wrong: several distinct
 * gaps legitimately share a code (three different situations are all "A10"),
 * and titles interpolate a row-kind name so they never match a fixed string.
 * The first run produced a report that went out half in English with two
 * explanations attached to the wrong findings — useless for the one thing it
 * exists for. An unknown key now renders a truthful generic line rather than
 * English text or somebody else's explanation.
 */
function renderHebrewGapReport(findings) {
  const lines = [];
  lines.push('נתונים חסרים — מודול חידוש מלאי');
  lines.push('');
  // "Schema" is our word, not the client's — this document goes to them.
  lines.push(`נבדק על הנתונים שהתקבלו, בתאריך ${String(findings.startedAt).slice(0, 10)}.`);
  lines.push('');

  if (!findings.gaps.length) {
    lines.push('לא נמצאו פערים חוסמים. כל הנתונים הדרושים לחישוב המלצות הזמנה קיימים.');
    return lines.join('\n');
  }

  lines.push('להלן מה שחסר כדי שנוכל להמליץ מה להזמין, כמה ומתי:');
  lines.push('');
  findings.gaps.forEach((g, i) => {
    const t = HEBREW[g.key];
    const p = g.params || {};
    lines.push(`${i + 1}. ${t ? t.title(p) : 'פער בנתונים'}`);
    lines.push(`   ${t ? t.detail(p) : 'נדרשת בדיקה מול צוות המידע.'}`);
    lines.push('');
  });

  lines.push('בלי הנתונים האלה נמשיך לעבוד, אבל חלק מהמספרים יהיו הערכה ולא נתון מדויק —');
  lines.push('וזה ייכתב במפורש בכל מסך ובכל תשובה.');
  return lines.join('\n');
}

const nf = (n) => Number(n || 0).toLocaleString('en-GB');
const pc = (v) => (v === null || v === undefined ? '' : `${(v * 100).toFixed(1)}%`);

/** Row-kind names as a Hebrew reader would say them, not as the table spells them. */
function hebrewKind(kind) {
  const map = {
    sales: 'המכירות',
    store_inventory: 'מלאי הסניפים',
    warehouse_inventory: 'מלאי המחסן',
    customer_order: 'הזמנות הלקוחות',
    purchase_order: 'הזמנות הרכש',
  };
  return map[kind] || `"${kind}"`;
}

/**
 * One entry per gap key, each taking that gap's MEASURED params so the
 * Hebrew carries the real numbers. A gap report without them is an opinion.
 */
const HEBREW = {
  no_base_tables: {
    title: () => 'לא נמצאו טבלאות נתונים',
    detail: () => 'הסכימה ריקה — אין על מה לחשב.',
  },
  no_discriminator: {
    title: () => 'אין עמודה שמסמנת את סוג השורה',
    detail: () => 'כשכמה סוגי שורות יושבים באותה טבלה בלי עמודה שמבדילה ביניהן, חלק מהתשובות יוצאות ריקות בלי שום התראה.',
  },
  no_catalogue: {
    title: () => 'לא נמצא קובץ פריטים',
    detail: () => 'בלי קובץ פריטים אין שם, ספק, מחיר או גודל אריזה — ולכן אי אפשר להמליץ על הזמנה.',
  },
  no_supplier_col: {
    title: () => 'אין עמודת ספק בקובץ הפריטים',
    detail: () => 'בלי ספק אי אפשר לקבץ את ההמלצות להזמנה אחת לכל ספק.',
  },
  many_supplier_cols: {
    title: () => 'יש יותר מעמודת ספק אחת',
    detail: (p) => `נמצאו ${(p.columns || []).join(', ')}. בדרך כלל אחת מהן היא הספק שממנו מזמינים בפועל והשנייה היא היצרן. נבקש שתאשרו איזו מהן הנכונה — בחירה שגויה תייצר רשימת ספקים שאף אחד לא מזהה.`,
  },
  key_joins_nothing: {
    title: () => 'אף עמודה בקובץ הפריטים לא מתחברת לשורות המלאי',
    detail: () => 'שורות המלאי וההזמנות לא ניתנות לשיוך לפריט כלשהו. זהו חסם מוחלט.',
  },
  no_key_col: {
    title: () => 'אין מק"ט מלאי בקובץ הפריטים',
    detail: () => 'צריך מזהה משותף בין קובץ הפריטים לבין שורות המלאי וההזמנות.',
  },
  key_sparse_in_catalogue: {
    title: () => 'לרוב הפריטים אין מק"ט מלאי',
    detail: (p) => `רק ל-${nf(p.withKey)} פריטים מתוך ${nf(p.total)} (${pc(p.coverage)}) יש מק"ט מלאי. פריט בלי מק"ט אפשר לראות במכירות, אבל אי אפשר להמליץ עליו הזמנה. זהו הפער המרכזי שמונע הרחבה לספקים נוספים.`,
  },
  rows_without_code: {
    title: (p) => `לרוב שורות ${hebrewKind(p.kind)} אין קוד פריט`,
    detail: (p) => `${pc(p.missingRate)} מתוך ${nf(p.rows)} שורות מגיעות בלי קוד פריט, ולכן אי אפשר לשייך אותן למוצר. עד שיישלח קובץ עם קוד פריט בכל שורה, החלק הזה חסום.`,
  },
  codes_not_in_catalogue: {
    title: (p) => `חלק מהקודים ב${hebrewKind(p.kind)} לא קיימים בקובץ הפריטים`,
    detail: (p) => `${pc(p.missingRate)} מהשורות נושאות קוד שאין לו פריט מתאים, ולכן השם, הספק והמחיר שלהן יישארו ריקים.`,
  },
  few_suppliers_keyed: {
    title: () => 'רק למעט ספקים יש כיסוי מק"טים שמאפשר המלצה',
    detail: (p) => `רק ל-${nf(p.actionableSuppliers)} ספקים יש לפחות מחצית מהקטלוג עם מק"ט` +
      ((p.names || []).length ? ` (${p.names.join(', ')})` : '') +
      `. לעוד ${nf(p.suppliersWithKeyedItems)} ספקים יש מספר בודד של פריטים עם מק"ט. לשאר לא תהיה שום המלצה — ולכן מומלץ להתחיל מהספקים עם הכיסוי ולהרחיב אחרי שהנתונים יושלמו.`,
  },
  no_safety_col: {
    title: () => 'אין עמודת מלאי ביטחון',
    detail: () => 'נחשב מלאי ביטחון לפי קצב המכירות ונציין בכל מסך שזה חישוב שלנו ולא נתון מהמערכת שלכם.',
  },
  safety_sparse: {
    title: () => 'מלאי ביטחון כמעט ולא מוגדר',
    detail: (p) => `מוגדר רק ל-${nf(p.nonNull)} פריטים מתוך ${nf(p.total)} (${pc(p.coverage)}). לשאר נחשב מלאי ביטחון לפי קצב המכירות ונציין שזה חישוב שלנו.`,
  },
  no_carton_col: {
    title: () => 'אין עמודת גודל אריזה',
    detail: () => 'בלי גודל אריזה לא נוכל לעגל את הכמות לארגז שלם, והמלצה של 1,000 יחידות כשבארגז יש 144 אינה ניתנת לביצוע.',
  },
  carton_sparse: {
    title: () => 'גודל אריזה כמעט ולא מוגדר',
    detail: (p) => `מוגדר רק ל-${nf(p.nonNull)} פריטים מתוך ${nf(p.total)} (${pc(p.coverage)}). לשאר לא נוכל לעגל את הכמות לארגז שלם.`,
  },
  no_goods_receipt: {
    title: () => 'אין תיעוד של קליטת סחורה',
    detail: () => 'שום קובץ לא מתעד מתי סחורה הגיעה בפועל. לכן: (1) אי אפשר למדוד זמן אספקה של ספק — הוא יוזן ידנית; (2) הזמנה שכבר סופקה ממשיכה להיראות פתוחה, ולכן המערכת "תחשוב" שיש סחורה בדרך ותזמין פחות מדי. זהו הפער החשוב ביותר ברשימה.',
  },
  rows_without_date: {
    title: (p) => `לשורות ${hebrewKind(p.kind)} אין תאריך`,
    detail: (p) => `${nf(p.rows)} שורות ללא תאריך כלל. זהו צילום מצב ולא היסטוריה — אי אפשר לראות מגמה, ולכן הביקוש מחושב ממכירות בלבד.`,
  },
  no_date_col: {
    title: () => 'אין עמודת תאריך',
    detail: () => 'בלי תאריכים אין היסטוריית ביקוש ואי אפשר לחשב קצב מכירות.',
  },
  partial_last_day: {
    title: () => 'היום האחרון בקובץ חלקי',
    detail: (p) => `נראה שהנתונים ליום ${p.dataThrough || ''} הגיעו חלקית. חישוב על יום חלקי מראה נפילת מכירות שלא באמת קרתה, ולכן היום הזה לא נלקח בחשבון.`,
  },
};

module.exports = { audit, renderHebrewGapReport, PATTERNS, HEBREW };
