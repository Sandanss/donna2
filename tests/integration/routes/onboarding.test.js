/**
 * Onboarding Route Tests
 *
 * Verifies the onboarding route handler uses the correct field names
 * after the topicsToAvoid rename (Bug #9) and stores data properly.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { onboardingSchema } from '../../../validators/schemas.js';

// Read the actual route source
const routeSource = fs.readFileSync(
  path.resolve('routes/onboarding.js'),
  'utf-8',
);

describe('Onboarding Route (Bug #9 — topicsToAvoid rename)', () => {
  it('destructures topicsToAvoid from request body', () => {
    expect(routeSource).toContain('topicsToAvoid');
    // Verify it does NOT destructure the old updateTopics field
    const destructureLine = routeSource.match(/const\s*\{[^}]*\}\s*=\s*req\.body/);
    expect(destructureLine).not.toBeNull();
    expect(destructureLine[0]).toContain('topicsToAvoid');
    expect(destructureLine[0]).not.toContain('updateTopics');
  });

  it('stores topicsToAvoid where schedule and voice prompt paths can read it', () => {
    expect(routeSource).toContain('topicsToAvoidText');
    expect(routeSource).toContain('topicsToAvoid: topicsToAvoidText || undefined');
    expect(routeSource).toContain('topicsToAvoid: topicsToAvoid || []');
    // Verify it does NOT store under updateTopics key
    expect(routeSource).not.toMatch(/updateTopics:\s*topicsToAvoid/);
    expect(routeSource).not.toMatch(/updateTopics:\s*updateTopics/);
  });

  it('validates with onboardingSchema that accepts topicsToAvoid', () => {
    const result = onboardingSchema.safeParse({
      senior: { name: 'Test', phone: '5551234567' },
      relation: 'Daughter',
      topicsToAvoid: ['politics'],
    });
    expect(result.success).toBe(true);
    expect(result.data.topicsToAvoid).toEqual(['politics']);
  });

  it('schema rejects old updateTopics field (stripped by Zod)', () => {
    const result = onboardingSchema.safeParse({
      senior: { name: 'Test', phone: '5551234567' },
      relation: 'Daughter',
      updateTopics: ['politics'],
    });
    expect(result.success).toBe(true);
    // Zod strips unknown keys
    expect(result.data).not.toHaveProperty('updateTopics');
    expect(result.data).not.toHaveProperty('topicsToAvoid');
  });
});

describe('Onboarding Route — Reminder Creation (Bug #8)', () => {
  it('uses reminders as string array for titles', () => {
    // Verify the schema accepts plain strings for reminders
    const result = onboardingSchema.safeParse({
      senior: { name: 'Test', phone: '5551234567' },
      relation: 'Daughter',
      reminders: ['Take medication', 'Doctor appointment tomorrow'],
    });
    expect(result.success).toBe(true);
    expect(result.data.reminders).toEqual(['Take medication', 'Doctor appointment tomorrow']);
  });

  it('route creates reminders from string titles', () => {
    // Verify the route iterates over reminderStrings and uses them as titles
    expect(routeSource).toContain('reminderTitle.trim()');
    expect(routeSource).toContain("title: reminderTitle.trim()");
  });

  it('creates onboarding records inside a transaction', () => {
    expect(routeSource).toContain('db.transaction');
    expect(routeSource).toContain('tx.insert(seniors)');
    expect(routeSource).toContain('tx.insert(caregivers)');
    expect(routeSource).toContain('tx.insert(reminders)');
  });
});

describe('Onboarding Route — Security', () => {
  it('uses requireAuth middleware', () => {
    expect(routeSource).toContain('requireAuth');
  });

  it('uses writeLimiter middleware', () => {
    expect(routeSource).toContain('writeLimiter');
  });

  it('uses validateBody with onboardingSchema', () => {
    expect(routeSource).toContain('validateBody(onboardingSchema)');
  });

  it('requires Clerk authentication (rejects cofounder token)', () => {
    expect(routeSource).toContain("clerkUserId === 'cofounder'");
  });

  it('does not depend on client-provided caregiver email', () => {
    expect(routeSource).toContain('clerkUserId = req.auth.userId');
    expect(routeSource).not.toContain('caregiver.email');
  });

  it('does not auto-link a new Clerk user to an existing senior by phone', () => {
    expect(routeSource).toContain("pgCode === '23505'");
    expect(routeSource).toContain('This phone number is already registered for another senior');
    expect(routeSource).not.toContain('seniorService.findByPhone');
    expect(routeSource).not.toContain('caregiverService.linkUserToSenior');
    expect(routeSource).not.toContain('Reused existing senior');
  });

  it('blocks caregiver and senior phone reuse unless relation is Myself', () => {
    expect(routeSource).toContain('blocksCaregiverPhoneReuse');
    expect(routeSource).toContain("relation !== 'Myself'");
    expect(routeSource).toContain('senior_phone_matches_caregiver');
  });
});
