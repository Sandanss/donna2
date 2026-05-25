#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

const DEFAULT_DAYS = 30;

function parseArgs(argv) {
  const args = {
    days: DEFAULT_DAYS,
    out: null,
  };

  for (const arg of argv) {
    if (arg.startsWith('--days=')) {
      const parsed = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 365) {
        args.days = parsed;
      }
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    }
  }

  return args;
}

function normalizeValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, innerValue]) => [key, normalizeValue(innerValue)])
    );
  }
  return value;
}

function rowsFrom(result) {
  return (result?.rows || []).map(normalizeValue);
}

function safeError(error) {
  const message = String(error?.cause?.message || error?.message || error || 'unknown_error');
  return message.slice(0, 240);
}

async function collectMetric(name, collector) {
  try {
    return {
      name,
      ok: true,
      rows: rowsFrom(await collector()),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      error: safeError(error),
    };
  }
}

async function tableExists(tableName) {
  const result = await db.execute(sql`
    SELECT to_regclass(${`public.${tableName}`}) IS NOT NULL AS exists
  `);
  return Boolean(rowsFrom(result)[0]?.exists);
}

async function columnExists(tableName, columnName) {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `);
  return Boolean(rowsFrom(result)[0]?.exists);
}

async function collectBaseline({ days }) {
  const callAttemptsAvailable = await tableExists('call_attempts').catch(() => false);
  const callQueueAvailable = await tableExists('call_queue').catch(() => false);
  const postCallJobsAvailable = await tableExists('post_call_jobs').catch(() => false);
  const conversationDirectionAvailable = await columnExists('conversations', 'direction').catch(() => false);

  const metrics = [];

  metrics.push(await collectMetric('active_senior_counts', () => db.execute(sql`
    SELECT
      count(*)::int AS total_seniors,
      count(*) FILTER (WHERE is_active = true)::int AS active_seniors,
      count(*) FILTER (WHERE is_active = false)::int AS inactive_seniors
    FROM seniors
  `)));

  metrics.push(await collectMetric('connected_call_duration_seconds', () => db.execute(sql`
    SELECT
      count(*)::int AS completed_calls,
      round(avg(duration_seconds)::numeric, 2)::text AS avg_seconds,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_seconds)::numeric(12, 2)::text AS p50_seconds,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_seconds)::numeric(12, 2)::text AS p95_seconds,
      max(duration_seconds)::int AS max_seconds
    FROM conversations
    WHERE started_at >= NOW() - (${days} * INTERVAL '1 day')
      AND duration_seconds IS NOT NULL
      AND duration_seconds > 0
  `)));

  const answerRateQuery = conversationDirectionAvailable
    ? sql`
      WITH outbound AS (
        SELECT
          c.duration_seconds,
          lower(coalesce(c.status, '')) AS status,
          EXTRACT(HOUR FROM ((c.started_at AT TIME ZONE 'UTC') AT TIME ZONE coalesce(nullif(s.timezone, ''), 'UTC'))) AS local_hour
        FROM conversations c
        LEFT JOIN seniors s ON s.id = c.senior_id
        WHERE c.started_at >= NOW() - (${days} * INTERVAL '1 day')
          AND lower(coalesce(c.direction, 'outbound')) = 'outbound'
      ),
    `
    : sql`
      WITH outbound AS (
        SELECT
          c.duration_seconds,
          lower(coalesce(c.status, '')) AS status,
          EXTRACT(HOUR FROM ((c.started_at AT TIME ZONE 'UTC') AT TIME ZONE coalesce(nullif(s.timezone, ''), 'UTC'))) AS local_hour
        FROM conversations c
        LEFT JOIN seniors s ON s.id = c.senior_id
        WHERE c.started_at >= NOW() - (${days} * INTERVAL '1 day')
      ),
    `;

  metrics.push(await collectMetric(
    conversationDirectionAvailable
      ? 'outbound_answer_rate_by_local_window'
      : 'conversation_answer_rate_by_local_window_direction_unavailable',
    () => db.execute(sql`
    ${answerRateQuery}
    windowed AS (
      SELECT
        CASE
          WHEN local_hour >= 5 AND local_hour < 12 THEN 'morning'
          WHEN local_hour >= 12 AND local_hour < 17 THEN 'afternoon'
          WHEN local_hour >= 17 AND local_hour < 21 THEN 'evening'
          ELSE 'off_window'
        END AS local_window,
        duration_seconds,
        status
      FROM outbound
    )
    SELECT
      local_window,
      count(*)::int AS attempted_calls,
      count(*) FILTER (
        WHERE duration_seconds > 0
           OR status IN ('completed', 'answered', 'delivered')
      )::int AS answered_calls,
      round(
        100.0 * count(*) FILTER (
          WHERE duration_seconds > 0
             OR status IN ('completed', 'answered', 'delivered')
        ) / nullif(count(*), 0),
        2
      )::text AS answer_rate_pct
    FROM windowed
    GROUP BY local_window
    ORDER BY
      CASE local_window
        WHEN 'morning' THEN 1
        WHEN 'afternoon' THEN 2
        WHEN 'evening' THEN 3
        ELSE 4
      END
  `)));

  metrics.push(await collectMetric('estimated_peak_active_calls', () => db.execute(sql`
    WITH calls AS (
      SELECT
        started_at AS event_start,
        coalesce(
          ended_at,
          started_at + make_interval(secs => greatest(coalesce(duration_seconds, 0), 0))
        ) AS event_end
      FROM conversations
      WHERE started_at >= NOW() - (${days} * INTERVAL '1 day')
        AND duration_seconds IS NOT NULL
        AND duration_seconds > 0
    ),
    events AS (
      SELECT event_start AS event_at, 1 AS delta FROM calls
      UNION ALL
      SELECT event_end AS event_at, -1 AS delta FROM calls
    ),
    running AS (
      SELECT
        event_at,
        sum(delta) OVER (ORDER BY event_at, delta DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS active_calls
      FROM events
    )
    SELECT coalesce(max(active_calls), 0)::int AS estimated_peak_active_calls
    FROM running
  `)));

  metrics.push(await collectMetric('conversation_call_metrics_coverage', () => db.execute(sql`
    SELECT
      count(*)::int AS conversations_in_window,
      count(*) FILTER (WHERE call_metrics IS NOT NULL)::int AS conversations_with_call_metrics,
      count(*) FILTER (WHERE call_metrics::text ILIKE '%cache%')::int AS conversations_with_cache_metric_hint,
      count(*) FILTER (WHERE call_metrics::text ILIKE '%token%')::int AS conversations_with_token_metric_hint
    FROM conversations
    WHERE started_at >= NOW() - (${days} * INTERVAL '1 day')
  `)));

  if (callAttemptsAvailable) {
    metrics.push(await collectMetric('provider_attempt_outcomes', () => db.execute(sql`
      SELECT
        provider,
        status,
        count(*)::int AS attempts,
        count(*) FILTER (WHERE provider_error_code IS NOT NULL)::int AS provider_errors
      FROM call_attempts
      WHERE created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY provider, status
      ORDER BY provider, status
    `)));
  }

  if (callQueueAvailable) {
    metrics.push(await collectMetric('call_queue_depth_placeholder', () => db.execute(sql`
      SELECT
        priority_lane,
        status,
        count(*)::int AS rows,
        max(EXTRACT(EPOCH FROM (NOW() - earliest_at)))::int AS oldest_age_seconds
      FROM call_queue
      GROUP BY priority_lane, status
      ORDER BY priority_lane, status
    `)));
  }

  if (postCallJobsAvailable) {
    metrics.push(await collectMetric('post_call_backlog_placeholder', () => db.execute(sql`
      SELECT
        job_type,
        status,
        count(*)::int AS rows,
        max(EXTRACT(EPOCH FROM (NOW() - created_at)))::int AS oldest_age_seconds
      FROM post_call_jobs
      GROUP BY job_type, status
      ORDER BY job_type, status
    `)));
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: 'Aggregate counts and percentiles only. No names, phone numbers, transcripts, reminder titles, caregiver notes, or profile notes are selected.',
    },
    optionalTables: {
      callAttemptsAvailable,
      callQueueAvailable,
      postCallJobsAvailable,
    },
    optionalColumns: {
      conversationDirectionAvailable,
    },
    metrics,
    instrumentationGaps: [
      'scheduler_cycle_p50_p95 requires runtime metric emission or Railway log-derived dashboard',
      'db_pool_peak_utilization_per_service must be pulled from Neon/Railway pool telemetry until persisted metrics exist',
      'vendor concurrency and rate-limit peaks must be reconciled from vendor dashboards or explicit runtime counters',
      'Anthropic prompt-cache hit rate needs structured LLM usage metrics; conversation.call_metrics coverage above shows whether enough data exists',
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error(JSON.stringify({
      ok: false,
      error: 'DATABASE_URL is required',
    }, null, 2));
    process.exit(2);
  }

  const baseline = await collectBaseline(args);
  const output = `${JSON.stringify(baseline, null, 2)}\n`;

  if (args.out) {
    await fs.writeFile(args.out, output, 'utf8');
  } else {
    process.stdout.write(output);
  }

  const failedMetrics = baseline.metrics.filter((metric) => !metric.ok);
  process.exit(failedMetrics.length > 0 ? 1 : 0);
}

export { collectBaseline, parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: safeError(error),
    }, null, 2));
    process.exit(1);
  });
}
