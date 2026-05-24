#!/usr/bin/env node

import 'dotenv/config';
import { db } from '../db/client.js';
import { seniors } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSeniorPhi } from '../lib/phi.js';
import {
  normalizeSeniorCallScheduleRows,
  syncSeniorCallSchedulesFromPreferredCallTimes,
} from '../services/call-schedules.js';

const dryRun = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error(JSON.stringify({
    ok: false,
    error: 'DATABASE_URL is required',
    dryRun,
  }));
  process.exit(2);
}

const rows = await db.select()
  .from(seniors)
  .where(eq(seniors.isActive, true));

let seniorsWithSchedules = 0;
let normalizedSchedules = 0;
let syncedSchedules = 0;
let failed = 0;

for (const row of rows) {
  const senior = decryptSeniorPhi(row);
  const normalized = normalizeSeniorCallScheduleRows(senior);
  if (normalized.length === 0) continue;

  seniorsWithSchedules += 1;
  normalizedSchedules += normalized.length;

  if (dryRun) continue;

  try {
    const result = await syncSeniorCallSchedulesFromPreferredCallTimes(senior);
    syncedSchedules += result.upserted;
  } catch {
    failed += 1;
  }
}

console.log(JSON.stringify({
  dryRun,
  activeSeniorsScanned: rows.length,
  seniorsWithSchedules,
  normalizedSchedules,
  syncedSchedules,
  failed,
}));

process.exit(failed > 0 ? 1 : 0);
