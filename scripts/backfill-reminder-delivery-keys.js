#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

const DEFAULT_LIMIT = 5000;

function parseLimit(args) {
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  if (!limitArg) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(limitArg.split('=').slice(1).join('='), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50000) : DEFAULT_LIMIT;
}

export function buildReminderDeliveryKey({ reminderId, scheduledMinute }) {
  const reminder = String(reminderId || '').trim();
  const minute = String(scheduledMinute || '').trim();
  if (!reminder) throw new Error('reminderId is required');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(minute)) {
    throw new Error('scheduledMinute must be normalized to YYYY-MM-DDTHH:mm');
  }
  return `reminder_delivery:${reminder}:${minute}`;
}

function groupCandidates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const deliveryKey = buildReminderDeliveryKey(row);
    const group = groups.get(deliveryKey) || [];
    group.push({ ...row, deliveryKey });
    groups.set(deliveryKey, group);
  }
  return groups;
}

function firstRow(result) {
  return (result?.rows || [])[0] || {};
}

function intValue(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function scanReminderDeliveryKeyCollisions(database) {
  const result = await database.execute(sql`
    WITH candidates AS (
      SELECT
        id,
        'reminder_delivery:' || reminder_id::text || ':' ||
          to_char(date_trunc('minute', scheduled_for), 'YYYY-MM-DD"T"HH24:MI') AS delivery_key
      FROM reminder_deliveries
      WHERE delivery_key IS NULL
        AND reminder_id IS NOT NULL
        AND scheduled_for IS NOT NULL
    ),
    duplicate_candidate_keys AS (
      SELECT delivery_key, count(*)::int AS row_count
      FROM candidates
      GROUP BY delivery_key
      HAVING count(*) > 1
    ),
    collision_rows AS (
      SELECT DISTINCT c.id, c.delivery_key
      FROM candidates c
      LEFT JOIN duplicate_candidate_keys d ON d.delivery_key = c.delivery_key
      WHERE d.delivery_key IS NOT NULL
         OR EXISTS (
           SELECT 1
           FROM reminder_deliveries existing
           WHERE existing.delivery_key = c.delivery_key
             AND existing.id <> c.id
         )
    ),
    existing_conflict_keys AS (
      SELECT DISTINCT c.delivery_key
      FROM candidates c
      JOIN reminder_deliveries existing
        ON existing.delivery_key = c.delivery_key
       AND existing.id <> c.id
    )
    SELECT
      (SELECT count(*)::int FROM candidates) AS "candidateRows",
      (SELECT count(DISTINCT delivery_key)::int FROM candidates) AS "candidateKeys",
      COALESCE((SELECT sum(row_count)::int FROM duplicate_candidate_keys), 0) AS "duplicateCandidateRows",
      (SELECT count(*)::int FROM collision_rows) AS "collisionRows",
      (SELECT count(DISTINCT delivery_key)::int FROM collision_rows) AS "collisionKeys",
      (SELECT count(*)::int FROM existing_conflict_keys) AS "existingKeyConflicts"
  `);

  const row = firstRow(result);
  return {
    candidateRows: intValue(row.candidateRows ?? row.candidate_rows),
    candidateKeys: intValue(row.candidateKeys ?? row.candidate_keys),
    duplicateCandidateRows: intValue(row.duplicateCandidateRows ?? row.duplicate_candidate_rows),
    collisionRows: intValue(row.collisionRows ?? row.collision_rows),
    collisionKeys: intValue(row.collisionKeys ?? row.collision_keys),
    existingKeyConflicts: intValue(row.existingKeyConflicts ?? row.existing_key_conflicts),
  };
}

export async function backfillReminderDeliveryKeys({
  database = db,
  dryRun = true,
  limit = DEFAULT_LIMIT,
} = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50000) : DEFAULT_LIMIT;
  const preflight = await scanReminderDeliveryKeyCollisions(database);

  if (preflight.collisionRows > 0) {
    return {
      dryRun,
      scanned: 0,
      candidateRows: preflight.candidateRows,
      candidateKeys: preflight.candidateKeys,
      eligible: 0,
      collisionRows: preflight.collisionRows,
      collisionKeys: preflight.collisionKeys,
      duplicateCandidateRows: preflight.duplicateCandidateRows,
      existingKeyConflicts: preflight.existingKeyConflicts,
      wouldUpdate: 0,
      updated: 0,
      failed: 0,
      blocked: true,
    };
  }

  const result = await database.execute(sql`
    SELECT
      id::text AS id,
      reminder_id::text AS "reminderId",
      to_char(date_trunc('minute', scheduled_for), 'YYYY-MM-DD"T"HH24:MI') AS "scheduledMinute"
    FROM reminder_deliveries
    WHERE delivery_key IS NULL
      AND reminder_id IS NOT NULL
      AND scheduled_for IS NOT NULL
    ORDER BY scheduled_for ASC, id ASC
    LIMIT ${safeLimit}
  `);

  const rows = result?.rows || [];
  const groups = groupCandidates(rows);
  let collisionRows = 0;
  let eligible = 0;
  let updated = 0;
  let failed = 0;

  for (const [deliveryKey, group] of groups.entries()) {
    if (group.length > 1) {
      collisionRows += group.length;
      continue;
    }

    eligible += 1;
    if (dryRun) continue;

    const row = group[0];
    try {
      const updateResult = await database.execute(sql`
        UPDATE reminder_deliveries
        SET delivery_key = ${deliveryKey}
        WHERE id = ${row.id}::uuid
          AND delivery_key IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM reminder_deliveries existing
            WHERE existing.delivery_key = ${deliveryKey}
              AND existing.id <> ${row.id}::uuid
          )
        RETURNING id
      `);
      if ((updateResult?.rows || []).length === 1) {
        updated += 1;
      } else {
        collisionRows += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    dryRun,
    scanned: rows.length,
    candidateRows: preflight.candidateRows,
    candidateKeys: preflight.candidateKeys,
    eligible,
    collisionRows,
    collisionKeys: 0,
    duplicateCandidateRows: 0,
    existingKeyConflicts: 0,
    wouldUpdate: dryRun ? eligible : 0,
    updated,
    failed,
    blocked: false,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || !args.includes('--write');

  if (!process.env.DATABASE_URL) {
    console.error(JSON.stringify({
      ok: false,
      error: 'DATABASE_URL is required',
      dryRun,
    }));
    process.exit(2);
  }

  const summary = await backfillReminderDeliveryKeys({
    dryRun,
    limit: parseLimit(args),
  });

  console.log(JSON.stringify(summary));
  process.exit(summary.failed > 0 || summary.collisionRows > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
    }));
    process.exit(1);
  });
}
