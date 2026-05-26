import { useState, useEffect, useCallback } from 'react';
import type {
  Call,
  Timeline,
  Turn,
  ObserverSummary,
  Continuity,
  MetricsData,
  ContextTraceData,
  ContextLatency,
} from '../types';

export type ApiEnvironment = 'dev' | 'prod';

const ENVIRONMENT_KEY = 'donna_obs_environment';
const TOKEN_KEY_PREFIX = 'donna_obs_token';

const ENVIRONMENT_CONFIG: Record<ApiEnvironment, { label: string; apiRoot: string }> = {
  dev: {
    label: 'Dev',
    apiRoot:
      import.meta.env.VITE_API_URL_DEV ||
      (import.meta.env.DEV ? '/dev-api' : 'https://donna-api-dev.up.railway.app'),
  },
  prod: {
    label: 'Prod',
    apiRoot:
      import.meta.env.VITE_API_URL_PROD ||
      import.meta.env.VITE_API_URL ||
      (import.meta.env.DEV ? '/prod-api' : 'https://donna-api-production-2450.up.railway.app'),
  },
};

export function getEnvironmentOptions() {
  return Object.entries(ENVIRONMENT_CONFIG).map(([key, config]) => ({
    key: key as ApiEnvironment,
    label: config.label,
    apiRoot: config.apiRoot,
  }));
}

export function getEnvironment(): ApiEnvironment {
  const stored = localStorage.getItem(ENVIRONMENT_KEY);
  return stored === 'prod' || stored === 'dev' ? stored : 'dev';
}

export function setEnvironment(environment: ApiEnvironment): void {
  localStorage.setItem(ENVIRONMENT_KEY, environment);
}

export function getEnvironmentConfig(environment = getEnvironment()) {
  return ENVIRONMENT_CONFIG[environment];
}

function getApiRoot(environment = getEnvironment()): string {
  return ENVIRONMENT_CONFIG[environment].apiRoot.replace(/\/$/, '');
}

function getObservabilityUrl(path: string): string {
  return `${getApiRoot()}/api/observability${path}`;
}

function getTokenKey(environment = getEnvironment()): string {
  return `${TOKEN_KEY_PREFIX}_${environment}`;
}

export function getToken(environment = getEnvironment()): string | null {
  return localStorage.getItem(getTokenKey(environment));
}

export function setToken(token: string, environment = getEnvironment()): void {
  localStorage.setItem(getTokenKey(environment), token);
}

export function clearToken(environment = getEnvironment()): void {
  localStorage.removeItem(getTokenKey(environment));
}

export async function login(email: string, password: string, environment = getEnvironment()): Promise<string> {
  const response = await fetch(`${getApiRoot(environment)}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Login failed');
  }
  const data = await response.json();
  setToken(data.token, environment);
  return data.token;
}

async function fetchJson<T>(url: string): Promise<T> {
  const environment = getEnvironment();
  const token = getToken(environment);
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  if (response.status === 401 || response.status === 403) {
    clearToken(environment);
    window.location.reload();
    throw new Error('AUTH_EXPIRED');
  }
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}

export function useActiveCalls() {
  const [activeCalls, setActiveCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJson<{ activeCalls: Call[] }>(getObservabilityUrl('/active'));
      setActiveCalls(data.activeCalls);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Poll every 5 seconds for active calls
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { activeCalls, loading, error, refresh };
}

export function useCalls(limit = 50) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<{ calls: Call[] }>(getObservabilityUrl(`/calls?limit=${limit}`));
      setCalls(data.calls);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { calls, loading, error, refresh };
}

export function useCallTimeline(callId: string | undefined) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setTimeline(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchJson<Timeline>(getObservabilityUrl(`/calls/${callId}/timeline`))
      .then((data) => {
        setTimeline(data);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [callId]);

  return { timeline, loading, error };
}

export function useCallTurns(callId: string | undefined) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setTurns([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchJson<{ turns: Turn[] }>(getObservabilityUrl(`/calls/${callId}/turns`))
      .then((data) => {
        setTurns(data.turns);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [callId]);

  return { turns, loading, error };
}

export function useObserverSignals(callId: string | undefined) {
  const [data, setData] = useState<ObserverSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchJson<ObserverSummary>(getObservabilityUrl(`/calls/${callId}/observer`))
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [callId]);

  return { data, loading, error };
}

export function useContinuity(seniorId: string | undefined) {
  const [continuity, setContinuity] = useState<Continuity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seniorId) {
      setContinuity(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchJson<Continuity>(getObservabilityUrl(`/continuity/${seniorId}`))
      .then((data) => {
        setContinuity(data);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [seniorId]);

  return { continuity, loading, error };
}

// -------------------------------------------------------------------------
// Infrastructure Metrics (from call_metrics table)
// -------------------------------------------------------------------------

export interface InfraMetric {
  call_sid: string;
  senior_id: string | null;
  call_type: string;
  duration_seconds: number | null;
  end_reason: string | null;
  turn_count: number;
  phase_durations: Record<string, number> | null;
  latency: ContextLatency | null;
  breaker_states: Record<string, string> | null;
  tools_used: string[] | null;
  token_usage: Record<string, number> | null;
  error_count: number;
  created_at: string;
}

export interface MetricsSummary {
  total_calls: number;
  successful_calls: number;
  avg_duration_seconds: number | null;
  avg_turn_count: number | null;
  avg_llm_ttfb_ms: number | null;
  avg_tts_ttfb_ms: number | null;
  avg_turn_latency_ms: number | null;
}

export interface LatencyPoint {
  hour: string;
  call_count: number;
  llm_ttfb_ms: number | null;
  tts_ttfb_ms: number | null;
  turn_latency_ms: number | null;
  avg_duration: number | null;
}

export interface DatabaseHealth {
  capturedAt: string;
  pool: {
    max: number | null;
    total: number | null;
    idle: number | null;
    waiting: number | null;
  };
  activity: {
    available?: boolean;
    active_backends?: number;
    blocked_backends?: number;
    max_query_age_seconds?: number;
    max_transaction_age_seconds?: number;
    byState?: Array<{ state: string; wait_event_type: string; count: number }>;
    unavailableReason?: string;
  };
  locks: {
    available?: boolean;
    waiting_locks?: number;
    waiting_backends?: number;
    blocked_backends?: number;
    unavailableReason?: string;
  };
  hotTables: {
    available?: boolean;
    tables: Array<{
      table_name: string;
      estimated_live_rows: number;
      estimated_dead_rows: number;
      dead_tuple_pct: number;
      seq_scan: number;
      idx_scan: number;
      rows_inserted: number;
      rows_updated: number;
      rows_deleted: number;
    }>;
    unavailableReason?: string;
  };
  slowQueries: {
    available?: boolean;
    queries: Array<{
      query_id: string;
      calls: number;
      rows_returned: number;
      total_exec_time_ms: number;
      mean_exec_time_ms: number;
      max_exec_time_ms: number;
    }>;
    unavailableReason?: string;
  };
}

export function useInfraMetrics(hours = 24) {
  const [metrics, setMetrics] = useState<InfraMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<{ metrics: InfraMetric[] }>(
        getObservabilityUrl(`/metrics/calls?hours=${hours}&limit=100`)
      );
      setMetrics(data.metrics);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { refresh(); }, [refresh]);
  return { metrics, loading, error, refresh };
}

export function useMetricsSummary(hours = 24) {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [endReasons, setEndReasons] = useState<Array<{ end_reason: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<{
        summary: MetricsSummary;
        end_reasons: Array<{ end_reason: string; count: number }>;
      }>(getObservabilityUrl(`/metrics/summary?hours=${hours}`));
      setSummary(data.summary);
      setEndReasons(data.end_reasons);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { refresh(); }, [refresh]);
  return { summary, endReasons, loading, error, refresh };
}

export function useLatencyTrends(hours = 24) {
  const [data, setData] = useState<LatencyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchJson<{ latency: LatencyPoint[] }>(
        getObservabilityUrl(`/metrics/latency?hours=${hours}`)
      );
      setData(result.latency);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { refresh(); }, [refresh]);
  return { data, loading, error, refresh };
}

export function useDatabaseHealth() {
  const [data, setData] = useState<DatabaseHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchJson<DatabaseHealth>(getObservabilityUrl('/db'));
      setData(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { data, loading, error, refresh };
}

// -------------------------------------------------------------------------
// Per-call metrics (existing, from conversations table)
// -------------------------------------------------------------------------

export function useCallMetrics(callId: string | undefined) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchJson<MetricsData>(getObservabilityUrl(`/calls/${callId}/metrics`))
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [callId]);

  return { data, loading, error };
}

export function useCallContextTrace(callId: string | undefined) {
  const [data, setData] = useState<ContextTraceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchJson<ContextTraceData>(getObservabilityUrl(`/calls/${callId}/context`))
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [callId]);

  return { data, loading, error };
}
