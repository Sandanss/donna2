import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool } from '@neondatabase/serverless';
import * as schema from './schema.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
});

export function getDbPoolStats() {
  return {
    max: pool.options?.max ?? null,
    total: pool.totalCount ?? null,
    idle: pool.idleCount ?? null,
    waiting: pool.waitingCount ?? null,
  };
}

export const db = drizzle(pool, { schema });
