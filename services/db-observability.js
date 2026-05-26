import { sql } from 'drizzle-orm';
import { db, getDbPoolStats } from '../db/client.js';

const HOT_TABLES = [
  'memories',
  'prospect_memories',
  'post_call_jobs',
  'call_queue',
  'call_attempts',
  'conversations',
  'call_analyses',
  'daily_call_context',
  'call_metrics',
  'reminder_deliveries',
];

function rows(result) {
  return result?.rows || [];
}

async function safeQuery(label, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    return {
      ...fallback,
      available: false,
      unavailableReason: String(error?.code || error?.message || `${label}_unavailable`).slice(0, 160),
    };
  }
}

async function getActivitySummary() {
  return safeQuery('activity', async () => {
    const byState = await db.execute(sql`
      SELECT
        COALESCE(state, 'unknown') AS state,
        COALESCE(wait_event_type, 'none') AS wait_event_type,
        COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state, wait_event_type
      ORDER BY count DESC
    `);
    const ages = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE state = 'active')::int AS active_backends,
        COUNT(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0)::int AS blocked_backends,
        ROUND(COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - query_start))) FILTER (WHERE state = 'active'), 0))::int AS max_query_age_seconds,
        ROUND(COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - xact_start))), 0))::int AS max_transaction_age_seconds
      FROM pg_stat_activity
      WHERE datname = current_database()
    `);
    return {
      available: true,
      byState: rows(byState),
      ...(rows(ages)[0] || {}),
    };
  }, { byState: [] });
}

async function getLockSummary() {
  return safeQuery('locks', async () => {
    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE NOT granted)::int AS waiting_locks,
        COUNT(DISTINCT pid) FILTER (WHERE NOT granted)::int AS waiting_backends
      FROM pg_locks
    `);
    const blocked = await db.execute(sql`
      SELECT COUNT(*)::int AS blocked_backends
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    return {
      available: true,
      ...(rows(result)[0] || {}),
      blocked_backends: rows(blocked)[0]?.blocked_backends || 0,
    };
  }, { waiting_locks: 0, waiting_backends: 0, blocked_backends: 0 });
}

async function getHotTableStats() {
  return safeQuery('hot_tables', async () => {
    const result = await db.execute(sql`
      SELECT
        relname AS table_name,
        n_live_tup::bigint AS estimated_live_rows,
        n_dead_tup::bigint AS estimated_dead_rows,
        CASE
          WHEN n_live_tup + n_dead_tup = 0 THEN 0
          ELSE ROUND((n_dead_tup::numeric / (n_live_tup + n_dead_tup)) * 100, 2)
        END AS dead_tuple_pct,
        seq_scan::bigint AS seq_scan,
        idx_scan::bigint AS idx_scan,
        n_tup_ins::bigint AS rows_inserted,
        n_tup_upd::bigint AS rows_updated,
        n_tup_del::bigint AS rows_deleted,
        last_vacuum,
        last_autovacuum,
        last_analyze,
        last_autoanalyze
      FROM pg_stat_user_tables
      WHERE relname IN (${sql.join(HOT_TABLES.map(table => sql`${table}`), sql`, `)})
      ORDER BY
        CASE relname
          WHEN 'memories' THEN 0
          WHEN 'prospect_memories' THEN 1
          WHEN 'post_call_jobs' THEN 2
          WHEN 'call_queue' THEN 3
          ELSE 10
        END,
        relname
    `);
    return { available: true, tables: rows(result) };
  }, { tables: [] });
}

async function getSlowQueryAggregates() {
  return safeQuery('pg_stat_statements', async () => {
    const extension = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
      ) AS available
    `);
    if (!rows(extension)[0]?.available) {
      return {
        available: false,
        unavailableReason: 'pg_stat_statements extension is not enabled',
        queries: [],
      };
    }

    const result = await db.execute(sql`
      SELECT
        queryid::text AS query_id,
        calls::bigint AS calls,
        rows::bigint AS rows_returned,
        ROUND(total_exec_time::numeric, 1) AS total_exec_time_ms,
        ROUND(mean_exec_time::numeric, 1) AS mean_exec_time_ms,
        ROUND(max_exec_time::numeric, 1) AS max_exec_time_ms
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND queryid IS NOT NULL
      ORDER BY mean_exec_time DESC NULLS LAST
      LIMIT 10
    `);
    return { available: true, queries: rows(result) };
  }, { queries: [] });
}

export async function getDatabaseScalingSnapshot() {
  const [activity, locks, hotTables, slowQueries] = await Promise.all([
    getActivitySummary(),
    getLockSummary(),
    getHotTableStats(),
    getSlowQueryAggregates(),
  ]);

  return {
    capturedAt: new Date().toISOString(),
    pool: getDbPoolStats(),
    activity,
    locks,
    hotTables,
    slowQueries,
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: 'No query text, row contents, transcripts, summaries, memory content, names, or phone numbers are returned.',
    },
  };
}
