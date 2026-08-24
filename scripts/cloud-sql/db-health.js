// One-shot operational-DB health diagnostic.
//   node scripts/cloud-sql/db-health.js
// Answers "is anything overloading the operational DB": connection census,
// long/blocked queries, seq-scan hotspots, table sizes, index coverage.
require('dotenv').config({ path: 'c:/workspace/aspect/aspect-agent-server/.env' });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 1,
  connectionTimeoutMillis: 20000,
  statement_timeout: 30000,
});

const q = async (label, sql) => {
  try {
    const t = Date.now();
    const r = await pool.query(sql);
    console.log(`\n===== ${label}  (${Date.now() - t}ms, ${r.rowCount} rows) =====`);
    if (r.rows.length) console.table(r.rows);
    else console.log('(none)');
  } catch (e) {
    console.log(`\n===== ${label} =====\nERROR: ${e.message}`);
  }
};

(async () => {
  console.log(`Target: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);

  await q('max_connections / settings', `
    SELECT name, setting FROM pg_settings
    WHERE name IN ('max_connections','superuser_reserved_connections','shared_buffers','work_mem','statement_timeout','idle_in_transaction_session_timeout','tcp_keepalives_idle')`);

  await q('CONNECTIONS BY STATE', `
    SELECT state, count(*) AS conns, count(DISTINCT client_addr) AS distinct_ips
    FROM pg_stat_activity WHERE datname = current_database()
    GROUP BY state ORDER BY conns DESC`);

  await q('CONNECTIONS BY CLIENT IP + APP', `
    SELECT client_addr, application_name, usename, count(*) AS conns,
           count(*) FILTER (WHERE state='idle') AS idle,
           count(*) FILTER (WHERE state='active') AS active,
           count(*) FILTER (WHERE state='idle in transaction') AS idle_in_tx
    FROM pg_stat_activity WHERE datname = current_database()
    GROUP BY 1,2,3 ORDER BY conns DESC`);

  await q('TOTAL CONNS ACROSS ALL DBs ON INSTANCE', `
    SELECT COALESCE(datname,'<none>') AS datname, count(*) AS conns
    FROM pg_stat_activity GROUP BY 1 ORDER BY conns DESC`);

  await q('LONG / ACTIVE QUERIES NOW (>1s)', `
    SELECT pid, state, client_addr,
           round(EXTRACT(EPOCH FROM (now()-query_start))::numeric,1) AS secs,
           wait_event_type, wait_event, left(regexp_replace(query,'\s+',' ','g'),140) AS query
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND state <> 'idle' AND now()-query_start > interval '1 second'
    ORDER BY secs DESC LIMIT 25`);

  await q('IDLE IN TRANSACTION (leaked clients)', `
    SELECT pid, client_addr,
           round(EXTRACT(EPOCH FROM (now()-state_change))::numeric,1) AS idle_secs,
           left(regexp_replace(query,'\s+',' ','g'),120) AS last_query
    FROM pg_stat_activity
    WHERE datname = current_database() AND state LIKE 'idle in transaction%'
    ORDER BY idle_secs DESC LIMIT 20`);

  await q('BLOCKING LOCKS', `
    SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid,
           left(regexp_replace(blocked.query,'\s+',' ','g'),80) AS blocked_query,
           left(regexp_replace(blocking.query,'\s+',' ','g'),80) AS blocking_query
    FROM pg_stat_activity blocked
    JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
    WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0 LIMIT 20`);

  await q('DB-WIDE STATS (cache hit / rollbacks / deadlocks)', `
    SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
           round(100.0*blks_hit/NULLIF(blks_hit+blks_read,0),2) AS cache_hit_pct,
           tup_returned, tup_fetched, deadlocks, temp_files, pg_size_pretty(temp_bytes) AS temp_bytes,
           stats_reset
    FROM pg_stat_database WHERE datname = current_database()`);

  await q('TOP 15 TABLES BY SIZE', `
    SELECT s.relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
           s.n_live_tup, s.n_dead_tup, s.seq_scan, s.idx_scan
    FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
    ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15`);

  await q('SEQ-SCAN HOTSPOTS (tables scanned most)', `
    SELECT relname, seq_scan, seq_tup_read, idx_scan,
           CASE WHEN seq_scan>0 THEN seq_tup_read/seq_scan ELSE 0 END AS avg_rows_per_seqscan,
           n_live_tup
    FROM pg_stat_user_tables
    WHERE seq_scan > 0 ORDER BY seq_tup_read DESC LIMIT 15`);

  await q('TASKS TABLE SIZE (the whats-new query target)', `
    SELECT count(*) AS total_tasks,
           count(*) FILTER (WHERE deployed_at IS NOT NULL) AS deployed,
           pg_size_pretty(pg_total_relation_size('tasks')) AS table_size,
           pg_size_pretty(sum(pg_column_size(description))) AS description_bytes
    FROM tasks`);

  await q('INDEXES ON tasks', `
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename='tasks'`);

  // pg_stat_statements if available
  await q('TOP QUERIES BY TOTAL TIME (pg_stat_statements)', `
    SELECT calls, round(total_exec_time::numeric,0) AS total_ms,
           round(mean_exec_time::numeric,1) AS mean_ms, rows,
           left(regexp_replace(query,'\s+',' ','g'),110) AS query
    FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20`);

  await pool.end();
})();
