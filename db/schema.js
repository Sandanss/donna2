import { pgTable, uuid, varchar, text, timestamp, boolean, json, jsonb, integer, vector, time, date } from 'drizzle-orm/pg-core';

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
  deactivatedAt: timestamp('deactivated_at'),
  recurringDays: jsonb('recurring_days'),
  lastDeliveredAt: timestamp('last_delivered_at'),
  createdAt: timestamp('created_at').defaultNow(),
  createdVia: varchar('created_via', { length: 20 }).notNull().default('manual'),
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
  deliveryKey: text('delivery_key'),
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
  phone: varchar('phone', { length: 50 }),
  timezone: varchar('timezone', { length: 100 }).default('America/New_York'),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 50 }),
  zipCode: varchar('zip_code', { length: 20 }),
  expoPushToken: varchar('expo_push_token', { length: 255 }),
  expoPushTokenUpdatedAt: timestamp('expo_push_token_updated_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
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

// Legal holds suspend automated retention and destructive deletion.
export const legalHolds = pgTable('legal_holds', {
  id: uuid('id').defaultRandom().primaryKey(),
  resourceType: varchar('resource_type', { length: 100 }).notNull(),
  resourceId: text('resource_id').notNull(),
  holdReason: text('hold_reason').notNull(),
  placedBy: varchar('placed_by', { length: 255 }).notNull(),
  placedAt: timestamp('placed_at').defaultNow(),
  releasedAt: timestamp('released_at'),
  releaseReason: text('release_reason'),
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

// Normalized runtime schedules for the queue-based call architecture.
// PHI-bearing context notes must be stored encrypted only.
export const seniorCallSchedules = pgTable('senior_call_schedules', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').references(() => seniors.id).notNull(),
  sourceProfileHash: text('source_profile_hash'),
  callType: varchar('call_type', { length: 50 }).default('schedule').notNull(),
  timezone: varchar('timezone', { length: 100 }).notNull(),
  targetLocalTime: time('target_local_time').notNull(),
  windowMinutes: integer('window_minutes').default(15).notNull(),
  frequency: varchar('frequency', { length: 50 }).notNull(),
  daysOfWeek: integer('days_of_week').array(),
  oneTimeDate: date('one_time_date'),
  priorityLane: varchar('priority_lane', { length: 50 }).default('scheduled_checkin').notNull(),
  reminderIds: uuid('reminder_ids').array(),
  contextNotesEncrypted: text('context_notes_encrypted'),
  nextRunAt: timestamp('next_run_at').notNull(),
  lastMaterializedFor: timestamp('last_materialized_for'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Durable outbound work queue. Store IDs, lane, status, and timestamps only.
export const callQueue = pgTable('call_queue', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').references(() => seniors.id).notNull(),
  scheduleId: uuid('schedule_id').references(() => seniorCallSchedules.id),
  reminderId: uuid('reminder_id').references(() => reminders.id),
  callType: varchar('call_type', { length: 50 }).notNull(),
  priorityLane: varchar('priority_lane', { length: 50 }).notNull(),
  priorityScore: integer('priority_score').default(0).notNull(),
  targetAt: timestamp('target_at').notNull(),
  earliestAt: timestamp('earliest_at').notNull(),
  latestAt: timestamp('latest_at').notNull(),
  status: varchar('status', { length: 50 }).notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at'),
  attemptCount: integer('attempt_count').default(0).notNull(),
  lastAttemptId: uuid('last_attempt_id'),
  lastErrorCode: text('last_error_code'),
  lastErrorAt: timestamp('last_error_at'),
  cancelReason: text('cancel_reason'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// One row per provider dial attempt. No senior names, phones, transcripts, or reminder text.
export const callAttempts = pgTable('call_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  queueId: uuid('queue_id').references(() => callQueue.id).notNull(),
  seniorId: uuid('senior_id').references(() => seniors.id).notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  provider: varchar('provider', { length: 50 }).default('telnyx').notNull(),
  callControlId: text('call_control_id'),
  status: varchar('status', { length: 50 }).notNull(),
  reservationId: text('reservation_id'),
  reservedCapacity: integer('reserved_capacity').default(1).notNull(),
  architecture: varchar('architecture', { length: 50 }).notNull(),
  cohort: varchar('cohort', { length: 50 }),
  testRunId: text('test_run_id'),
  dispatchDecisionId: uuid('dispatch_decision_id'),
  dialStartedAt: timestamp('dial_started_at'),
  answeredAt: timestamp('answered_at'),
  mediaStartedAt: timestamp('media_started_at'),
  endedAt: timestamp('ended_at'),
  providerErrorCode: text('provider_error_code'),
  providerErrorClass: text('provider_error_class'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Heavy post-call work queue. Payloads can contain PHI only when encrypted.
export const postCallJobs = pgTable('post_call_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  callSid: text('call_sid').notNull(),
  seniorId: uuid('senior_id').references(() => seniors.id),
  jobType: varchar('job_type', { length: 100 }).notNull(),
  status: varchar('status', { length: 50 }).notNull(),
  priority: integer('priority').default(0).notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  payloadEncrypted: text('payload_encrypted'),
  dependsOn: uuid('depends_on').array().default([]).notNull(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  maxAttempts: integer('max_attempts').default(5).notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  deadLetteredAt: timestamp('dead_lettered_at'),
  deadLetterReason: text('dead_letter_reason'),
  lastErrorCode: text('last_error_code'),
  lastErrorAt: timestamp('last_error_at'),
  runAfter: timestamp('run_after').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Durable double-call guard shared by legacy and queue dialers.
export const outboundCallGuards = pgTable('outbound_call_guards', {
  id: uuid('id').defaultRandom().primaryKey(),
  seniorId: uuid('senior_id').references(() => seniors.id).notNull(),
  guardKey: text('guard_key').notNull(),
  callType: varchar('call_type', { length: 50 }).notNull(),
  architecture: varchar('architecture', { length: 50 }).notNull(),
  queueId: uuid('queue_id').references(() => callQueue.id),
  legacyDedupKey: text('legacy_dedup_key'),
  targetAt: timestamp('target_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  callControlId: text('call_control_id'),
  status: varchar('status', { length: 50 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Shadow comparison rows for proving queue decisions before queue dialing.
export const schedulerShadowComparisons = pgTable('scheduler_shadow_comparisons', {
  id: uuid('id').defaultRandom().primaryKey(),
  testRunId: text('test_run_id'),
  seniorId: uuid('senior_id').references(() => seniors.id),
  queueId: uuid('queue_id').references(() => callQueue.id),
  callType: varchar('call_type', { length: 50 }).notNull(),
  priorityLane: varchar('priority_lane', { length: 50 }),
  legacyDedupKey: text('legacy_dedup_key'),
  queueDedupeKey: text('queue_dedupe_key'),
  targetAt: timestamp('target_at'),
  legacyDecision: varchar('legacy_decision', { length: 100 }),
  queueDecision: varchar('queue_decision', { length: 100 }),
  skipReason: text('skip_reason'),
  capacityDecision: varchar('capacity_decision', { length: 100 }),
  estimatedQueueLagSeconds: integer('estimated_queue_lag_seconds'),
  createdAt: timestamp('created_at').defaultNow(),
});
