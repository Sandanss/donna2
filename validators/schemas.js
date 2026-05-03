/**
 * Zod Validation Schemas
 *
 * Centralized input validation for all API endpoints.
 * Based on database schema in db/schema.js
 */

import { z } from 'zod';

// =============================================================================
// Common Validators
// =============================================================================

// Phone number: E.164 format or 10-digit US number
const phoneSchema = z.string()
  .min(10, 'Phone number must be at least 10 digits')
  .max(20, 'Phone number too long')
  .regex(/^[\d+\-\s()]+$/, 'Phone number contains invalid characters')
  .transform(phone => {
    // Normalize to digits only, keep last 10 for US numbers
    const digits = phone.replace(/\D/g, '');
    return digits.length === 10 ? `+1${digits}` : `+${digits}`;
  });

// UUID validation
const uuidSchema = z.string().uuid('Invalid UUID format');

// Timezone validation (IANA format)
const timezoneSchema = z.string()
  .min(1)
  .max(100)
  .refine(tz => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid timezone');

// Cron expression validation (basic)
const cronSchema = z.string()
  .max(100)
  .regex(
    /^(\*|(\d+|\d+-\d+)(,(\d+|\d+-\d+))*|\*\/\d+)\s+(\*|(\d+|\d+-\d+)(,(\d+|\d+-\d+))*|\*\/\d+)\s+(\*|(\d+|\d+-\d+)(,(\d+|\d+-\d+))*|\*\/\d+)\s+(\*|(\d+|\d+-\d+)(,(\d+|\d+-\d+))*|\*\/\d+)\s+(\*|(\d+|\d+-\d+)(,(\d+|\d+-\d+))*|\*\/\d+)$/,
    'Invalid cron expression format'
  )
  .optional();

// ISO date string — validates format only, no transform.
// Drizzle and PostgreSQL accept ISO strings for timestamp columns natively.
// A previous .transform(date => new Date(date)) silently converted strings
// to Date objects, causing type mismatches in route handlers.
const isoDateSchema = z.string()
  .refine(date => !isNaN(Date.parse(date)), 'Invalid date format');

// =============================================================================
// Senior Schemas
// =============================================================================

export const createSeniorSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(255, 'Name too long')
    .trim(),
  phone: phoneSchema,
  timezone: timezoneSchema.default('America/New_York'),
  interests: z.array(z.string().max(100)).max(20).optional(),
  familyInfo: z.record(z.unknown()).optional(),
  medicalNotes: z.string().max(10000).optional(),
  preferredCallTimes: z.record(z.unknown()).optional(),
  isActive: z.boolean().default(true),
  city: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  zipCode: z.string().max(20).optional(),
  additionalInfo: z.string().max(5000).optional(),
});

export const updateSeniorSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  phone: phoneSchema.optional(),
  timezone: timezoneSchema.optional(),
  interests: z.array(z.string().max(100)).max(20).optional(),
  familyInfo: z.record(z.unknown()).optional(),
  medicalNotes: z.string().max(10000).optional(),
  preferredCallTimes: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  zipCode: z.string().max(20).optional(),
  additionalInfo: z.string().max(5000).optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for update',
});

// =============================================================================
// Memory Schemas
// =============================================================================

const memoryTypeEnum = z.enum([
  'fact',
  'preference',
  'event',
  'concern',
  'relationship',
  'health',
  'medication',
  'family',
  'interest',
  'routine',
]);

export const createMemorySchema = z.object({
  type: memoryTypeEnum.default('fact'),
  content: z.string()
    .min(1, 'Content is required')
    .max(5000, 'Content too long'),
  importance: z.number()
    .int()
    .min(0, 'Importance must be 0-100')
    .max(100, 'Importance must be 0-100')
    .default(50),
});

// =============================================================================
// Reminder Schemas
// =============================================================================

const reminderTypeEnum = z.enum([
  'medication',
  'appointment',
  'custom',
  'wellness',
  'social',
]);

export const createReminderSchema = z.object({
  seniorId: uuidSchema,
  type: reminderTypeEnum.default('custom'),
  title: z.string()
    .min(1, 'Title is required')
    .max(255, 'Title too long')
    .trim(),
  description: z.string().max(2000).optional(),
  scheduledTime: isoDateSchema.optional(),
  isRecurring: z.boolean().default(false),
  isActive: z.boolean().default(true),
  cronExpression: cronSchema.optional(),
});

export const updateReminderSchema = z.object({
  title: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(2000).optional(),
  scheduledTime: isoDateSchema.optional(),
  isRecurring: z.boolean().optional(),
  cronExpression: cronSchema,
  isActive: z.boolean().optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for update',
});

// =============================================================================
// Call Schemas
// =============================================================================

export const initiateCallSchema = z.object({
  seniorId: uuidSchema,
  contextNotes: z.string().max(1000).optional(),
});

// =============================================================================
// Twilio Webhook Schemas (for trusted Twilio requests)
// =============================================================================

const twilioCallStatusEnum = z.enum([
  'queued',
  'ringing',
  'in-progress',
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
]);

const twilioDirectionEnum = z.enum([
  'inbound',
  'outbound-api',
  'outbound-dial',
]);

export const voiceAnswerSchema = z.object({
  CallSid: z.string().min(1),
  From: z.string().min(1),
  To: z.string().min(1),
  Direction: twilioDirectionEnum,
  AccountSid: z.string().optional(),
  ApiVersion: z.string().optional(),
  CallerName: z.string().optional(),
}).passthrough(); // Allow additional Twilio fields

export const voiceStatusSchema = z.object({
  CallSid: z.string().min(1),
  CallStatus: twilioCallStatusEnum,
  CallDuration: z.string().optional(),
  AccountSid: z.string().optional(),
}).passthrough();

// =============================================================================
// Caregiver Schemas
// =============================================================================

export const createCaregiverSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(255, 'Name too long')
    .trim(),
  email: z.string()
    .email('Invalid email format')
    .max(255)
    .transform(email => email.toLowerCase()),
  clerkUserId: z.string().max(255).optional(),
});

export const updateCaregiverSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  email: z.string().email().max(255).transform(email => email.toLowerCase()).optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for update',
});

// =============================================================================
// Onboarding Schema (Combined caregiver + senior creation)
// =============================================================================

const relationEnum = z.enum([
  'Mother', 'Father', 'Daughter', 'Son', 'Spouse', 'Sibling',
  'Grandchild', 'Uncle', 'Aunt', 'Cousin',
  'Friend', 'Professional Caregiver', 'Client', 'Other Loved One', 'Other',
]);

const structuredInterestSchema = z.object({
  topic: z.string().min(1).max(100),
  details: z.string().max(1000).optional(),
});

const callScheduleDaySchema = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

const callScheduleSchema = z.object({
  frequency: z.enum(['daily', 'recurring', 'one-time']).default('daily'),
  days: z.array(callScheduleDaySchema).max(7).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
  date: z.string().max(50).optional(),
}).superRefine((data, ctx) => {
  if (data.frequency === 'recurring' && (!data.days || data.days.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['days'],
      message: 'Recurring schedules require at least one day',
    });
  }
});

export const onboardingSchema = z.object({
  // Caregiver info is optional - we get it from Clerk auth
  caregiver: z.object({
    name: z.string().min(1).max(255).trim(),
    email: z.string().email().max(255),
    clerkUserId: z.string().max(255).optional(),
  }).optional(),
  senior: z.object({
    name: z.string().min(1).max(255).trim(),
    phone: phoneSchema,
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    zipCode: z.string().max(20).optional(),
    timezone: timezoneSchema.optional(),
  }),
  relation: relationEnum,
  // Accept interests as strings (topic names)
  interests: z.array(z.string().max(100)).max(20).optional(),
  additionalInfo: z.string().max(5000).optional(),
  reminders: z.array(z.string().max(255)).max(20).optional(),
  topicsToAvoid: z.array(z.string().max(100)).max(10).optional(),
  callSchedule: callScheduleSchema.optional(),
  // Family info from frontend
  familyInfo: z.object({
    relation: z.string().optional(),
    donnaLanguage: z.enum(['en', 'es']).optional(),
    interestDetails: z.record(z.string()).optional(),
  }).optional(),
});

// =============================================================================
// Schedule Schemas
// =============================================================================

const scheduleFrequencyEnum = z.enum(['daily', 'recurring', 'one-time']);

const scheduleItemSchema = z.object({
  title: z.string().min(1).max(255).trim(),
  frequency: scheduleFrequencyEnum,
  recurringDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  date: z.string().max(50).optional(),
  time: z.string()
    .min(1)
    .max(20)
    .regex(/^(\d{1,2}:\d{2}(\s*(AM|PM))?|\d{2}:\d{2})$/i, 'Invalid time format'),
  contextNotes: z.string().max(2000).optional(),
  reminderIds: z.array(uuidSchema).max(20).optional(),
}).refine(data => {
  if (data.frequency === 'recurring' && (!data.recurringDays || data.recurringDays.length === 0)) {
    return false;
  }
  return true;
}, {
  message: 'Recurring schedules require at least one day',
});

export const updateScheduleSchema = z.object({
  schedule: z.array(scheduleItemSchema).max(20).optional(),
  topicsToAvoid: z.array(z.string().max(100)).max(10).optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided',
});

// =============================================================================
// Notification Schemas
// =============================================================================

export const notificationPreferencesSchema = z.object({
  callCompleted: z.boolean().optional(),
  concernDetected: z.boolean().optional(),
  reminderMissed: z.boolean().optional(),
  weeklySummary: z.boolean().optional(),
  callSummaries: z.boolean().optional(),
  pauseCalls: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional().nullable(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional().nullable(),
  timezone: timezoneSchema.optional(),
  weeklyReportDay: z.number().int().min(0).max(6).optional(),
  weeklyReportTime: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
});

export const notificationTriggerSchema = z.object({
  event_type: z.enum(['call_completed', 'concern_detected', 'reminder_missed']),
  senior_id: uuidSchema,
  data: z.object({}).passthrough(), // flexible payload
});

// =============================================================================
// URL Parameter Schemas
// =============================================================================

export const seniorIdParamSchema = z.object({
  id: uuidSchema,
});

export const reminderIdParamSchema = z.object({
  id: uuidSchema,
});

export const callSidParamSchema = z.object({
  callSid: z.string().min(1),
});

export const caregiverIdParamSchema = z.object({
  id: uuidSchema,
});

// =============================================================================
// Export all schemas
// =============================================================================

export const schemas = {
  // Seniors
  createSenior: createSeniorSchema,
  updateSenior: updateSeniorSchema,

  // Caregivers
  createCaregiver: createCaregiverSchema,
  updateCaregiver: updateCaregiverSchema,

  // Onboarding
  onboarding: onboardingSchema,

  // Memories
  createMemory: createMemorySchema,

  // Reminders
  createReminder: createReminderSchema,
  updateReminder: updateReminderSchema,

  // Calls
  initiateCall: initiateCallSchema,

  // Twilio webhooks
  voiceAnswer: voiceAnswerSchema,
  voiceStatus: voiceStatusSchema,

  // Schedule
  updateSchedule: updateScheduleSchema,

  // Notifications
  notificationPreferences: notificationPreferencesSchema,
  notificationTrigger: notificationTriggerSchema,

  // URL params
  seniorIdParam: seniorIdParamSchema,
  reminderIdParam: reminderIdParamSchema,
  callSidParam: callSidParamSchema,
  caregiverIdParam: caregiverIdParamSchema,
};

export default schemas;
