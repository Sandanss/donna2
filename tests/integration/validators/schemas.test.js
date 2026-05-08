/**
 * Validator Schema Tests
 *
 * Comprehensive tests for all Zod validation schemas in validators/schemas.js.
 * Covers the bugs fixed: notification preferences field names, schedule validation,
 * reminder isActive, onboarding topicsToAvoid rename, and more.
 */

import { describe, it, expect } from 'vitest';
import {
  createSeniorSchema,
  updateSeniorSchema,
  createReminderSchema,
  updateReminderSchema,
  onboardingSchema,
  onboardingPhoneAvailabilitySchema,
  notificationPreferencesSchema,
  updateScheduleSchema,
  initiateCallSchema,
  createCaregiverSchema,
  updateCaregiverSchema,
  createMemorySchema,
  voiceAnswerSchema,
  voiceStatusSchema,
  notificationTriggerSchema,
  pushTokenSchema,
  seniorIdParamSchema,
} from '../../../validators/schemas.js';

// =============================================================================
// Notification Preferences Schema (Bug #1 fix verification)
// =============================================================================

describe('notificationPreferencesSchema', () => {
  it('accepts correct backend field names', () => {
    const result = notificationPreferencesSchema.safeParse({
      callCompleted: true,
      concernDetected: false,
      reminderMissed: true,
      weeklySummary: false,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      callCompleted: true,
      concernDetected: false,
      reminderMissed: true,
      weeklySummary: false,
    });
  });

  it('strips unknown fields (old mobile field names)', () => {
    const result = notificationPreferencesSchema.safeParse({
      missedCallAlerts: true,
      completedCallAlerts: true,
    });
    // Zod strips unknown keys by default — all fields are optional so this succeeds
    // but the result has NO data (all unknown keys stripped)
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it('accepts callSummaries and pauseCalls', () => {
    const result = notificationPreferencesSchema.safeParse({
      callSummaries: true,
      pauseCalls: false,
    });
    expect(result.success).toBe(true);
    expect(result.data.callSummaries).toBe(true);
    expect(result.data.pauseCalls).toBe(false);
  });

  it('accepts smsEnabled and emailEnabled', () => {
    const result = notificationPreferencesSchema.safeParse({
      smsEnabled: true,
      emailEnabled: false,
    });
    expect(result.success).toBe(true);
    expect(result.data.smsEnabled).toBe(true);
    expect(result.data.emailEnabled).toBe(false);
  });

  it('accepts quietHours in HH:MM format', () => {
    const result = notificationPreferencesSchema.safeParse({
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid quietHours format', () => {
    const result = notificationPreferencesSchema.safeParse({
      quietHoursStart: '10 PM',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null quietHours (to clear them)', () => {
    const result = notificationPreferencesSchema.safeParse({
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    expect(result.success).toBe(true);
    expect(result.data.quietHoursStart).toBeNull();
  });

  it('accepts valid timezone', () => {
    const result = notificationPreferencesSchema.safeParse({
      timezone: 'America/New_York',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid timezone', () => {
    const result = notificationPreferencesSchema.safeParse({
      timezone: 'Not/A_Timezone',
    });
    expect(result.success).toBe(false);
  });

  it('accepts weeklyReportDay 0-6 and weeklyReportTime', () => {
    const result = notificationPreferencesSchema.safeParse({
      weeklyReportDay: 1, // Monday
      weeklyReportTime: '09:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects weeklyReportDay outside 0-6', () => {
    const result = notificationPreferencesSchema.safeParse({
      weeklyReportDay: 7,
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = notificationPreferencesSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Schedule Update Schema (Bug #5 fix verification)
// =============================================================================

describe('updateScheduleSchema', () => {
  it('accepts valid ScheduleItem array', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Daily Call',
          frequency: 'daily',
          time: '9:00 AM',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts recurring schedule with days', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Weekly Check-in',
          frequency: 'recurring',
          recurringDays: [1, 3, 5], // Mon, Wed, Fri
          time: '14:00',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects recurring schedule without days', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Weekly Check-in',
          frequency: 'recurring',
          time: '14:00',
          // missing recurringDays
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects recurring schedule with empty days array', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Weekly',
          frequency: 'recurring',
          recurringDays: [],
          time: '14:00',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts one-time schedule with date', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Doctor Appointment Reminder',
          frequency: 'one-time',
          date: '04/10/2026',
          time: '8:30 AM',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts 24h time format', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [{ title: 'Call', frequency: 'daily', time: '14:30' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts 12h time format', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [{ title: 'Call', frequency: 'daily', time: '2:30 PM' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid time format', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [{ title: 'Call', frequency: 'daily', time: 'noon' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts topicsToAvoid field', () => {
    const result = updateScheduleSchema.safeParse({
      topicsToAvoid: ['politics', 'recent death of pet'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty object (needs at least one field)', () => {
    const result = updateScheduleSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects schedule with missing title', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [{ frequency: 'daily', time: '9:00 AM' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects schedule with invalid frequency', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [{ title: 'Call', frequency: 'monthly', time: '9:00 AM' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts multiple schedule items', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        { title: 'Morning Call', frequency: 'daily', time: '9:00 AM' },
        { title: 'Evening Call', frequency: 'daily', time: '6:00 PM' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data.schedule).toHaveLength(2);
  });

  it('accepts schedule with contextNotes', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Call',
          frequency: 'daily',
          time: '9:00 AM',
          contextNotes: 'Ask about the garden',
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data.schedule[0].contextNotes).toBe('Ask about the garden');
  });

  it('accepts schedule with valid reminderIds', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Call',
          frequency: 'daily',
          time: '9:00 AM',
          reminderIds: [uuid],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects schedule with invalid reminderIds', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Call',
          frequency: 'daily',
          time: '9:00 AM',
          reminderIds: ['not-a-uuid'],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects recurringDays outside 0-6', () => {
    const result = updateScheduleSchema.safeParse({
      schedule: [
        {
          title: 'Call',
          frequency: 'recurring',
          recurringDays: [7],
          time: '9:00 AM',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('limits schedule array to 200 items', () => {
    const items = Array.from({ length: 201 }, (_, i) => ({
      title: `Call ${i}`,
      frequency: 'daily',
      time: '9:00 AM',
    }));
    const result = updateScheduleSchema.safeParse({ schedule: items });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Create Reminder Schema (Bug #7 fix verification)
// =============================================================================

describe('createReminderSchema', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts simple reminder with isActive', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'Take medication',
      isActive: true,
    });
    expect(result.success).toBe(true);
    expect(result.data.isActive).toBe(true);
  });

  it('defaults isActive to true when not provided', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'Take medication',
    });
    expect(result.success).toBe(true);
    expect(result.data.isActive).toBe(true);
  });

  it('accepts isActive: false for creating inactive reminders', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'Old reminder',
      isActive: false,
    });
    expect(result.success).toBe(true);
    expect(result.data.isActive).toBe(false);
  });

  it('accepts simple non-recurring reminder without schedule', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      type: 'custom',
      title: 'Call dentist',
      isRecurring: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts recurring reminder with cronExpression', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      type: 'medication',
      title: 'Blood pressure pill',
      isRecurring: true,
      cronExpression: '0 9 * * *',
    });
    expect(result.success).toBe(true);
  });

  it('accepts recurring reminder without cronExpression', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'Blood pressure pill',
      isRecurring: true,
    });
    expect(result.success).toBe(true);
    expect(result.data.isRecurring).toBe(true);
    expect(result.data.cronExpression).toBeUndefined();
  });

  it('defaults type to custom', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'Generic reminder',
    });
    expect(result.success).toBe(true);
    expect(result.data.type).toBe('custom');
  });

  it('defaults isRecurring to false', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'One-time reminder',
    });
    expect(result.success).toBe(true);
    expect(result.data.isRecurring).toBe(false);
  });

  it('rejects missing title', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
    });
    expect(result.success).toBe(false);
  });

  it('rejects title exceeding 255 characters', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid seniorId', () => {
    const result = createReminderSchema.safeParse({
      seniorId: 'not-a-uuid',
      title: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid reminder types', () => {
    const types = ['medication', 'appointment', 'custom', 'wellness', 'social'];
    for (const type of types) {
      const result = createReminderSchema.safeParse({
        seniorId: validUuid,
        title: 'Test',
        type,
      });
      expect(result.success, `Type '${type}' should be valid`).toBe(true);
    }
  });

  it('rejects invalid reminder type', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'Test',
      type: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts description', () => {
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'Medication',
      description: 'Take with breakfast',
    });
    expect(result.success).toBe(true);
    expect(result.data.description).toBe('Take with breakfast');
  });

  it('accepts scheduledTime as ISO string', () => {
    const scheduledTime = '2026-04-10T09:00:00Z';
    const result = createReminderSchema.safeParse({
      seniorId: validUuid,
      title: 'Appointment',
      scheduledTime,
    });
    expect(result.success).toBe(true);
    expect(result.data.scheduledTime).toBe(scheduledTime);
  });
});

// =============================================================================
// Onboarding Schema (Bug #9 fix verification — topicsToAvoid rename)
// =============================================================================

describe('onboardingSchema', () => {
  const validPayload = {
    senior: {
      name: 'Dorothy Smith',
      phone: '5551234567',
    },
    relation: 'Daughter',
  };

  it('accepts topicsToAvoid field (renamed from updateTopics)', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      topicsToAvoid: ['politics', 'recent loss'],
    });
    expect(result.success).toBe(true);
    expect(result.data.topicsToAvoid).toEqual(['politics', 'recent loss']);
  });

  it('strips old updateTopics field (no longer in schema)', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      updateTopics: ['politics'],
    });
    // Zod strips unknown keys — updateTopics is gone
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('updateTopics');
  });

  it('accepts minimal valid payload', () => {
    const result = onboardingSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('normalizes phone number to E.164', () => {
    const result = onboardingSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    expect(result.data.senior.phone).toMatch(/^\+1\d{10}$/);
  });

  it('accepts all valid relationship types', () => {
    const relations = [
      'Myself', 'Mother', 'Father', 'Daughter', 'Son', 'Spouse', 'Sibling',
      'Grandchild', 'Uncle', 'Aunt', 'Cousin',
      'Friend', 'Professional Caregiver', 'Client', 'Other Loved One', 'Other',
    ];
    for (const relation of relations) {
      const result = onboardingSchema.safeParse({
        senior: { name: 'Test', phone: '5551234567' },
        relation,
      });
      expect(result.success, `Relation '${relation}' should be valid`).toBe(true);
    }
  });

  it('rejects invalid relationship type', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      relation: 'Boss',
    });
    expect(result.success).toBe(false);
  });

  it('accepts caregiverPhone for same-phone relationship validation', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      relation: 'Myself',
      caregiverPhone: '(555) 123-4567',
      senior: { name: 'Dorothy Smith', phone: '(555) 123-4567' },
    });

    expect(result.success).toBe(true);
    expect(result.data.caregiverPhone).toBe('+15551234567');
    expect(result.data.senior.phone).toBe('+15551234567');
  });

  it('accepts relation and caregiverPhone in phone availability checks', () => {
    const result = onboardingPhoneAvailabilitySchema.safeParse({
      phone: '(555) 123-4567',
      caregiverPhone: '+1 555 123 4567',
      relation: 'Myself',
    });

    expect(result.success).toBe(true);
    expect(result.data.phone).toBe('+15551234567');
    expect(result.data.caregiverPhone).toBe('+15551234567');
  });

  it('accepts callSchedule with days and 24h time', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      callSchedule: {
        days: ['Mon', 'Wed', 'Fri'],
        time: '09:00',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts daily callSchedule without explicit days', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      callSchedule: {
        frequency: 'daily',
        time: '09:00',
      },
    });
    expect(result.success).toBe(true);
    expect(result.data.callSchedule.frequency).toBe('daily');
  });

  it('accepts one-time callSchedule without recurring days', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      callSchedule: {
        frequency: 'one-time',
        time: '09:00',
        date: '2026-04-20T14:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects recurring callSchedule with no selected days', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      callSchedule: {
        frequency: 'recurring',
        days: [],
        time: '09:00',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects callSchedule with 12h time format', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      callSchedule: {
        days: ['Mon'],
        time: '9:00 AM',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects callSchedule with invalid day names', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      callSchedule: {
        days: ['Monday'],
        time: '09:00',
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts interests as string array', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      interests: ['gardening', 'baking', 'puzzles'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts reminders as string array', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      reminders: ['Take medication', 'Doctor appointment'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts familyInfo with interestDetails', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      familyInfo: {
        donnaLanguage: 'es',
        interestDetails: { gardening: 'Loves roses and tulips' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts senior with location fields', () => {
    const result = onboardingSchema.safeParse({
      senior: {
        name: 'Dorothy Smith',
        phone: '5551234567',
        city: 'Austin',
        state: 'TX',
        zipCode: '78701',
      },
      relation: 'Daughter',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional caregiver data', () => {
    const result = onboardingSchema.safeParse({
      ...validPayload,
      caregiver: {
        name: 'Susan Smith',
        email: 'susan@example.com',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing senior name', () => {
    const result = onboardingSchema.safeParse({
      senior: { phone: '5551234567' },
      relation: 'Daughter',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing senior phone', () => {
    const result = onboardingSchema.safeParse({
      senior: { name: 'Dorothy' },
      relation: 'Daughter',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing relation', () => {
    const result = onboardingSchema.safeParse({
      senior: { name: 'Dorothy', phone: '5551234567' },
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Phone Schema (via createSeniorSchema)
// =============================================================================

describe('phone validation (via createSeniorSchema)', () => {
  it('normalizes 10-digit US number to E.164', () => {
    const result = createSeniorSchema.safeParse({
      name: 'Test',
      phone: '5551234567',
    });
    expect(result.success).toBe(true);
    expect(result.data.phone).toBe('+15551234567');
  });

  it('normalizes formatted phone number', () => {
    const result = createSeniorSchema.safeParse({
      name: 'Test',
      phone: '(555) 123-4567',
    });
    expect(result.success).toBe(true);
    expect(result.data.phone).toBe('+15551234567');
  });

  it('handles E.164 number', () => {
    const result = createSeniorSchema.safeParse({
      name: 'Test',
      phone: '+15551234567',
    });
    expect(result.success).toBe(true);
    expect(result.data.phone).toBe('+15551234567');
  });

  it('rejects too-short phone number', () => {
    const result = createSeniorSchema.safeParse({
      name: 'Test',
      phone: '12345',
    });
    expect(result.success).toBe(false);
  });

  it('rejects phone with letters', () => {
    const result = createSeniorSchema.safeParse({
      name: 'Test',
      phone: '555-ABC-1234',
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Create Senior Schema
// =============================================================================

describe('createSeniorSchema', () => {
  it('accepts minimal valid senior', () => {
    const result = createSeniorSchema.safeParse({
      name: 'Dorothy',
      phone: '5551234567',
    });
    expect(result.success).toBe(true);
    expect(result.data.isActive).toBe(true); // default
    expect(result.data.timezone).toBe('America/New_York'); // default
  });

  it('accepts full senior data', () => {
    const result = createSeniorSchema.safeParse({
      name: 'Dorothy Smith',
      phone: '5551234567',
      timezone: 'America/Chicago',
      city: 'Austin',
      state: 'TX',
      zipCode: '78701',
      interests: ['gardening', 'baking'],
      medicalNotes: 'Takes blood pressure medication',
      isActive: true,
    });
    expect(result.success).toBe(true);
  });

  it('trims name whitespace', () => {
    const result = createSeniorSchema.safeParse({
      name: '  Dorothy  ',
      phone: '5551234567',
    });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe('Dorothy');
  });

  it('rejects empty name', () => {
    const result = createSeniorSchema.safeParse({
      name: '',
      phone: '5551234567',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid timezone', () => {
    const result = createSeniorSchema.safeParse({
      name: 'Test',
      phone: '5551234567',
      timezone: 'Mars/Olympus',
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Update Senior Schema
// =============================================================================

describe('updateSeniorSchema', () => {
  it('accepts partial update', () => {
    const result = updateSeniorSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('rejects empty update', () => {
    const result = updateSeniorSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts location fields', () => {
    const result = updateSeniorSchema.safeParse({
      city: 'Austin',
      state: 'TX',
      zipCode: '78701',
    });
    expect(result.success).toBe(true);
  });

  it('accepts additionalInfo', () => {
    const result = updateSeniorSchema.safeParse({
      additionalInfo: 'Loves to talk about her garden',
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Create Memory Schema
// =============================================================================

describe('createMemorySchema', () => {
  it('accepts valid memory', () => {
    const result = createMemorySchema.safeParse({
      content: 'Dorothy loves gardening',
    });
    expect(result.success).toBe(true);
    expect(result.data.type).toBe('fact'); // default
    expect(result.data.importance).toBe(50); // default
  });

  it('accepts all valid memory types', () => {
    const types = ['fact', 'preference', 'event', 'concern', 'relationship',
                   'health', 'medication', 'family', 'interest', 'routine'];
    for (const type of types) {
      const result = createMemorySchema.safeParse({ content: 'Test', type });
      expect(result.success, `Type '${type}' should be valid`).toBe(true);
    }
  });

  it('rejects empty content', () => {
    const result = createMemorySchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });

  it('rejects importance outside 0-100', () => {
    expect(createMemorySchema.safeParse({ content: 'Test', importance: -1 }).success).toBe(false);
    expect(createMemorySchema.safeParse({ content: 'Test', importance: 101 }).success).toBe(false);
  });
});

// =============================================================================
// Initiate Call Schema
// =============================================================================

describe('initiateCallSchema', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts valid senior ID', () => {
    const result = initiateCallSchema.safeParse({ seniorId: validUuid });
    expect(result.success).toBe(true);
    expect(result.data.seniorId).toBe(validUuid);
  });

  it('rejects raw phone number calls', () => {
    const result = initiateCallSchema.safeParse({ phoneNumber: '5551234567' });
    expect(result.success).toBe(false);
  });

  it('rejects missing senior ID', () => {
    const result = initiateCallSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Caregiver Schemas
// =============================================================================

describe('createCaregiverSchema', () => {
  it('accepts valid caregiver', () => {
    const result = createCaregiverSchema.safeParse({
      name: 'Susan Smith',
      email: 'SUSAN@Example.com',
    });
    expect(result.success).toBe(true);
    expect(result.data.email).toBe('susan@example.com'); // lowercased
  });

  it('rejects invalid email', () => {
    const result = createCaregiverSchema.safeParse({
      name: 'Susan',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });
});

describe('updateCaregiverSchema', () => {
  it('accepts partial update', () => {
    const result = updateCaregiverSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('rejects empty update', () => {
    const result = updateCaregiverSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Update Reminder Schema
// =============================================================================

describe('updateReminderSchema', () => {
  it('accepts partial update', () => {
    const result = updateReminderSchema.safeParse({ title: 'Updated title' });
    expect(result.success).toBe(true);
  });

  it('accepts isActive toggle', () => {
    const result = updateReminderSchema.safeParse({ isActive: false });
    expect(result.success).toBe(true);
  });

  it('rejects empty update', () => {
    const result = updateReminderSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Twilio Webhook Schemas
// =============================================================================

describe('voiceAnswerSchema', () => {
  it('accepts valid Twilio voice webhook', () => {
    const result = voiceAnswerSchema.safeParse({
      CallSid: 'CA1234567890abcdef',
      From: '+15551234567',
      To: '+15559876543',
      Direction: 'inbound',
    });
    expect(result.success).toBe(true);
  });

  it('passes through extra Twilio fields', () => {
    const result = voiceAnswerSchema.safeParse({
      CallSid: 'CA1234567890abcdef',
      From: '+15551234567',
      To: '+15559876543',
      Direction: 'inbound',
      ExtraField: 'value',
    });
    expect(result.success).toBe(true);
    expect(result.data.ExtraField).toBe('value');
  });

  it('rejects invalid Direction', () => {
    const result = voiceAnswerSchema.safeParse({
      CallSid: 'CA123',
      From: '+15551234567',
      To: '+15559876543',
      Direction: 'unknown',
    });
    expect(result.success).toBe(false);
  });
});

describe('voiceStatusSchema', () => {
  it('accepts valid status callback', () => {
    const result = voiceStatusSchema.safeParse({
      CallSid: 'CA1234567890abcdef',
      CallStatus: 'completed',
      CallDuration: '120',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid call statuses', () => {
    const statuses = ['queued', 'ringing', 'in-progress', 'completed', 'busy', 'failed', 'no-answer', 'canceled'];
    for (const status of statuses) {
      const result = voiceStatusSchema.safeParse({
        CallSid: 'CA123',
        CallStatus: status,
      });
      expect(result.success, `Status '${status}' should be valid`).toBe(true);
    }
  });
});

// =============================================================================
// Notification Trigger Schema
// =============================================================================

describe('notificationTriggerSchema', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts valid trigger', () => {
    const result = notificationTriggerSchema.safeParse({
      event_type: 'call_completed',
      senior_id: validUuid,
      data: { summary: 'Dorothy had a great call' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid event types', () => {
    for (const type of ['call_completed', 'concern_detected', 'reminder_missed']) {
      const result = notificationTriggerSchema.safeParse({
        event_type: type,
        senior_id: validUuid,
        data: {},
      });
      expect(result.success, `Event '${type}' should be valid`).toBe(true);
    }
  });

  it('rejects invalid event type', () => {
    const result = notificationTriggerSchema.safeParse({
      event_type: 'unknown_event',
      senior_id: validUuid,
      data: {},
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// URL Param Schemas
// =============================================================================

describe('seniorIdParamSchema', () => {
  it('accepts valid UUID', () => {
    const result = seniorIdParamSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID', () => {
    const result = seniorIdParamSchema.safeParse({ id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects missing id', () => {
    const result = seniorIdParamSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});


// =============================================================================
// Push Token Schema (Expo push registration from mobile app)
// =============================================================================

describe('pushTokenSchema', () => {
  it('accepts ExponentPushToken format', () => {
    const result = pushTokenSchema.safeParse({
      token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    });
    expect(result.success).toBe(true);
  });

  it('accepts ExpoPushToken format (newer SDKs)', () => {
    const result = pushTokenSchema.safeParse({
      token: 'ExpoPushToken[abc123]',
    });
    expect(result.success).toBe(true);
  });

  it('rejects raw FCM/APNs tokens (not Expo wrappers)', () => {
    const result = pushTokenSchema.safeParse({
      token: 'cMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing token', () => {
    const result = pushTokenSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects oversized payload', () => {
    const result = pushTokenSchema.safeParse({
      token: 'ExpoPushToken[' + 'a'.repeat(300) + ']',
    });
    expect(result.success).toBe(false);
  });
});
