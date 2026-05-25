/**
 * Lazy Postgres harness for the few integration tests that need real
 * `FOR UPDATE SKIP LOCKED` and advisory-lock semantics.
 *
 * If `TEST_DATABASE_URL` is set, opens a pool, applies Phase 1 migrations,
 * and exposes truncate + helpers. Otherwise, every requirement returns
 * `skip: true` so the integration tests Vitest-skip cleanly.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');

const OPS_TABLES = [
  'scheduler_shadow_comparisons',
  'outbound_call_guards',
  'post_call_jobs',
  'call_attempts',
  'call_queue',
  'senior_call_schedules',
];

let cachedPool = null;
let migrationsApplied = false;

export function isRealDbConfigured() {
  return Boolean(process.env.TEST_DATABASE_URL);
}

/**
 * Test-file helper: `it.skipIf(skipIfNoDb())(...)`. Returns true (skip) when
 * the harness can't run.
 */
export function skipIfNoDb() {
  return !isRealDbConfigured();
}

export async function getPool() {
  if (!isRealDbConfigured()) {
    throw new Error('TEST_DATABASE_URL is not set; use skipIfNoDb() before calling getPool().');
  }
  if (!cachedPool) {
    cachedPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 16,
    });
  }
  if (!migrationsApplied) {
    await applyMigrations(cachedPool);
    migrationsApplied = true;
  }
  return cachedPool;
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n');
}

function splitSqlStatements(sql) {
  // Split on `;` at end of line — naive but sufficient for our migration
  // files (no stored procedures with embedded semicolons). DO blocks use
  // $$ ... $$ which `;` doesn't split on if we look for top-level only.
  const cleaned = stripSqlComments(sql);
  const statements = [];
  let buffer = '';
  let inDollar = false;
  let dollarTag = '';

  const tokens = cleaned.split(/(\$\$)/);
  for (const token of tokens) {
    if (token === '$$') {
      inDollar = !inDollar;
      buffer += token;
      continue;
    }
    if (inDollar) {
      buffer += token;
      continue;
    }
    const parts = token.split(';');
    for (let i = 0; i < parts.length; i++) {
      buffer += parts[i];
      if (i < parts.length - 1) {
        const trimmed = buffer.trim();
        if (trimmed) statements.push(trimmed);
        buffer = '';
      }
    }
  }
  const tail = buffer.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function applyMigrations(pool) {
  const dirs = [
    path.join(REPO_ROOT, 'db', 'migrations'),
    path.join(REPO_ROOT, 'pipecat', 'db', 'migrations'),
  ];
  for (const dir of dirs) {
    let entries;
    try {
      entries = (await fs.readdir(dir)).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.sql')) continue;
      const full = path.join(dir, entry);
      const sql = await fs.readFile(full, 'utf-8');

      // CONCURRENTLY statements can't be wrapped in a transaction, so for
      // those files we split into individual statements and run each on its
      // own. Everything else runs as a single multi-statement query so
      // string literals with embedded semicolons (COMMENT ON ...) stay
      // intact. Both paths tolerate "already exists" on re-runs.
      const hasConcurrently = /\bCONCURRENTLY\b/i.test(sql);
      const statements = hasConcurrently ? splitSqlStatements(sql) : [sql];
      for (const statement of statements) {
        try {
          await pool.query(statement);
        } catch (error) {
          const message = String(error?.message || '');
          if (/already exists/i.test(message)) continue;
          if (/cannot run inside a transaction block/i.test(message)) {
            throw new Error(
              `Migration ${entry} failed: a CONCURRENTLY statement was wrapped in a transaction. ` +
              `Statement: ${statement.slice(0, 200)}...`
            );
          }
          throw new Error(`Migration ${entry} failed: ${message}`);
        }
      }
    }
  }
}

export async function truncateOpsTables() {
  const pool = await getPool();
  for (const table of OPS_TABLES) {
    try {
      await pool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    } catch {
      // Table may not exist on a partial-apply staging clone.
    }
  }
}

export async function closePool() {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    migrationsApplied = false;
  }
}
