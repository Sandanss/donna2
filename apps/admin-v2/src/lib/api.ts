const API_URL = import.meta.env.VITE_API_URL || '';
const TOKEN_KEY = 'donna_admin_token';

export async function authFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(options.headers || {})),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_URL}${endpoint}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  return res;
}

export async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(endpoint, options);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.error || 'Request failed');
  }
  return res.json();
}

// ===== API Methods =====

export const api = {
  // Auth
  auth: {
    login: (email: string, password: string) =>
      fetch(`${API_URL}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }).then((r) => r.json()),
    me: (token: string) =>
      fetch(`${API_URL}/api/admin/me`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
  },

  // Dashboard
  stats: {
    get: () => fetchJson<DashboardStats>('/api/stats'),
  },

  // Seniors
  seniors: {
    list: () => fetchJson<Senior[]>('/api/seniors'),
    get: (id: string) => fetchJson<Senior>(`/api/seniors/${id}`),
    create: (data: CreateSeniorInput) =>
      authFetch('/api/seniors', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Senior>) =>
      authFetch(`/api/seniors/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      authFetch(`/api/seniors/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) }),
    getMemories: (id: string) => fetchJson<Memory[]>(`/api/seniors/${id}/memories`),
    addMemory: (id: string, data: { type: string; content: string; importance: number }) =>
      authFetch(`/api/seniors/${id}/memories`, { method: 'POST', body: JSON.stringify(data) }),
  },

  // Calls
  calls: {
    list: () => fetchJson<Call[]>('/api/conversations'),
    initiate: (seniorId: string) =>
      authFetch('/api/call', { method: 'POST', body: JSON.stringify({ seniorId }) }),
  },

  // Reminders
  reminders: {
    list: () => fetchJson<Reminder[]>('/api/reminders'),
    create: (data: CreateReminderInput) =>
      authFetch('/api/reminders', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => authFetch(`/api/reminders/${id}`, { method: 'DELETE' }),
  },

  // Call Analyses
  callAnalyses: {
    list: () => fetchJson<CallAnalysis[]>('/api/call-analyses'),
  },

  // Caregivers
  caregivers: {
    list: () => fetchJson<CaregiverLink[]>('/api/caregivers'),
  },

  // Daily Context
  dailyContext: {
    list: (params?: { seniorId?: string; date?: string }) => {
      const search = new URLSearchParams();
      if (params?.seniorId) search.set('seniorId', params.seniorId);
      if (params?.date) search.set('date', params.date);
      const qs = search.toString();
      return fetchJson<DailyContextEntry[]>(`/api/daily-context${qs ? `?${qs}` : ''}`);
    },
  },

  // Post-call Jobs
  postCallJobs: {
    deadLetters: (limit = 100) =>
      fetchJson<{ jobs: PostCallJob[] }>(`/api/post-call-jobs/dead-letter?limit=${limit}`),
    replay: (id: string) =>
      fetchJson<{ job: PostCallJob }>(`/api/post-call-jobs/${id}/replay`, { method: 'POST' }),
  },

  // Scale Operations
  scaleOperations: {
    phase8Plan: () =>
      fetchJson<{ plan: Phase8CapacityPlan }>('/api/scale-operations/phase8/plan'),
    autoscaleOnce: (data: Phase8ScaleRequest) =>
      fetchJson<Phase8ScaleResult>('/api/scale-operations/phase8/autoscale-once', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    override: (data: Phase8ScaleRequest & { targetReplicas: number; reason?: string }) =>
      fetchJson<Phase8ScaleResult>('/api/scale-operations/phase8/override', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
};

// ===== TypeScript Types =====

export interface DashboardStats {
  totalSeniors: number;
  callsToday: number;
  upcomingRemindersCount: number;
  activeCalls: number;
  recentCalls: RecentCall[];
  upcomingReminders: UpcomingReminder[];
}

export interface RecentCall {
  seniorName: string;
  startedAt: string;
  durationSeconds: number;
  status: string;
}

export interface UpcomingReminder {
  title: string;
  seniorName: string;
  type: string;
  scheduledTime: string;
}

export interface Senior {
  id: string;
  name: string;
  phone: string;
  interests: string[];
  familyInfo: { location?: string };
  profileNotes: string;
  isActive: boolean;
  memories?: Memory[];
}

export interface CreateSeniorInput {
  name: string;
  phone: string;
  interests: string[];
  familyInfo: { location: string };
  profileNotes: string;
}

export interface Memory {
  id: string;
  type: string;
  content: string;
}

export interface Call {
  id: string;
  seniorName: string;
  startedAt: string;
  durationSeconds: number;
  status: string;
  transcript: TranscriptMessage[];
}

export interface TranscriptMessage {
  role: 'assistant' | 'user';
  content: string;
}

export interface Reminder {
  id: string;
  seniorId: string;
  seniorName: string;
  type: string;
  title: string;
  description: string;
  scheduledTime: string;
  isRecurring: boolean;
  cronExpression: string | null;
  lastDeliveredAt: string | null;
}

export interface CreateReminderInput {
  seniorId: string;
  type: string;
  title: string;
  description: string;
  scheduledTime: string | null;
  isRecurring: boolean;
  cronExpression: string | null;
}

export interface CallAnalysis {
  id: string;
  seniorName: string;
  createdAt: string;
  engagementScore: number;
  summary: string;
  topics: string[];
  concerns: (string | { description: string })[];
  positiveObservations: string[];
  followUpSuggestions: string[];
}

export interface CaregiverLink {
  clerkUserId: string;
  seniorId: string;
  seniorName: string;
  role: string;
  createdAt: string;
}

export interface DailyContextEntry {
  seniorName: string;
  callDate: string;
  summary: string;
  topicsDiscussed: string[];
  remindersDelivered: string[];
  adviceGiven: string[];
}

export interface PostCallJob {
  id: string;
  conversationId: string | null;
  callSid: string | null;
  seniorId: string | null;
  jobType: string;
  status: string;
  priority: number;
  dedupeKey: string;
  dependsOn: string[];
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  runAfter: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  deadLetteredAt: string | null;
  deadLetterReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Phase8CapacityPlan {
  ok: boolean;
  generatedAt: string;
  window: {
    start: string;
    end: string;
    minutes: number;
    warmupMinutes: number;
    readyMinutesBeforeWindow: number;
  };
  demand: {
    total: number;
    byLane: Record<string, number>;
    byStatus: Record<string, number>;
    unknownLane: number;
  };
  capacity: {
    currentReplicas: number;
    totalReplicas: number;
    readyReplicas: number;
    availableSlots: number;
    activeCalls: number;
    pendingReservations: number;
    warmupGateRedReplicas: number;
    maxCallsPerReplica: number;
    registryError: string | null;
  };
  postCall: {
    criticalBacklog: number;
    criticalBacklogThreshold: number;
  };
  recommendation: {
    action: string;
    reason: string;
    targetReplicas: number;
    currentReplicas: number;
    requiredReplicas: number;
    scaleUpBy: number;
    scaleDownBy: number;
    scaleDownSafe: boolean;
    scaleUpAt: string;
    targetReadyAt: string;
    cost: {
      projectedHourlyCost: number | null;
      hourlyBudget: number | null;
      withinHourlyBudget: boolean | null;
    };
  };
  checks: { name: string; status: string; detail?: string; reason?: string }[];
}

export interface Phase8ScaleRequest {
  confirmScale?: boolean;
  dryRun?: boolean;
  currentReplicas?: number;
  service?: string;
  environment?: string;
  region?: string;
}

export interface Phase8ScaleResult {
  ok: boolean;
  applied: boolean;
  dryRun: boolean;
  direction?: string;
  targetReplicas?: number;
  currentReplicas?: number;
  plan: Phase8CapacityPlan;
  scaleOperation: {
    ok: boolean;
    applied: boolean;
    dryRun: boolean;
    targetReplicas: number;
    reason: string;
    command?: {
      display: string;
    };
  } | null;
}
