import { useState } from 'react';
import {
  useDatabaseHealth,
  useMetricsSummary,
  useLatencyTrends,
  useInfraMetrics,
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

function formatNumber(value: number | string | null | undefined) {
  if (value == null) return '--';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : '--';
}

function formatMs(value: number | string | null | undefined) {
  if (value == null) return '--';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toLocaleString()}ms` : '--';
}

export function InfraDashboard() {
  const [hours, setHours] = useState(24);
  const { summary, endReasons, loading: summaryLoading } = useMetricsSummary(hours);
  const { data: latencyData, loading: latencyLoading } = useLatencyTrends(hours);
  const { metrics, loading: metricsLoading } = useInfraMetrics(hours);
  const { data: dbHealth, loading: dbLoading } = useDatabaseHealth();

  const successRate = summary?.total_calls
    ? Math.round((Number(summary.successful_calls) / Number(summary.total_calls)) * 100)
    : null;

  return (
    <div className="infra-dashboard">
      {/* Time range selector */}
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

      {/* Summary stats */}
      <div className="stats-grid">
        <StatCard label="Total Calls" value={summary ? Number(summary.total_calls) : null} />
        <StatCard label="Success Rate" value={successRate} unit="%" />
        <StatCard label="Avg Duration" value={summary?.avg_duration_seconds ? Number(summary.avg_duration_seconds) : null} unit="s" />
        <StatCard label="Avg Turns" value={summary?.avg_turn_count ? Number(summary.avg_turn_count) : null} />
      </div>

      <div className="infra-section">
        <h3>Database Pressure</h3>
        <div className="stats-grid">
          <StatCard label="Pool Total" value={formatNumber(dbHealth?.pool.total)} />
          <StatCard label="Pool Idle" value={formatNumber(dbHealth?.pool.idle)} />
          <StatCard label="Pool Waiting" value={formatNumber(dbHealth?.pool.waiting)} />
          <StatCard label="Blocked Backends" value={formatNumber(dbHealth?.locks.blocked_backends)} />
        </div>
        <div className="trend-table-wrapper">
          <table className="trend-table">
            <thead>
              <tr>
                <th>Active DB Backends</th>
                <th>Waiting Locks</th>
                <th>Waiting Backends</th>
                <th>Max Query Age</th>
                <th>Max Tx Age</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{formatNumber(dbHealth?.activity.active_backends)}</td>
                <td>{formatNumber(dbHealth?.locks.waiting_locks)}</td>
                <td>{formatNumber(dbHealth?.locks.waiting_backends)}</td>
                <td>{formatNumber(dbHealth?.activity.max_query_age_seconds)}s</td>
                <td>{formatNumber(dbHealth?.activity.max_transaction_age_seconds)}s</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Latency overview */}
      <div className="infra-section">
        <h3>Average Latency</h3>
        <div className="latency-bars">
          <LatencyBar label="LLM TTFB" value={summary?.avg_llm_ttfb_ms ? Number(summary.avg_llm_ttfb_ms) : null} max={1000} />
          <LatencyBar label="TTS TTFB" value={summary?.avg_tts_ttfb_ms ? Number(summary.avg_tts_ttfb_ms) : null} max={500} />
          <LatencyBar label="Turn (E2E)" value={summary?.avg_turn_latency_ms ? Number(summary.avg_turn_latency_ms) : null} max={3000} />
        </div>
      </div>

      {/* End reason breakdown */}
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

      <div className="infra-section">
        <h3>Hot Tables</h3>
        {!dbHealth?.hotTables.available && dbHealth?.hotTables.unavailableReason ? (
          <p className="no-data">{dbHealth.hotTables.unavailableReason}</p>
        ) : (dbHealth?.hotTables.tables.length || 0) === 0 && !dbLoading ? (
          <p className="no-data">No table statistics available</p>
        ) : (
          <div className="trend-table-wrapper">
            <table className="trend-table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Live Rows</th>
                  <th>Dead %</th>
                  <th>Seq Scan</th>
                  <th>Idx Scan</th>
                  <th>Writes</th>
                </tr>
              </thead>
              <tbody>
                {(dbHealth?.hotTables.tables || []).map(table => (
                  <tr key={table.table_name}>
                    <td>{table.table_name}</td>
                    <td>{formatNumber(table.estimated_live_rows)}</td>
                    <td>{formatNumber(table.dead_tuple_pct)}%</td>
                    <td>{formatNumber(table.seq_scan)}</td>
                    <td>{formatNumber(table.idx_scan)}</td>
                    <td>{formatNumber(Number(table.rows_inserted) + Number(table.rows_updated) + Number(table.rows_deleted))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="infra-section">
        <h3>Slow Query Aggregates</h3>
        {!dbHealth?.slowQueries.available && dbHealth?.slowQueries.unavailableReason ? (
          <p className="no-data">{dbHealth.slowQueries.unavailableReason}</p>
        ) : (dbHealth?.slowQueries.queries.length || 0) === 0 && !dbLoading ? (
          <p className="no-data">No slow-query aggregate data available</p>
        ) : (
          <div className="trend-table-wrapper">
            <table className="trend-table">
              <thead>
                <tr>
                  <th>Query ID</th>
                  <th>Calls</th>
                  <th>Mean</th>
                  <th>Max</th>
                  <th>Total</th>
                  <th>Rows</th>
                </tr>
              </thead>
              <tbody>
                {(dbHealth?.slowQueries.queries || []).map(query => (
                  <tr key={query.query_id}>
                    <td>{query.query_id}</td>
                    <td>{formatNumber(query.calls)}</td>
                    <td>{formatMs(query.mean_exec_time_ms)}</td>
                    <td>{formatMs(query.max_exec_time_ms)}</td>
                    <td>{formatMs(query.total_exec_time_ms)}</td>
                    <td>{formatNumber(query.rows_returned)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Latency trend (simple text table — charts would need a charting library) */}
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

      {/* Recent calls table */}
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

      {(summaryLoading || latencyLoading || metricsLoading || dbLoading) && (
        <div className="loading-indicator">Loading...</div>
      )}
    </div>
  );
}
