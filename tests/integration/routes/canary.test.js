import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const routeSource = fs.readFileSync(path.resolve('routes/canary.js'), 'utf-8');

describe('canary admin routes', () => {
  it('exposes GET /api/canary/members behind requireAdmin', () => {
    expect(routeSource).toMatch(/router\.get\(\s*'\/api\/canary\/members'/);
    const block = routeSource.slice(
      routeSource.indexOf("'/api/canary/members'"),
      routeSource.indexOf("'/api/canary/members'") + 400,
    );
    expect(block).toContain('requireAdmin');
  });

  it('exposes POST /api/canary/members behind requireAdmin', () => {
    expect(routeSource).toMatch(/router\.post\(\s*'\/api\/canary\/members'/);
    const idx = routeSource.lastIndexOf("router.post('/api/canary/members'");
    const block = routeSource.slice(idx, idx + 1500);
    expect(block).toContain('requireAdmin');
  });

  it('exposes DELETE /api/canary/members/:seniorId behind requireAdmin', () => {
    expect(routeSource).toMatch(/router\.delete\(\s*'\/api\/canary\/members\/:seniorId'/);
    const idx = routeSource.indexOf("router.delete('/api/canary/members/:seniorId'");
    const block = routeSource.slice(idx, idx + 1200);
    expect(block).toContain('requireAdmin');
  });

  it('validates senior_ids as UUIDs in POST', () => {
    expect(routeSource).toContain('UUID_PATTERN');
    expect(routeSource).toContain('All senior_ids must be valid UUIDs');
  });

  it('validates ramp_phase against the pattern in POST', () => {
    expect(routeSource).toContain('RAMP_PHASE_PATTERN');
    expect(routeSource).toContain('ramp_phase must be 1-50 chars of [A-Za-z0-9_-]');
  });

  it('rejects empty senior_ids array', () => {
    expect(routeSource).toContain('senior_ids array (or senior_id) is required');
  });

  it('limits notes length to 500 chars', () => {
    expect(routeSource).toContain('.slice(0, 500)');
  });

  it('returns 207 multi-status when some seniors failed to add', () => {
    expect(routeSource).toMatch(/res\.status\(.*207.*\)\.json\(/);
  });

  it('passes admin user_id through as addedBy/removedBy for audit', () => {
    expect(routeSource).toContain('addedBy: req.auth?.userId');
    expect(routeSource).toContain('removedBy: req.auth?.userId');
  });
});

describe('canary routes are mounted by the route aggregator', () => {
  const routesIndex = fs.readFileSync(path.resolve('routes/index.js'), 'utf-8');

  it('imports canary routes', () => {
    expect(routesIndex).toContain("import canaryRoutes from './canary.js';");
  });

  it('mounts canary routes onto the app', () => {
    expect(routesIndex).toContain('app.use(canaryRoutes);');
  });
});
