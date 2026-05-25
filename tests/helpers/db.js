/**
 * Database test helpers
 *
 * Utilities for setting up test database state
 */

import { vi } from 'vitest';

// Mock database client for unit tests
export const createMockDbClient = () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue([]),

    // For raw SQL queries
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };

  return mockDb;
};

// Mock Drizzle schema
export const mockSchema = {
  seniors: {
    id: 'id',
    name: 'name',
    phone: 'phone',
    timezone: 'timezone',
    interests: 'interests',
    family: 'family',
    profileNotes: 'profile_notes',
    isActive: 'is_active',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  conversations: {
    id: 'id',
    seniorId: 'senior_id',
    callSid: 'call_sid',
    status: 'status',
    duration: 'duration',
    transcript: 'transcript',
    summary: 'summary',
    createdAt: 'created_at',
    completedAt: 'completed_at',
  },
  memories: {
    id: 'id',
    seniorId: 'senior_id',
    type: 'type',
    content: 'content',
    embedding: 'embedding',
    importance: 'importance',
    source: 'source',
    metadata: 'metadata',
    createdAt: 'created_at',
    lastAccessedAt: 'last_accessed_at',
    accessCount: 'access_count',
  },
  reminders: {
    id: 'id',
    seniorId: 'senior_id',
    type: 'type',
    title: 'title',
    description: 'description',
    scheduledTime: 'scheduled_time',
    isRecurring: 'is_recurring',
    cronExpression: 'cron_expression',
    isActive: 'is_active',
    createdAt: 'created_at',
  },
  reminderDeliveries: {
    id: 'id',
    reminderId: 'reminder_id',
    conversationId: 'conversation_id',
    callSid: 'call_sid',
    status: 'status',
    attemptCount: 'attempt_count',
    userResponse: 'user_response',
    createdAt: 'created_at',
    deliveredAt: 'delivered_at',
    acknowledgedAt: 'acknowledged_at',
  },
  callAnalyses: {
    id: 'id',
    conversationId: 'conversation_id',
    summary: 'summary',
    topics: 'topics',
    engagementScore: 'engagement_score',
    sentiment: 'sentiment',
    concerns: 'concerns',
    followUps: 'follow_ups',
    createdAt: 'created_at',
  },
};

// Seed test data into mock database
export const seedTestData = (mockDb, { seniors = [], memories = [], reminders = [], conversations = [] }) => {
  // Configure select queries to return seeded data
  mockDb.select.mockImplementation(() => ({
    from: vi.fn().mockImplementation((table) => {
      let data = [];
      if (table === mockSchema.seniors) data = seniors;
      if (table === mockSchema.memories) data = memories;
      if (table === mockSchema.reminders) data = reminders;
      if (table === mockSchema.conversations) data = conversations;

      return {
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(data),
          }),
          limit: vi.fn().mockResolvedValue(data),
          execute: vi.fn().mockResolvedValue(data),
        }),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(data),
          execute: vi.fn().mockResolvedValue(data),
        }),
        limit: vi.fn().mockResolvedValue(data),
        execute: vi.fn().mockResolvedValue(data),
      };
    }),
  }));

  return mockDb;
};

// Calculate cosine similarity between two vectors
export const cosineSimilarity = (a, b) => {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

export default {
  createMockDbClient,
  mockSchema,
  seedTestData,
  cosineSimilarity,
};
