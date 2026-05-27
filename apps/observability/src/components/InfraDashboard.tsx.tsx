import { useState } from 'react';
import {
  useMetricsSummary,
  useLatencyTrends,
  useInfraMetrics,
  type InfraMetric,
} from '../hooks/useApi';

const TIME_RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

function StatCard({ label, value, unit }: { label: string; value: number | string | null; unit?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">
        {value != null ? value : '--'}
        {unit && value != null && <span className="stat-unit">{unit}</span>}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function LatencyBar({ label, value, max }: { label: string; value: number | null; max: number }) {
  const pct = value != null ? Math.min((value / max) * 100, 100) : 0;
  const color = value != null && value > max * 0.75 ? '#ef4444' : value != null && value > max * 0.5 ? '#f59e0b' : '#22c55e';
  return (
    <div className="latency-bar-row">
      <span className="latency-label">{label}</span>
      <div className="latency-bar-bg">
        <div className="latency-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="latency-value">{value != null ? `${value}ms` : '--'}</span>
    </div>
  );
}

function ServiceHealthRow({
  service,
  state,
  openCount,
  totalSeen,
}: {
  service: string;
  state: string;
  openCount: number;
  totalSeen: number;
}) {
  const normalized = (state || 'unknown').toLowerCase().replace('_', '-');
  const variant =
    normalized === 'open' ? 'open' :
    normalized === 'half-open' ? 'half-open' :
    normalized === 'closed' ? 'closed' :
    'unknown';

  const openRate = totalSeen > 0 ? Math.round((openCount / totalSeen) * 100) : 0;

  return (
    <div className="service-health-row">
      <span className="service-name">{service.replace(/_/g, ' ')}</span>
      <span className={`breaker-badge ${variant}`}>{normalized}</span>
      {openCount > 0 && (
        <span className="breaker-open-count">
          open in {openCount}/{totalSeen} calls ({openRate}%)
        </span>
      )}
    </div>
  );
}

function aggregateBreakerStates(
  metrics: InfraMetric[],
): Record<string, { currentState: string; openCount: number; totalSeen: number }> {
  const result: Record<string, { currentState: string; openCount: number; totalSeen: number }> = {};
  for (const m of metrics) {
    if (!m.breaker_states) continue;
    for (const [service, state] of Object.entries(m.breaker_states)) {
      if (!result[service]) {
        result[service] = { currentState: state, openCount: 0, totalSeen: 0 };
      }
      result[service].totalSeen++;
      if ((state || '').toLowerCase() === 'open') {
        result[service].openCount++;
      }
    }
  }
  return result;
}

export function InfraDashboard() {
  const [hours, setHours] = useState(24);
  const { summary, endReasons, loading: summaryLoading } = useMetricsSummary(hours);
  const { data: latencyData, loading: latencyLoading } = useLatencyTrends(hours);
  const { metrics, loading: metricsLoading } = useInfraMetrics(hours);

  const successRate = summary?.total_calls
    ? Math.round((Number(summary.successful_calls) / Number(summary.total_calls)) * 100)
    : null;

  const breakerSummary = aggregateBreakerStates(metrics);
  const hasOpenBreaker = Object.values(breakerSummary).some(
    info => (info.currentState || '').toLowerCase() === 'open',
  );

  return (
    <div className="infra-dashboard">
      <div className="infra-header">
        <h2>Infrastructure Metrics</h2>
        <div className="time-range-toggle">
          {TIME_RANGES.map(r => (
            <button
              key={r.hours}
              className={hours === r.hours ? 'active' : ''}
              onClick={() => setHours(r.hours)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`infra-section ${hasOpenBreaker ? 'has-alert' : ''}`}>
        <h3>
          Service Health
          {hasOpenBreaker && <span className="alert-pill">Breaker open</span>}
        </h3>
        {Object.keys(breakerSummary).length === 0 ? (
          <p className="no-data">
            {metricsLoading ? 'Loading...' : 'No breaker data in this period'}
          </p>
        ) : (
          <div className="service-health-list">
            {Object.entries(breakerSummary)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([service, info]) => (
                <ServiceHealthRow
                  key={service}
                  service={service}
                  state={info.currentState}
                  openCount={info.openCount}
                  totalSeen={info.totalSeen}
                />
              ))}
          </div>
        )}
      </div>

      <div className="stats-grid">
        <StatCard label="Total Calls" value={summary ? Number(summary.total_calls) : null} />
        <StatCard label="Success Rate" value={successRate} unit="%" />
        <StatCard label="Avg Duration" value={summary?.avg_duration_seconds ? Number(summary.avg_duration_seconds) : null} unit="s" />
        <StatCard label="Avg Turns" value={summary?.avg_turn_count ? Number(summary.avg_turn_count) : null} />
      </div>

      <div className="infra-section">
        <h3>Average Latency</h3>
        <div className="latency-bars">
          <LatencyBar label="LLM TTFB" value={summary?.avg_llm_ttfb_ms ? Number(summary.avg_llm_ttfb_ms) : null} max={1000} />
          <LatencyBar label="TTS TTFB" value={summary?.avg_tts_ttfb_ms ? Number(summary.avg_tts_ttfb_ms) : null} max={500} />
          <LatencyBar label="Turn (E2E)" value={summary?.avg_turn_latency_ms ? Number(summary.avg_turn_latency_ms) : null} max={3000} />
        </div>
      </div>

      <div className="infra-section">
        <h3>Call End Reasons</h3>
        {endReasons.length === 0 && !summaryLoading ? (
          <p className="no-data">No data for this period</p>
        ) : (
          <div className="end-reasons">
            {endReasons.map(r => (
              <div key={r.end_reason} className="end-reason-row">
                <span className={`end-reason-badge ${r.end_reason}`}>{r.end_reason || 'unknown'}</span>
                <span className="end-reason-count">{r.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {latencyData.length > 0 && (
        <div className="infra-section">
          <h3>Latency Trend (Hourly)</h3>
          <div className="trend-table-wrapper">
            <table className="trend-table">
              <thead>
                <tr>
                  <th>Hour</th>
                  <th>Calls</th>
                  <th>LLM TTFB</th>
                  <th>TTS TTFB</th>
                  <th>Turn E2E</th>
                </tr>
              </thead>
              <tbody>
                {latencyData.map((point, i) => (
                  <tr key={i}>
                    <td>{new Date(point.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{point.call_count}</td>
                    <td>{point.llm_ttfb_ms != null ? `${point.llm_ttfb_ms}ms` : '--'}</td>
                    <td>{point.tts_ttfb_ms != null ? `${point.tts_ttfb_ms}ms` : '--'}</td>
                    <td>{point.turn_latency_ms != null ? `${point.turn_latency_ms}ms` : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="infra-section">
        <h3>Recent Calls</h3>
        {metrics.length === 0 && !metricsLoading ? (
          <p className="no-data">No calls in this period</p>
        ) : (
          <div className="trend-table-wrapper">
            <table className="trend-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Duration</th>
                  <th>Turns</th>
                  <th>End Reason</th>
                  <th>LLM TTFB</th>
                  <th>Tools</th>
                </tr>
              </thead>
              <tbody>
                {metrics.slice(0, 20).map((m, i) => (
                  <tr key={i}>
                    <td>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{m.duration_seconds != null ? `${m.duration_seconds}s` : '--'}</td>
                    <td>{m.turn_count}</td>
                    <td><span className={`end-reason-badge ${m.end_reason}`}>{m.end_reason || '?'}</span></td>
                    <td>{m.latency?.llm_ttfb_avg_ms != null ? `${m.latency.llm_ttfb_avg_ms}ms` : '--'}</td>
                    <td>{m.tools_used?.join(', ') || 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(summaryLoading || latencyLoading || metricsLoading) && (
        <div className="loading-indicator">Loading...</div>
      )}
    </div>
  );
}
