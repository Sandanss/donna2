#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scanReminderDeliveryKeyCollisions } from './backfill-reminder-delivery-keys.js';

function firstRow(result) {
  return (result?.rows || [])[0] || {};
}

function intValue(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function tableExists(database, tableName) {
  const result = await database.execute(sql`
    SELECT to_regclass(${`public.${tableName}`}) IS NOT NULL AS exists
  `);
  return Boolean(firstRow(result).exists);
}

async function columnExists(database, tableName, columnName) {
  const result = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `);
  return Boolean(firstRow(result).exists);
}

async function requiredColumnsAvailable(database, tableName, columnNames) {
  const missing = [];

  if (!await tableExists(database, tableName)) {
    return { available: false, missing: [`${tableName} table`] };
  }

  for (const columnName of columnNames) {
    if (!await columnExists(database, tableName, columnName)) {
      missing.push(`${tableName}.${columnName}`);
    }
  }

  return {
    available: missing.length === 0,
    missing,
  };
}

function missingCheck({ name, migration, missing }) {
  return {
    name,
    migration,
    ok: false,
    blocked: true,
    duplicateKeys: 0,
    duplicateRows: 0,
    missing,
  };
}

async function countDuplicateKeys(database, { name, migration, tableName, columnName }) {
  const availability = await requiredColumnsAvailable(database, tableName, [columnName]);
  if (!availability.available) {
    return missingCheck({ name, migration, missing: availability.missing });
  }

  const result = await database.execute(sql`
    SELECT
      count(*)::int AS "duplicateKeys",
      coalesce(sum(row_count), 0)::int AS "duplicateRows"
    FROM (
      SELECT count(*)::int AS row_count
      FROM ${sql.identifier(tableName)}
      WHERE ${sql.identifier(columnName)} IS NOT NULL
        AND ${sql.identifier(columnName)}::text <> ''
      GROUP BY ${sql.identifier(columnName)}
      HAVING count(*) > 1
    ) duplicate_key_groups
  `);
  const row = firstRow(result);
  const duplicateKeys = intValue(row.duplicateKeys ?? row.duplicate_keys);
  const duplicateRows = intValue(row.duplicateRows ?? row.duplicate_rows);

  return {
    name,
    migration,
    ok: duplicateRows === 0,
    blocked: duplicateRows > 0,
    duplicateKeys,
    duplicateRows,
    missing: [],
  };
}

async function checkReminderDeliveryBackfillCollisions(database) {
  const availability = await requiredColumnsAvailable(database, 'reminder_deliveries', [
    'id',
    'reminder_id',
    'scheduled_for',
    'delivery_key',
  ]);
  const name = 'reminder_deliveries_delivery_key_backfill_collisions';
  const migration = 'db/migrations/011_call_queue_concurrent_indexes.sql';

  if (!availability.available) {
    return missingCheck({ name, migration, missing: availability.missing });
  }

  const summary = await scanReminderDeliveryKeyCollisions(database);
  return {
    name,
    migration,
    ok: summary.collisionRows === 0,
    blocked: summary.collisionRows > 0,
    candidateRows: summary.candidateRows,
    candidateKeys: summary.candidateKeys,
    collisionRows: summary.collisionRows,
    collisionKeys: summary.collisionKeys,
    duplicateCandidateRows: summary.duplicateCandidateRows,
    existingKeyConflicts: summary.existingKeyConflicts,
    missing: [],
  };
}

export async function runPhase1IdempotencyPreflight({ database = db } = {}) {
  const checks = [
    await countDuplicateKeys(database, {
      name: 'conversations_call_sid_unique_ready',
      migration: 'db/migrations/011_call_queue_concurrent_indexes.sql',
      tableName: 'conversations',
      columnName: 'call_sid',
    }),
    await countDuplicateKeys(database, {
      name: 'reminder_deliveries_delivery_key_unique_ready',
      migration: 'db/migrations/011_call_queue_concurrent_indexes.sql',
      tableName: 'reminder_deliveries',
      columnName: 'delivery_key',
    }),
    await checkReminderDeliveryBackfillCollisions(database),
    await countDuplicateKeys(database, {
      name: 'call_metrics_call_sid_unique_ready',
      migration: 'pipecat/db/migrations/024_call_queue_concurrent_indexes.sql',
      tableName: 'call_metrics',
      columnName: 'call_sid',
    }),
  ];

  const blockedChecks = checks.filter((check) => check.blocked);
  const missingChecks = checks.filter((check) => check.missing?.length > 0);
  const duplicateRows = checks.reduce((total, check) => total + intValue(check.duplicateRows), 0);
  const collisionRows = checks.reduce((total, check) => total + intValue(check.collisionRows), 0);

  return {
    ok: blockedChecks.length === 0,
    blocked: blockedChecks.length > 0,
    checkedAt: new Date().toISOString(),
    summary: {
      totalChecks: checks.length,
      blockedChecks: blockedChecks.length,
      missingChecks: missingChecks.length,
      duplicateRows,
      collisionRows,
    },
    checks,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(JSON.stringify({
      ok: false,
      error: 'DATABASE_URL is required',
    }));
    process.exit(2);
  }

  const summary = await runPhase1IdempotencyPreflight();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.blocked ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: String(error?.message || error || 'unknown_error').slice(0, 240),
    }));
    process.exit(1);
  });
}
