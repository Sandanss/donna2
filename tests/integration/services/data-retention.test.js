import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'services', 'data-retention.js'),
  'utf8',
);

describe('data retention purge SQL', () => {
  it('uses a Postgres-compatible batch CTE instead of DELETE LIMIT', () => {
    expect(source).toContain('WITH batch AS');
    expect(source).toContain('USING batch');
    expect(source).toContain('WHERE target.ctid = batch.ctid');
    expect(source).not.toMatch(/DELETE FROM \$\{sql\.raw\(table\)\}\s+WHERE[\s\S]*LIMIT/);
  });

  it('defaults audit log retention to six years', () => {
    expect(source).toContain("RETENTION_AUDIT_LOGS_DAYS                 || '2190'");
  });

  it('redacts conversation PHI before deleting metadata', () => {
    expect(source).toContain('conversation_phi');
    expect(source).toContain('RETENTION_CONVERSATION_METADATA_DAYS');
    expect(source).toContain('summary = NULL');
    expect(source).toContain('transcript_encrypted = NULL');
  });

  it('purges expired idempotency replay cache rows by expires_at', () => {
    expect(source).toContain('idempotency_keys');
    expect(source).toContain('purgeExpiredIdempotencyKeys');
    expect(source).toContain('WHERE expires_at < NOW()');
  });

  it('expires one-time reminders one day after their scheduled event', () => {
    expect(source).toContain('purgeExpiredOnetimeReminders');
    expect(source).toContain("RETENTION_EXPIRED_ONETIME_REMINDERS_DAYS || '1'");
    expect(source).toContain('expired_onetime_reminders');
  });

  it('only deletes one-time reminders past the grace period, never recurring', () => {
    const fnStart = source.indexOf('async function purgeExpiredOnetimeReminders(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);

    expect(body).toContain('r.is_recurring = false');
    expect(body).toContain('r.scheduled_time IS NOT NULL');
    expect(body).toContain('r.scheduled_time < NOW() - make_interval(days => ${days})');
  });

  it('deletes reminder_deliveries before the parent reminder (no FK cascade)', () => {
    const fnStart = source.indexOf('async function purgeExpiredOnetimeReminders(');
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);

    expect(body).toContain('DELETE FROM reminder_deliveries');
    expect(body).toContain('DELETE FROM reminders');
    expect(body.indexOf('DELETE FROM reminder_deliveries'))
      .toBeLessThan(body.indexOf('DELETE FROM reminders'));
  });

  it('respects legal_holds on reminders and their deliveries', () => {
    const fnStart = source.indexOf('async function purgeExpiredOnetimeReminders(');
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);

    expect(body).toContain("lh.resource_type = 'reminder'");
    expect(body).toContain("lh.resource_type = 'reminder_delivery'");
    expect(body).toContain('lh.released_at IS NULL');
  });
});
