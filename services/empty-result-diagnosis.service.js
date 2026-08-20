/**
 * Why did this query return zero rows?
 *
 * "No rows" has two completely different meanings and the caller sees the same
 * silence for both: (a) the question is fine and the answer really is "none",
 * or (b) the predicate can never match anything, because a column it filters
 * on is empty for the rows being asked about. Case (b) is a broken question,
 * not an empty answer, and reporting it as "no data available" is misleading —
 * the reader concludes the business has no such records when in fact the query
 * could not have found them.
 *
 * Real instance: zolstock's inventory rows (record_type = 'מלאי') have a NULL
 * transaction_date in all 2,772,637 of them, while the rules mandate filtering
 * to the latest snapshot date. Six questions came back empty and were
 * indistinguishable from genuinely-absent data.
 *
 * WHY THE CHECK IS SUBSET-AWARE. A column is rarely empty across a whole
 * table, but very often empty for one KIND of row inside a mixed table — which
 * is exactly the shape that produces silent empty answers. So the literal
 * equality predicates in the query (record_type = 'מלאי') are treated as the
 * subset being asked about, and emptiness is tested within it.
 *
 * Generic by construction: it introspects the SQL that actually ran plus the
 * live catalog, knows no schema, and returns null unless the condition truly
 * holds. A dataset without the defect never sees a behaviour change.
 */

/** `schema.table` occurrences after FROM / JOIN, deduplicated, alias captured. */
function relationsIn(sql) {
  const out = new Map();
  const re = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, schema, table, alias] = m;
    const key = `${schema}.${table}`;
    if (!out.has(key)) out.set(key, { schema, table, aliases: new Set([table]) });
    if (alias && !/^(on|where|group|order|limit|left|right|inner|full|cross|using|as)$/i.test(alias)) {
      out.get(key).aliases.add(alias.toLowerCase());
    }
  }
  return [...out.values()];
}

const SQL_WORDS = /^(and|or|not|null|true|false|select|from|where|case|when|then|else|end|current_date|current_timestamp|now|interval|date|extract|distinct|as|is|in|between|like|ilike)$/i;

function whereBody(sql) {
  const m = /\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(sql);
  return m ? m[1] : '';
}

/**
 * Column names that appear in a filtering position. Deliberately broad and
 * approximate: a false candidate costs one cheap EXISTS probe and is then
 * discarded, while a missed one only means no diagnosis. Quoted identifiers
 * are included because the generator quotes Hebrew and mixed-case columns.
 */
function filteredColumns(sql) {
  const body = whereBody(sql);
  const cols = new Set();
  const re = /(?:([a-z_][a-z0-9_]*)\.)?(?:"([^"]+)"|\b([a-z_][a-z0-9_]*)\b)\s*(?:=|<|>|<=|>=|<>|!=|\bIN\b|\bLIKE\b|\bILIKE\b|\bBETWEEN\b)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[2] || m[3];
    if (!name || SQL_WORDS.test(name)) continue;
    cols.add(JSON.stringify({ qualifier: m[1] ? m[1].toLowerCase() : null, column: name }));
  }
  return [...cols].map(s => JSON.parse(s));
}

/** Equality predicates against a string literal, e.g. `record_type = 'מלאי'`. */
function literalEqualities(sql) {
  const body = whereBody(sql);
  const out = [];
  const re = /(?:([a-z_][a-z0-9_]*)\.)?(?:"([^"]+)"|\b([a-z_][a-z0-9_]*)\b)\s*=\s*'([^']*)'/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const column = m[2] || m[3];
    if (!column || SQL_WORDS.test(column)) continue;
    out.push({ qualifier: m[1] ? m[1].toLowerCase() : null, column, value: m[4] });
  }
  return out;
}

/**
 * @returns {Promise<{column, relation, subset, message}|null>} a structural
 *   explanation, or null when the empty result is a genuine "none".
 */
async function diagnoseEmptyResult(pool, sql, { schemaHint = null, probeTimeoutMs = 5000 } = {}) {
  if (!sql || typeof sql !== 'string') return null;
  let rels = relationsIn(sql);
  if (schemaHint) rels = rels.filter(r => r.schema === schemaHint);
  if (rels.length === 0 || rels.length > 6) return null;

  const cols = filteredColumns(sql);
  if (cols.length === 0 || cols.length > 12) return null;
  const equalities = literalEqualities(sql);

  // A dedicated client with its own short timeout: this runs on a path that
  // has already failed, so it must never become a second way to hang.
  let client;
  try { client = await pool.connect(); } catch { return null; }
  try {
    await client.query(`SET statement_timeout = ${Math.max(1000, probeTimeoutMs)}`);

    for (const rel of rels) {
      const mine = c => !c.qualifier || rel.aliases.has(c.qualifier);
      const candidates = cols.filter(mine);
      if (candidates.length === 0) continue;

      let present;
      try {
        const { rows } = await client.query(
          `SELECT a.attname FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
          [rel.schema, rel.table]
        );
        present = new Set(rows.map(r => r.attname));
      } catch { continue; }

      const relation = `${rel.schema}.${rel.table}`;
      const subsetEq = equalities.filter(e => mine(e) && present.has(e.column));
      const subsetSql = subsetEq.map((e, i) => `"${e.column}" = $${i + 1}`).join(' AND ');
      const subsetVals = subsetEq.map(e => e.value);
      const subsetLabel = subsetEq.map(e => `${e.column} = '${e.value}'`).join(' and ');

      for (const c of candidates) {
        if (!present.has(c.column)) continue;
        if (subsetEq.some(e => e.column === c.column)) continue; // it defines the subset, not a victim of it
        try {
          // MAX(), not EXISTS(... LIMIT 1). Both answer "is there a non-null
          // value here", but the LIMIT form makes the planner expect to find
          // one immediately, so it picks a sequential scan — and when the
          // answer is "no" that scan runs to completion: 56s over 39M rows on
          // zolstock. MAX() ignores NULLs and can walk an index backwards,
          // which turns the same probe into 0.04s. Where no index helps, the
          // statement timeout below stops it and we simply offer no diagnosis.
          const { rows } = await client.query(
            `SELECT MAX("${c.column}") IS NOT NULL AS any_value FROM ${relation}${subsetSql ? ` WHERE ${subsetSql}` : ''}`,
            subsetVals
          );
          if (rows[0]?.any_value !== false) continue;

          // The column is empty across the subset. Distinguish "the column is
          // empty here" from "the subset itself is empty" — only the first is
          // a broken question; the second is a genuine none.
          if (subsetSql) {
            const { rows: sub } = await client.query(
              `SELECT EXISTS(SELECT 1 FROM ${relation} WHERE ${subsetSql} LIMIT 1) AS any_row`,
              subsetVals
            );
            if (sub[0]?.any_row !== true) return null;
          }

          const scope = subsetLabel ? ` for rows where ${subsetLabel}` : '';
          return {
            column: c.column,
            relation,
            subset: subsetLabel || null,
            message: `This question filters on "${c.column}", but that column is never populated in ${relation}${scope} — it is NULL in every one of those rows. The filter can therefore never match, which is why nothing came back. This is a gap in the data, not evidence that no such records exist.`,
          };
        } catch { /* probe failure (including its own timeout) must not mask the empty result */ }
      }
    }
    return null;
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }
}

module.exports = { diagnoseEmptyResult, relationsIn, filteredColumns, literalEqualities };
