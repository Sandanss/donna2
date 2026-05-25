// Mock data for all E2E tests

export const mockSeniors = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Martha Johnson',
    phone: '+15551234567',
    location: 'Austin, TX',
    interests: ['gardening', 'crosswords', 'jazz'],
    profileNotes: 'Prefers short morning check-ins',
    isActive: true,
    createdAt: '2026-01-15T10:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Robert Smith',
    phone: '+15559876543',
    location: 'Denver, CO',
    interests: ['history', 'fishing'],
    profileNotes: '',
    isActive: true,
    createdAt: '2026-02-01T10:00:00Z',
  },
];

export const mockConversations = [
  {
    id: 'call-1',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    startedAt: '2026-03-08T14:00:00Z',
    endedAt: '2026-03-08T14:10:00Z',
    durationSeconds: 600,
    status: 'completed',
    initiatedBy: 'scheduled',
    transcript: [
      { role: 'assistant', content: 'Good morning Martha! How are you today?' },
      { role: 'user', content: "Oh hi Donna! I'm doing well, just finished my crossword." },
      { role: 'assistant', content: "That's wonderful! Was it a tricky one today?" },
    ],
  },
  {
    id: 'call-2',
    seniorId: '22222222-2222-2222-2222-222222222222',
    seniorName: 'Robert Smith',
    startedAt: '2026-03-08T15:00:00Z',
    endedAt: '2026-03-08T15:08:00Z',
    durationSeconds: 480,
    status: 'completed',
    initiatedBy: 'manual',
    transcript: [],
  },
];

export const mockReminders = [
  {
    id: 'rem-1',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    title: 'Water porch plants',
    description: 'After breakfast',
    type: 'custom',
    isRecurring: true,
    cronExpression: '0 8 * * *',
    scheduledTime: null,
    isActive: true,
    lastDelivered: '2026-03-08T08:00:00Z',
    createdAt: '2026-01-20T10:00:00Z',
  },
  {
    id: 'rem-2',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    title: 'Bridge club',
    description: 'Tomorrow at 9 AM',
    type: 'social',
    isRecurring: false,
    cronExpression: null,
    scheduledTime: '2026-03-15T10:00:00Z',
    isActive: true,
    lastDelivered: null,
    createdAt: '2026-03-01T10:00:00Z',
  },
];

export const mockDashboardStats = {
  totalSeniors: 2,
  callsToday: 3,
  upcomingReminders: 2,
  activeCalls: 0,
  recentCalls: [
    {
      id: 'call-1',
      seniorName: 'Martha Johnson',
      startedAt: '2026-03-08T14:00:00Z',
      durationSeconds: 600,
      status: 'completed',
    },
  ],
  upcomingRemindersList: [
    {
      id: 'rem-2',
      seniorName: 'Martha Johnson',
      title: 'Bridge club',
      scheduledTime: '2026-03-15T10:00:00Z',
    },
  ],
};

export const mockCallAnalyses = [
  {
    id: 'analysis-1',
    conversationId: 'call-1',
    seniorName: 'Martha Johnson',
    createdAt: '2026-03-08T14:15:00Z',
    engagementScore: 8,
    summary: 'Martha was in great spirits, discussed her crossword puzzle and gardening plans.',
    topicsDiscussed: ['crosswords', 'gardening', 'weather'],
    concerns: [],
    positiveObservations: ['Good mood', 'Engaged in hobbies'],
    followUpSuggestions: ['Ask about garden progress next call'],
  },
];

export const mockCaregivers = [
  {
    id: 'cg-1',
    clerkUserId: 'user_abc123',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    role: 'daughter',
    createdAt: '2026-01-15T10:00:00Z',
  },
];

export const mockDailyContext = [
  {
    id: 'dc-1',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    callDate: '2026-03-08',
    summary: 'Martha discussed crosswords and gardening. Reminded about watering porch plants.',
    topicsDiscussed: ['crosswords', 'gardening'],
    remindersDelivered: ['Water porch plants'],
    adviceGiven: 'Suggested trying the Sunday NYT crossword',
  },
];

// Observability-specific mock data
export const mockObservabilityCalls = [
  {
    id: 'obs-call-1',
    senior_id: '11111111-1111-1111-1111-111111111111',
    call_sid: 'CA1234567890',
    started_at: '2026-03-08T14:00:00Z',
    ended_at: '2026-03-08T14:10:00Z',
    duration_seconds: 600,
    status: 'completed',
    initiated_by: 'scheduled',
    senior_name: 'Martha Johnson',
    senior_phone: '+15551234567',
    turn_count: 12,
    summary: 'Discussed crosswords and gardening',
    concerns: [],
    analysis: {
      id: 'analysis-1',
      conversationId: 'obs-call-1',
      seniorId: '11111111-1111-1111-1111-111111111111',
      summary: 'Discussed crosswords and gardening',
      topics: ['crosswords', 'gardening'],
      engagementScore: 8,
      concerns: [],
      positiveObservations: ['Engaged throughout the call'],
      followUpSuggestions: ['Ask about the garden next time'],
      callQuality: { rapport: 'strong', goals_achieved: true, duration_appropriate: true },
      createdAt: '2026-03-08T14:11:00Z',
    },
    call_metrics: {
      totalTokens: 2847,
      totalInputTokens: 1200,
      totalOutputTokens: 1647,
      avgResponseTime: 324,
      avgTtfa: 89,
      estimatedCost: 0.0234,
      modelsUsed: ['claude-sonnet-4-5-20250514'],
    },
  },
];

export const mockTimeline = {
  callId: 'obs-call-1',
  callSid: 'CA1234567890',
  seniorId: '11111111-1111-1111-1111-111111111111',
  startedAt: '2026-03-08T14:00:00Z',
  endedAt: '2026-03-08T14:10:00Z',
  status: 'completed',
  timeline: [
    { type: 'call.initiated', timestamp: '2026-03-08T14:00:00Z', data: { initiatedBy: 'scheduled' } },
    { type: 'call.connected', timestamp: '2026-03-08T14:00:02Z', data: { label: 'Voice answer to media stream', latencyMs: 1200, stage: 'call.answer_to_ws' } },
    { type: 'call.lifecycle', timestamp: '2026-03-08T14:00:03Z', data: { label: 'Flow initialized', latencyMs: 180, stage: 'call.flow_initialize' } },
    { type: 'turn.response', timestamp: '2026-03-08T14:00:05Z', data: { content: 'Good morning Martha!' } },
    { type: 'turn.transcribed', timestamp: '2026-03-08T14:00:15Z', data: { content: 'Hi Donna!' } },
    { type: 'latency.llm', timestamp: '2026-03-08T14:00:16Z', data: { label: 'LLM first token', latencyMs: 420, turnSequence: 1, stage: 'llm_ttfb' } },
    { type: 'observer.signal', timestamp: '2026-03-08T14:00:16Z', data: { signal: { engagementLevel: 'high', emotionalState: 'positive', confidenceScore: 92, concerns: [], shouldDeliverReminder: false, shouldEndCall: false } } },
    { type: 'latency.tool', timestamp: '2026-03-08T14:04:10Z', data: { label: 'web_search result', latencyMs: 640, turnSequence: 3, stage: 'tool.web_search' } },
    { type: 'call.ended', timestamp: '2026-03-08T14:10:00Z', data: { status: 'completed', duration: 600 } },
  ],
};

export const mockObserverData = {
  callId: 'obs-call-1',
  count: 5,
  signals: [
    {
      turnId: 'turn-1',
      speaker: 'senior',
      turnContent: 'Hi Donna, I just finished my crossword puzzle!',
      timestamp: '2026-03-08T14:00:15Z',
      signal: { engagementLevel: 'high', emotionalState: 'positive', confidenceScore: 92, concerns: [], shouldDeliverReminder: false, shouldEndCall: false },
    },
  ],
  summary: {
    averageConfidence: 87,
    engagementDistribution: { high: 8, medium: 3, low: 1 },
    emotionalStateDistribution: { positive: 7, neutral: 4, negative: 0, confused: 1, distressed: 0 },
    totalConcerns: 0,
    uniqueConcerns: [],
  },
};

export const mockMetricsData = {
  turnMetrics: [
    { turnIndex: 0, role: 'assistant', model: 'claude-sonnet-4-5-20250514', maxTokens: 1024, inputTokens: 450, outputTokens: 120, ttfa: 85, responseTime: 310, tokenReason: 'normal' },
    { turnIndex: 1, role: 'assistant', model: 'claude-sonnet-4-5-20250514', maxTokens: 1024, inputTokens: 580, outputTokens: 95, ttfa: 92, responseTime: 340, tokenReason: 'normal' },
  ],
  callMetrics: {
    totalInputTokens: 1200,
    totalOutputTokens: 1647,
    totalTokens: 2847,
    avgResponseTime: 324,
    avgTtfa: 89,
    turnCount: 12,
    estimatedCost: 0.0234,
    modelsUsed: ['claude-sonnet-4-5-20250514'],
  },
  durationSeconds: 600,
};

export const mockContextTraceData = {
  callId: 'obs-call-1',
  callSid: 'CA1234567890',
  status: 'completed',
  durationSeconds: 600,
  captured: true,
  schemaReady: true,
  latency: {
    llm_ttfb_avg_ms: 420,
    turn_avg_ms: 1180,
    stage_breakdown: {
      'call.answer_to_ws': { count: 1, avg_ms: 1200, p95_ms: 1200, max_ms: 1200, last_ms: 1200 },
      'tool.web_search': { count: 1, avg_ms: 640, p95_ms: 640, max_ms: 640, last_ms: 640 },
    },
  },
  toolsUsed: ['web_search'],
  contextTrace: {
    version: 1,
    captured_at: '2026-03-08T14:10:05Z',
    event_count: 4,
    latency_breakdown: {
      'call.answer_to_ws': { count: 1, avg_ms: 1200, p95_ms: 1200, max_ms: 1200, last_ms: 1200 },
      'call.flow_initialize': { count: 1, avg_ms: 180, p95_ms: 180, max_ms: 180, last_ms: 180 },
      'director.query': { count: 2, avg_ms: 165, p95_ms: 180, max_ms: 180, last_ms: 150 },
      'tool.web_search': { count: 1, avg_ms: 640, p95_ms: 640, max_ms: 640, last_ms: 640 },
      'llm_ttfb': { count: 3, avg_ms: 420, p95_ms: 480, max_ms: 480, last_ms: 410 },
      'turn.total': { count: 3, avg_ms: 1180, p95_ms: 1310, max_ms: 1310, last_ms: 1090 },
    },
    events: [
      {
        sequence: 0,
        timestamp: '2026-03-08T14:00:00Z',
        timestamp_offset_ms: 0,
        source: 'system_prompt',
        action: 'seeded',
        label: 'Subscriber system prompt',
        provider: 'pipecat_flows',
        content: 'Base Donna companion prompt.',
        content_chars: 28,
        metadata: { node: 'main', variant: 'subscriber' },
      },
      {
        sequence: 1,
        timestamp: '2026-03-08T14:00:01Z',
        timestamp_offset_ms: 1000,
        source: 'previous_calls_summary',
        action: 'seeded',
        label: 'Recent call summary context',
        provider: 'context_cache',
        content: 'Recent calls:\n- Discussed crosswords and gardening.',
        content_chars: 51,
        item_count: 1,
        metadata: {},
      },
      {
        sequence: 2,
        timestamp: '2026-03-08T14:03:20Z',
        timestamp_offset_ms: 200000,
        source: 'memory_context',
        action: 'injected',
        label: 'Prefetched memories injected',
        provider: 'prefetch_cache',
        content: '- Martha likes Sunday crossword puzzles.',
        content_chars: 38,
        item_count: 1,
        metadata: { cache_hit: true },
      },
      {
        sequence: 3,
        timestamp: '2026-03-08T14:04:10Z',
        timestamp_offset_ms: 250000,
        source: 'web_search',
        action: 'result',
        label: 'web_search result',
        provider: 'llm_tool',
        latency_ms: 640,
        content: '[NEWS] Local garden show starts this weekend.',
        content_chars: 45,
        metadata: { tool: 'web_search', status: 'success' },
      },
    ],
  },
};
