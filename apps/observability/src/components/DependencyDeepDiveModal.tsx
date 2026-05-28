import { InfraMetric } from "../hooks/useApi";

export function calculateDependencyStats(
  metrics: InfraMetric[],
  dependencyName: string,
): {
  name: string;
  status: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  successRate: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  p95Latency: number;
  errorBreakdown: Array<{ type: string; count: number }>;
} | null {
  const callsUsingDependency = metrics.filter(call => {
    if (!call.breaker_states) return false;
    return dependencyName in call.breaker_states;
  });

  if (callsUsingDependency.length === 0) return null;

  const totalCalls = callsUsingDependency.length;
  const failedCalls = callsUsingDependency.filter(c => c.end_reason !== "completed");
  const successfulCalls = totalCalls - failedCalls.length;
  const successRate = (successfulCalls / totalCalls) * 100;

  const latencies = callsUsingDependency
    .map(c => c.latency?.llm_ttfb_avg_ms || 0)
    .filter(l => l > 0)
    .sort((a, b) => a - b);

  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const minLatency = latencies[0] || 0;
  const maxLatency = latencies[latencies.length - 1] || 0;
  const p95Index = Math.floor(latencies.length * 0.95);
  const p95Latency = latencies[p95Index] || 0;

  const errorCounts = new Map<string, number>();
  failedCalls.forEach(call => {
    const errType = call.end_reason || "unknown";
    errorCounts.set(errType, (errorCounts.get(errType) || 0) + 1);
  });

  const errorBreakdown: Array<{ type: string; count: number }> = [];
  errorCounts.forEach((count, type) => {
    errorBreakdown.push({ type, count });
  });

  const status = callsUsingDependency[0]?.breaker_states?.[dependencyName] || "unknown";

  return {
    name: dependencyName,
    status: (status || "unknown").toLowerCase(),
    totalCalls,
    successfulCalls,
    failedCalls: failedCalls.length,
    successRate,
    avgLatency,
    minLatency,
    maxLatency,
    p95Latency: Math.round(p95Latency),
    errorBreakdown: errorBreakdown.sort((a, b) => b.count - a.count),
  };
}

export function DependencyDeepDiveModal({
  dependency,
  stats,
  onClose,
}: {
  dependency: string | null;
  stats: ReturnType<typeof calculateDependencyStats>;
  onClose: () => void;
}) {
  if (!dependency) return null;

  if (!stats) {
    return (
      <>
        <div className="modal-overlay" onClick={onClose} />
        <div className="dependency-modal">
          <div className="modal-header">
            <h2>{dependency} — Deep Dive</h2>
            <button className="modal-close" onClick={onClose}>X</button>
          </div>
          <div className="modal-content">
            <p style={{ textAlign: "center", color: "#999", padding: "40px 20px" }}>
              No data available for {dependency}
            </p>
          </div>
        </div>
      </>
    );
  }

  const statusDisplay = 
    stats.status === "closed" ? "HEALTHY" :
    stats.status === "open" ? "BREAKER OPEN" :
    "HALF OPEN";

  return (
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="dependency-modal">
        <div className="modal-header">
          <h2>{dependency} — Deep Dive</h2>
          <button className="modal-close" onClick={onClose}>X</button>
        </div>
        <div className="modal-content">
          <section className="modal-section">
            <h3>Status</h3>
            <div className="status-badge">
              <span className={`status-dot ${stats.status}`} />
              {statusDisplay}
            </div>
          </section>

          <section className="modal-section">
            <h3>Last 24 Hours</h3>
            <div className="stat-row"><span>Total Calls:</span><span className="stat-value">{stats.totalCalls}</span></div>
            <div className="stat-row"><span>Success Rate:</span><span className="stat-value">{stats.successRate.toFixed(1)}%</span></div>
            <div className="stat-row"><span>Successful:</span><span className="stat-value">{stats.successfulCalls}</span></div>
            <div className="stat-row"><span>Failed:</span><span className="stat-value error">{stats.failedCalls}</span></div>
          </section>

          <section className="modal-section">
            <h3>Performance</h3>
            <div className="stat-row"><span>Avg Latency:</span><span className="stat-value">{stats.avgLatency}ms</span></div>
            <div className="stat-row"><span>Min Latency:</span><span className="stat-value">{stats.minLatency}ms</span></div>
            <div className="stat-row"><span>Max Latency:</span><span className="stat-value">{stats.maxLatency}ms</span></div>
            <div className="stat-row"><span>P95 Latency:</span><span className="stat-value">{stats.p95Latency}ms</span></div>
          </section>

          {stats.errorBreakdown.length > 0 && (
            <section className="modal-section">
              <h3>Error Breakdown</h3>
              {stats.errorBreakdown.map((err) => (
                <div key={err.type} className="stat-row">
                  <span>{err.type}:</span>
                  <span className="stat-value">{err.count} calls</span>
                </div>
              ))}
            </section>
          )}

          <button
            onClick={() => console.log(`View ${stats.name} Calls`)}
            style={{
              width: "100%",
              padding: "10px",
              marginTop: "15px",
              backgroundColor: "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: "500"
            }}
          >
            View {stats.name} Calls
          </button>
        </div>
      </div>
    </>
  );
}
