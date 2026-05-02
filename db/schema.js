import { pgTable, uuid, varchar, text, timestamp, boolean, json, integer, vector } from 'drizzle-orm/pg-core';

// Senior profiles
export const seniors = pgTable('seniors', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }).notNull().unique(),
  timezone: varchar('timezone', { length: 100 }).default('America/New_York'),
  interests: text('interests').array(),
  familyInfo: json('family_info'),
  familyInfoEncrypted: text('family_info_encrypted'),
  medicalNotes: text('medical_notes'),
  medicalNotesEncrypted: text('medical_notes_encrypted'),
  preferredCallTimes: json('preferred_call_times'),
  preferredCallTimesEncrypted: text('preferred_call_times_encrypted'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  // Consumer app fields
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 50 }),
  zipCode: varchar('zip_code', { length: 20 }),
  additionalInfo: text('additional_info'),
  additionalInfoEncrypted: text('additional_info_encrypted'),
  callContextSnapshot: json('call_context_snapshot'),
  callContextSnapshotEncrypted: text('call_context_snapshot_encrypted'),
  cachedNews: text('cached_news'),
  cachedNewsUpdatedAt: timestamp('cached_news_updated_at'),
});

// Conversations (call history)
export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').references(() => seniors.id),
  callSid: varchar('call_sid', { length: 100 }),
  startedAt: timestamp('started_at').notNull(),
  endedAt: timestamp('ended_at'),
  durationSeconds: integer('duration_seconds'),
  status: varchar('status', { length: 50 }),
  direction: varchar('direction', { length: 20 }),
  summary: text('summary'),
  summaryEncrypted: text('summary_encrypted'),
  sentiment: varchar('sentiment', { length: 50 }),
  concerns: text('concerns').array(),
  transcript: json('transcript'),
  transcriptEncrypted: text('transcript_encrypted'),
  transcriptTextEncrypted: text('transcript_text_encrypted'),
  callMetrics: json('call_metrics'),
  voicemailDetected: boolean('voicemail_detected').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

// Memories with vector embeddings for semantic search
export const memories = pgTable('memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').references(() => seniors.id),
  type: varchar('type', { length: 50 }).notNull(), // fact, preference, event, concern, relationship
  content: text('content').notNull(),
  contentEncrypted: text('content_encrypted'),
  source: varchar('source', { length: 255 }), // conversation_id or 'manual'
  importance: integer('importance').default(50), // 0-100
  embedding: vector('embedding', { dimensions: 1536 }), // OpenAI text-embedding-3-small
  metadata: json('metadata'), // additional context
  createdAt: timestamp('created_at').defaultNow(),
  lastAccessedAt: timestamp('last_accessed_at'),
});

// Reminders
export const reminders = pgTable('reminders', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').references(() => seniors.id),
  type: varchar('type', { length: 50 }), // medication, appointment, custom
  title: varchar('title', { length: 255 }).notNull(),
  titleEncrypted: text('title_encrypted'),
  description: text('description'),
  descriptionEncrypted: text('description_encrypted'),
  scheduledTime: timestamp('scheduled_time'),
  isRecurring: boolean('is_recurring').default(false),
  cronExpression: varchar('cron_expression', { length: 100 }),
  isActive: boolean('is_active').default(true),
  lastDeliveredAt: timestamp('last_delivered_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Reminder Deliveries - tracks each delivery attempt for acknowledgment
export const reminderDeliveries = pgTable('reminder_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),
  reminderId: uuid('reminder_id').references(() => reminders.id),
  scheduledFor: timestamp('scheduled_for').notNull(), // The target time this delivery is for
  deliveredAt: timestamp('delivered_at'),             // When call was made
  acknowledgedAt: timestamp('acknowledged_at'),       // When user acknowledged
  userResponse: text('user_response'),                // What user said
  userResponseEncrypted: text('user_response_encrypted'),
  // Status: pending, delivered, acknowledged, confirmed, retry_pending, max_attempts
  status: varchar('status', { length: 50 }).default('pending'),
  attemptCount: integer('attempt_count').default(0),  // Number of delivery attempts
  callSid: varchar('call_sid', { length: 100 }),      // Provider call ID
  createdAt: timestamp('created_at').defaultNow(),
});

// Caregivers - maps Clerk user IDs to seniors they can access
export const caregivers = pgTable('caregivers', {
  id: uuid('id').defaultRandom().primaryKey(),
  clerkUserId: varchar('clerk_user_id', { length: 255 }).notNull(), // Clerk user ID
  seniorId: uuid('senior_id').references(() => seniors.id).notNull(),
  role: varchar('role', { length: 50 }).default('caregiver'), // caregiver, family, admin
  createdAt: timestamp('created_at').defaultNow(),
});

// Call Analyses - post-call analysis results
export const callAnalyses = pgTable('call_analyses', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: varchar('conversation_id', { length: 100 }),   // streamSid or call identifier
  seniorId: uuid('senior_id').references(() => seniors.id),
  summary: text('summary'),                                       // 2-3 sentence summary
  topics: text('topics').array(),                                 // Topics discussed
  engagementScore: integer('engagement_score'),                   // 1-10 scale
  concerns: json('concerns'),                                     // Array of concern objects
  positiveObservations: text('positive_observations').array(),    // Good things noticed
  followUpSuggestions: text('follow_up_suggestions').array(),     // For next call
  callQuality: json('call_quality'),                              // {rapport, goals_achieved, duration_appropriate}
  analysisEncrypted: text('analysis_encrypted'),                   // AES-256-GCM encrypted full analysis
  createdAt: timestamp('created_at').defaultNow(),
});

// Daily call context - tracks what happened in each call for same-day cross-call memory
export const dailyCallContext = pgTable('daily_call_context', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').references(() => seniors.id).notNull(),
  callDate: timestamp('call_date').notNull(),
  callSid: varchar('call_sid', { length: 100 }),
  topicsDiscussed: text('topics_discussed').array(),
  remindersDelivered: text('reminders_delivered').array(),
  adviceGiven: text('advice_given').array(),
  keyMoments: json('key_moments'),
  summary: text('summary'),
  contextEncrypted: text('context_encrypted'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Notification preferences — per-caregiver notification settings
export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').defaultRandom().primaryKey(),
  caregiverId: uuid('caregiver_id').references(() => caregivers.id).notNull().unique(),
  // Event toggles (default all on)
  callCompleted: boolean('call_completed').default(true),
  concernDetected: boolean('concern_detected').default(true),
  reminderMissed: boolean('reminder_missed').default(true),
  weeklySummary: boolean('weekly_summary').default(true),
  // Call summaries & pause
  callSummaries: boolean('call_summaries').default(true),
  pauseCalls: boolean('pause_calls').default(false),
  // Channel preferences
  smsEnabled: boolean('sms_enabled').default(false),
  emailEnabled: boolean('email_enabled').default(true),
  // Quiet hours (in caregiver's local time)
  quietHoursStart: varchar('quiet_hours_start', { length: 5 }), // "22:00"
  quietHoursEnd: varchar('quiet_hours_end', { length: 5 }),     // "07:00"
  timezone: varchar('timezone', { length: 100 }).default('America/New_York'),
  // Weekly report day (0=Sun, 1=Mon, ..., 6=Sat)
  weeklyReportDay: integer('weekly_report_day').default(1), // Monday
  weeklyReportTime: varchar('weekly_report_time', { length: 5 }).default('09:00'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Notifications — log of all sent notifications
export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  caregiverId: uuid('caregiver_id').references(() => caregivers.id).notNull(),
  seniorId: uuid('senior_id').references(() => seniors.id),
  eventType: varchar('event_type', { length: 50 }).notNull(), // call_completed, concern_detected, reminder_missed, weekly_summary
  channel: varchar('channel', { length: 20 }).notNull(),      // email; legacy rows may be sms
  content: text('content').notNull(),
  contentEncrypted: text('content_encrypted'),
  metadata: json('metadata'),    // event-specific data (analysis id, concern details, etc.)
  metadataEncrypted: text('metadata_encrypted'),
  sentAt: timestamp('sent_at').defaultNow(),
  readAt: timestamp('read_at'),  // for future in-app notification center
});

// Admin users for dashboard authentication
export const adminUsers = pgTable('admin_users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
  lastLoginAt: timestamp('last_login_at'),
});

// Audit log for data deletions (hard deletes + retention purges)
export const dataDeletionLogs = pgTable('data_deletion_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  deletionType: varchar('deletion_type', { length: 20 }).notNull(),
  reason: varchar('reason', { length: 100 }),
  deletedBy: varchar('deleted_by', { length: 255 }),
  recordCounts: json('record_counts'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Waitlist signups from calldonna.co
export const waitlist = pgTable('waitlist', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }),
  whoFor: varchar('who_for', { length: 100 }),
  thoughts: text('thoughts'),
  payloadEncrypted: text('payload_encrypted'),
  createdAt: timestamp('created_at').defaultNow(),
});

// HIPAA audit logs — tracks who accessed what PHI and when
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  userRole: text('user_role').notNull(),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  metadata: json('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow(),
});

// Idempotency replay cache for mobile and frontend write requests.
// Response bodies can include PHI, so cache payloads are encrypted only.
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: varchar('key', { length: 255 }).primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  method: varchar('method', { length: 10 }).notNull(),
  pathHash: varchar('path_hash', { length: 64 }).notNull(),
  bodyHash: varchar('body_hash', { length: 64 }).notNull(),
  state: varchar('state', { length: 20 }).default('processing').notNull(),
  statusCode: integer('status_code'),
  responseEncrypted: text('response_encrypted'),
  requestId: text('request_id'),
  createdAt: timestamp('created_at').defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
});
