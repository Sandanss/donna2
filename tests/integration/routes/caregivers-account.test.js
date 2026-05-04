import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const routeSource = fs.readFileSync(
  path.resolve('routes/caregivers.js'),
  'utf-8',
);

const incompleteCleanupRoute = routeSource.slice(
  routeSource.indexOf("'/api/caregivers/me/incomplete-account'"),
  routeSource.indexOf('// Delete current caregiver account'),
);

describe('caregiver account cleanup routes', () => {
  it('exposes a guarded incomplete-onboarding account cleanup route', () => {
    expect(routeSource).toContain("'/api/caregivers/me/incomplete-account'");
    expect(routeSource).toContain("req.auth.provider !== 'clerk'");
    expect(routeSource).toContain('Clerk authentication required for incomplete account cleanup');
    expect(routeSource).toContain('clerkClient.users.deleteUser(clerkUserId)');
  });

  it('refuses incomplete-account cleanup after Donna profile data exists', () => {
    expect(routeSource).toContain('caregivers.clerkUserId');
    expect(routeSource).toContain('caregiver_profile_exists');
    expect(routeSource).toContain('Donna profile already exists');
  });

  it('audits pending account cleanup without deleting senior data', () => {
    expect(incompleteCleanupRoute).toContain("resourceType: 'pending_caregiver_account'");
    expect(incompleteCleanupRoute).toContain("reason: 'onboarding_cancelled_before_completion'");
    expect(incompleteCleanupRoute).not.toContain('seniorService.hardDelete');
  });
});
