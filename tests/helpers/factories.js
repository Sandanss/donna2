/**
 * Test data factories
 *
 * Functions to create test data with sensible defaults and easy overrides
 */

import { v4 as uuidv4 } from 'crypto';

// Generate a unique ID
const generateId = (prefix = '') => {
  const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  return prefix ? `${prefix}-${uuid}` : uuid;
};

/**
 * Create a test senior with default values
 */
export const createSenior = (overrides = {}) => ({
  id: generateId('senior'),
  name: 'Test Senior',
  phone: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
  timezone: 'America/New_York',
  interests: ['gardening', 'reading'],
  family: {
    daughter: 'Test Daughter',
  },
  profileNotes: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/**
 * Create a test conversation
 */
export const createConversation = (overrides = {}) => ({
  id: generateId('conv'),
  seniorId: overrides.seniorId || generateId('senior'),
  callSid: `CA${generateId()}`.substring(0, 34),
  status: 'completed',
  duration: 180,
  transcript: [],
  summary: null,
  createdAt: new Date(),
  completedAt: new Date(),
  ...overrides,
});

/**
 * Create a test memory
 */
export const createMemory = (overrides = {}) => ({
  id: generateId('mem'),
  seniorId: overrides.seniorId || generateId('senior'),
  type: 'fact',
  content: 'Test memory content',
  embedding: new Array(1536).fill(0.1),
  importance: 5,
  source: 'conversation',
  metadata: {},
  createdAt: new Date(),
  lastAccessedAt: new Date(),
  accessCount: 1,
  ...overrides,
});

/**
 * Create a test reminder
 */
export const createReminder = (overrides = {}) => ({
  id: generateId('rem'),
  seniorId: overrides.seniorId || generateId('senior'),
  type: 'medication',
  title: 'Test Reminder',
  description: 'Test reminder description',
  scheduledTime: new Date(Date.now() + 3600000), // 1 hour from now
  isRecurring: false,
  cronExpression: null,
  isActive: true,
  createdAt: new Date(),
  ...overrides,
});

/**
 * Create a recurring reminder
 */
export const createRecurringReminder = (overrides = {}) =>
  createReminder({
    isRecurring: true,
    cronExpression: '0 9 * * *', // Daily at 9 AM
    scheduledTime: null,
    ...overrides,
  });

/**
 * Create a test reminder delivery
 */
export const createReminderDelivery = (overrides = {}) => ({
  id: generateId('del'),
  reminderId: overrides.reminderId || generateId('rem'),
  conversationId: overrides.conversationId || null,
  callSid: overrides.callSid || null,
  status: 'pending',
  attemptCount: 0,
  userResponse: null,
  createdAt: new Date(),
  deliveredAt: null,
  acknowledgedAt: null,
  ...overrides,
});

/**
 * Create a test call analysis
 */
export const createCallAnalysis = (overrides = {}) => ({
  id: generateId('analysis'),
  conversationId: overrides.conversationId || generateId('conv'),
  summary: 'Test call summary',
  topics: ['general'],
  engagementScore: 7,
  sentiment: 'positive',
  concerns: [],
  followUps: [],
  createdAt: new Date(),
  ...overrides,
});

/**
 * Create a conversation transcript turn
 */
export const createTranscriptTurn = (role, content) => ({
  role,
  content,
  timestamp: new Date().toISOString(),
});

/**
 * Create a full conversation transcript
 */
export const createTranscript = (turns = []) => {
  if (turns.length === 0) {
    return [
      createTranscriptTurn('assistant', 'Hello! How are you today?'),
      createTranscriptTurn('user', "I'm doing well, thank you!"),
    ];
  }
  return turns;
};

/**
 * Create Quick Observer analysis result
 */
export const createQuickAnalysis = (overrides = {}) => ({
  healthSignals: [],
  familySignals: [],
  emotionSignals: [],
  safetySignals: [],
  socialSignals: [],
  activitySignals: [],
  timeSignals: [],
  environmentSignals: [],
  adlSignals: [],
  cognitiveSignals: [],
  helpRequestSignals: [],
  endOfLifeSignals: [],
  hydrationSignals: [],
  transportSignals: [],
  newsSignals: [],
  isQuestion: false,
  questionType: null,
  engagementLevel: 'normal',
  guidance: null,
  modelRecommendation: null,
  reminderResponse: null,
  needsWebSearch: false,
  ...overrides,
});

/**
 * Create Director analysis result
 */
export const createDirectorAnalysis = (overrides = {}) => ({
  analysis: {
    call_phase: 'main',
    engagement_level: 'high',
    emotional_state: 'content',
    topic_momentum: 'good',
    topics_discussed: [],
    ...overrides.analysis,
  },
  direction: {
    approach: 'maintain_warmth',
    suggested_topics: [],
    avoid_topics: [],
    tone: 'warm',
    priority: 'connection',
    ...overrides.direction,
  },
  reminder_timing: {
    ready_to_deliver: false,
    suggested_moment: null,
    reason: null,
    ...overrides.reminder_timing,
  },
  token_recommendation: overrides.token_recommendation || 100,
  reasoning: overrides.reasoning || 'Normal conversation flow',
});

export default {
  createSenior,
  createConversation,
  createMemory,
  createReminder,
  createRecurringReminder,
  createReminderDelivery,
  createCallAnalysis,
  createTranscriptTurn,
  createTranscript,
  createQuickAnalysis,
  createDirectorAnalysis,
};
