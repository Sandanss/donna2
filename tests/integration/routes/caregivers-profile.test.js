import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const routeSource = fs.readFileSync(
  path.resolve('routes/caregivers.js'),
  'utf-8',
);

describe('caregiver profile route', () => {
  it('exposes PATCH /api/caregivers/me for caregiver location updates', () => {
    expect(routeSource).toMatch(
      /router\.patch\(\s*'\/api\/caregivers\/me'/,
    );
  });

  it('authenticates, validates, and idempotently protects profile writes', () => {
    const patchStart = routeSource.indexOf("router.patch('/api/caregivers/me'");
    const block = routeSource.slice(
      patchStart,
      patchStart + 900,
    );
    expect(block).toContain('requireAuth');
    expect(block).toContain('updateCaregiverSchema');
    expect(block).toContain('idempotencyMiddleware');
    expect(block).toContain('writeLimiter');
  });

  it('keeps notification preference timezone in sync with caregiver locality', () => {
    expect(routeSource).toContain('resolveTimezoneFromProfile');
    expect(routeSource).toContain('notificationPreferences');
    expect(routeSource).toContain('timezone: update.timezone');
  });
});
