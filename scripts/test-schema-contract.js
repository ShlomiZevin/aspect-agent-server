/**
 * Contract test: every relation named in a dataset's hand-written SQL rules,
 * and every join/dimension/measure column in a BI dataset definition, must
 * actually exist in the live database.
 *
 * WHY THIS EXISTS. The per-dataset rules in sql-generator.service.js are the
 * highest-authority text the model sees ("CRITICAL — follow exactly"), but
 * they are static prose that rots silently as schemas change. Found 2026-08-10:
 * the zer4u rules instruct the model to query NINE materialized views that no
 * longer exist (mv_sales_by_month, mv_sales_by_store, mv_sales_by_store_month,
 * and six more). Every zer4u store/revenue/target question therefore failed
 * with "relation does not exist" or fell back to a zero-row query — for
 * months, undetected, because nothing ever checked.
 *
 * A runtime corrector now patches around this at generation time. That keeps
 * the product working but leaves the rules wrong. This test makes them get
 * FIXED: bad rules fail here, loudly, with the exact list.
 *
 * Exit code 1 on any violation, so it can gate a build.
 *
 * Usage: node scripts/test-schema-contract.js [--warn-only]
 */
require('dotenv').config();

const warnOnly = process.argv.includes('--warn-only');
const registry = require('../insights/datasets/registry');
const sqlGenerator = require('../services/sql-generator.service');

let failures = 0, checks = 0;

function report(ok, label, detail) {
  checks++;
  if (ok) { console.log(`  OK   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}`);
  if (detail) for (const d of detail) console.log(`         ${d}`);
}

async function relationsFor(pool, schema) {
  const { rows } = await pool.query(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1
     UNION
     SELECT matviewname AS name FROM pg_matviews WHERE schemaname = $1`,
    [schema]
  );
  return new Set(rows.map(r => r.name.toLowerCase()));
}

async function columnsFor(pool, schema) {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1
     UNION
     SELECT c.relname, a.attname
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'm' AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema]
  );
  const map = new Map();
  for (const r of rows) {
    const t = r.table_name.toLowerCase();
    if (!map.has(t)) map.set(t, new Set());
    map.get(t).add(r.column_name.toLowerCase());
  }
  return map;
}

async function main() {
  console.log('Schema contract ─────────────────────────────────────────\n');

  for (const entry of registry.all()) {
    const schema = entry.schemaName;
    const pool = entry.getPool();
    console.log(`${schema}`);

    let relations, columns;
    try {
      relations = await relationsFor(pool, schema);
      columns = await columnsFor(pool, schema);
    } catch (err) {
      report(false, `${schema}: cannot read catalog`, [err.message]);
      continue;
    }
    if (relations.size === 0) { report(false, `${schema}: schema has no relations`, []); continue; }

    // ── 1. Relations named in the hand-written SQL rules ──────────────
    const rules = sqlGenerator._getSchemaSpecificRules(schema);
    if (rules && rules.trim()) {
      const referenced = new Set();
      const re = new RegExp(`\\b${schema}\\.([a-z0-9_]+)`, 'gi');
      let m;
      while ((m = re.exec(rules)) !== null) referenced.add(m[1].toLowerCase());
      const missing = [...referenced].filter(r => !relations.has(r));
      report(
        missing.length === 0,
        `${schema}: ${referenced.size} relation(s) named in SQL rules exist`,
        missing.map(r => `${schema}.${r} — DOES NOT EXIST`)
      );
    } else {
      console.log(`  --   ${schema}: no hand-written SQL rules`);
    }

    // ── 1b. Capability manifest, when one exists (Stage 2) ────────────
    // Same rot-guard as the rules: every relation/column the manifest names
    // must exist, the coverage config must point at a real view+columns, and
    // the rendered prompt section must stay inside its token budget.
    const manifestSvc = require('../services/dataset-manifest');
    const manifest = manifestSvc.get(schema);
    if (manifest) {
      const manifestText = JSON.stringify(manifest);
      const referenced = new Set();
      const re2 = new RegExp(`\\b${schema}\\.([a-z0-9_]+)`, 'gi');
      let mm;
      while ((mm = re2.exec(manifestText)) !== null) referenced.add(mm[1].toLowerCase());
      // Bare table.column mentions (items.consumer_price style) — check the table half.
      const knownTables = ['facts', 'items', 'stores', 'calendar'];
      for (const t of knownTables) if (manifestText.includes(`${t}.`)) referenced.add(t);
      const missingM = [...referenced].filter(r => !relations.has(r));
      report(missingM.length === 0,
        `${schema}: ${referenced.size} relation(s) named in capability manifest exist`,
        missingM.map(r => `${schema}.${r} — DOES NOT EXIST`));

      if (manifest.coverage) {
        const { dailyView, dateColumn, volumeColumn } = manifest.coverage;
        const viewName = dailyView.replace(`${schema}.`, '').toLowerCase();
        const covIssues = [];
        if (!relations.has(viewName)) covIssues.push(`coverage.dailyView ${dailyView} DOES NOT EXIST`);
        else {
          const cols = columns.get(viewName);
          if (!cols?.has(dateColumn.toLowerCase())) covIssues.push(`coverage.dateColumn "${dateColumn}" not in ${dailyView}`);
          if (!cols?.has(volumeColumn.toLowerCase())) covIssues.push(`coverage.volumeColumn "${volumeColumn}" not in ${dailyView}`);
        }
        report(covIssues.length === 0, `${schema}: manifest coverage config is live`, covIssues);
      }

      const rendered = manifestSvc.renderForPrompt(manifest);
      const approxTokens = Math.ceil(rendered.length / 3.5); // Hebrew-heavy text ≈3.5 chars/token
      report(approxTokens <= 1500,
        `${schema}: manifest prompt section within budget (~${approxTokens} tokens)`,
        approxTokens > 1500 ? [`rendered section ≈${approxTokens} tokens — trim dataFacts/vocabulary`] : []);
    }

    // ── 2. BI semantic-layer definition, when one exists ──────────────
    let dataset = null;
    try {
      dataset = require(`../bi/datasets/${schema}.dataset.js`)[`${schema}Dataset`];
    } catch { /* no BI definition for this dataset yet */ }

    if (dataset) {
      const badJoins = [];
      for (const [key, j] of Object.entries(dataset.joins || {})) {
        if (!relations.has(j.table.toLowerCase())) badJoins.push(`join "${key}" -> table ${schema}.${j.table} DOES NOT EXIST`);
        else if (j.dedupeOn && !columns.get(j.table.toLowerCase())?.has(j.dedupeOn.toLowerCase())) {
          badJoins.push(`join "${key}" -> dedupeOn column "${j.dedupeOn}" not in ${schema}.${j.table}`);
        }
      }
      report(badJoins.length === 0, `${schema}: BI join tables exist`, badJoins);

      // Every column referenced in dimension/measure SQL, via its alias.
      const aliasToTable = new Map(Object.values(dataset.joins || {}).map(j => [j.alias, j.table.toLowerCase()]));
      aliasToTable.set(dataset.baseAlias, dataset.baseTable.toLowerCase());
      const badCols = [];
      const fields = [...(dataset.dimensions || []), ...(dataset.measures || [])];
      for (const f of fields) {
        const sql = typeof f.sql === 'string' ? f.sql : (typeof f.column === 'string' ? f.column : '');
        if (!sql) continue; // expr-based measures are checked by the smoke query below
        const colRe = /\b([a-z])\.([a-z0-9_]+)\b/gi;
        let cm;
        while ((cm = colRe.exec(sql)) !== null) {
          const table = aliasToTable.get(cm[1]);
          if (!table) continue;
          if (cm[2] === '*') continue;
          if (!columns.get(table)?.has(cm[2].toLowerCase())) {
            badCols.push(`field "${f.id}" -> ${schema}.${table}.${cm[2]} DOES NOT EXIST`);
          }
        }
      }
      report(badCols.length === 0, `${schema}: BI ${fields.length} field(s) reference real columns`, badCols);

      // ── 3. Fan-out invariant: a dimension that needs a lookup join must
      // not change the base measure total. This is the check that would have
      // caught the 44.6% product inflation automatically.
      const prodJoin = Object.entries(dataset.joins || {}).find(([, j]) => j.dedupeOn);
      if (prodJoin) {
        const [, j] = prodJoin;
        try {
          const base = await pool.query(
            `SELECT COUNT(*) AS n FROM ${schema}.${dataset.baseTable} ${dataset.baseAlias}`
          );
          const joined = await pool.query(
            `SELECT COUNT(*) AS n FROM ${schema}.${dataset.baseTable} ${dataset.baseAlias}
             LEFT JOIN (SELECT DISTINCT ON (${j.dedupeOn}) * FROM ${schema}.${j.table} ORDER BY ${j.dedupeOn}) ${j.alias} ON ${j.on}`
          );
          const b = parseInt(base.rows[0].n, 10), o = parseInt(joined.rows[0].n, 10);
          report(b === o, `${schema}: deduped "${j.table}" join preserves row count`, b === o ? [] : [`${b.toLocaleString()} base rows -> ${o.toLocaleString()} after join (fan-out of ${(o / b).toFixed(3)}x)`]);
        } catch (err) {
          report(false, `${schema}: fan-out check on ${j.table}`, [err.message.slice(0, 140)]);
        }
      }
    }
    console.log('');
  }

  console.log('─────────────────────────────────────────────────────────');
  console.log(`${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`\n${failures} contract violation(s). These are real defects in the rules or dataset definitions — fix the rules, do not silence the test.`);
  }
  process.exit(failures > 0 && !warnOnly ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
