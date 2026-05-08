import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const routeSource = fs.readFileSync(
  path.resolve('routes/caregivers.js'),
  'utf-8',
);

describe('caregivers push-token registration route', () => {
  it('exposes POST /api/caregivers/me/push-token', () => {
    expect(routeSource).toMatch(
      /router\.post\(\s*'\/api\/caregivers\/me\/push-token'/,
    );
  });

  it('requires Clerk auth and rate limits writes', () => {
    const block = routeSource.slice(
      routeSource.indexOf("'/api/caregivers/me/push-token'"),
      routeSource.indexOf("'/api/caregivers/me/push-token'") + 600,
    );
    expect(block).toContain('requireAuth');
    expect(block).toContain('writeLimiter');
  });

  it('validates the token shape via pushTokenSchema', () => {
    expect(routeSource).toContain('pushTokenSchema');
    expect(routeSource).toContain('pushTokenSchema.safeParse(req.body)');
  });

  it('writes expoPushToken + expoPushTokenUpdatedAt for the caregiver', () => {
    expect(routeSource).toContain('expoPushToken: parsed.data.token');
    expect(routeSource).toContain('expoPushTokenUpdatedAt: new Date()');
  });

  it('returns 404 if the caregiver row is missing', () => {
    expect(routeSource).toContain("error: 'Caregiver not found'");
  });
});
