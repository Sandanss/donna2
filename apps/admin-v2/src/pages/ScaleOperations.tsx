import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type Phase8CapacityPlan } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { useToast } from '@/components/Toast';

function formatAction(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function StatusPill({ status }: { status: string }) {
  const passed = status === 'passed';
  const failed = status === 'failed';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold',
        passed && 'bg-green-100 text-green-800',
        failed && 'bg-red-100 text-red-800',
        !passed && !failed && 'bg-gray-100 text-admin-text-muted',
      )}
    >
      {status}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-admin-border bg-gray-50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase text-admin-text-muted">{label}</div>
      <div className="mt-1 text-lg font-bold text-admin-text-light">{value}</div>
    </div>
  );
}

export default function ScaleOperations() {
  const [plan, setPlan] = useState<Phase8CapacityPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [targetReplicas, setTargetReplicas] = useState(2);
  const [confirmScale, setConfirmScale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  async function loadPlan({ silent = false } = {}) {
    if (!silent) setLoading(true);
    try {
      const data = await api.scaleOperations.phase8Plan();
      setPlan(data.plan);
      setTargetReplicas(data.plan.recommendation.targetReplicas);
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load capacity plan';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function runAutoscalerOnce() {
    setRunning(true);
    try {
      const result = await api.scaleOperations.autoscaleOnce({
        confirmScale,
        dryRun: !confirmScale,
        currentReplicas: plan?.capacity.currentReplicas,
      });
      setPlan(result.plan);
      showToast(result.applied ? 'Scale change applied' : 'Autoscaler dry-run complete');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Autoscaler run failed';
      showToast(message, 'error');
    } finally {
      setRunning(false);
    }
  }

  async function override(target: number, reason: string) {
    setRunning(true);
    try {
      const result = await api.scaleOperations.override({
        targetReplicas: target,
        reason,
        confirmScale,
        dryRun: !confirmScale,
        currentReplicas: plan?.capacity.currentReplicas,
      });
      setPlan(result.plan);
      showToast(result.scaleOperation?.applied ? 'Override applied' : 'Override dry-run complete');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Override failed';
      showToast(message, 'error');
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    loadPlan();
  }, []);

  const failedChecks = useMemo(
    () => (plan?.checks || []).filter((check) => check.status === 'failed'),
    [plan],
  );

  return (
    <div className="bg-white rounded-xl p-5 mb-5 shadow-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between border-b-2 border-admin-primary pb-2 mb-4">
        <div>
          <h2 className="text-base font-bold text-admin-text-light">Scale Operations</h2>
          {error && (
            <p className="mt-1 text-xs font-semibold text-admin-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <button
          onClick={() => loadPlan({ silent: true })}
          disabled={loading || running}
          className="inline-flex items-center justify-center gap-1.5 bg-gray-100 text-admin-text px-3 py-2 rounded-lg text-xs font-semibold hover:bg-gray-200 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-center py-10 text-admin-text-muted">Loading capacity plan...</p>
      ) : !plan ? (
        <p className="text-center py-10 text-admin-text-muted">No capacity plan available</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Recommendation" value={formatAction(plan.recommendation.action)} />
            <Metric label="Target Replicas" value={plan.recommendation.targetReplicas} />
            <Metric label="Ready Replicas" value={`${plan.capacity.readyReplicas}/${plan.capacity.totalReplicas}`} />
            <Metric label="Demand" value={plan.demand.total} />
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
            <section className="border border-admin-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <Activity size={16} className="text-admin-primary" />
                <h3 className="text-sm font-bold text-admin-text-light">Current Window</h3>
              </div>
              <div className="grid gap-2 text-sm text-admin-text md:grid-cols-2">
                <div>Starts: <span className="font-semibold">{formatDate(plan.window.start)}</span></div>
                <div>Target Ready: <span className="font-semibold">{formatDate(plan.recommendation.targetReadyAt)}</span></div>
                <div>Available Slots: <span className="font-semibold">{plan.capacity.availableSlots}</span></div>
                <div>Active + Reserved: <span className="font-semibold">{plan.capacity.activeCalls + plan.capacity.pendingReservations}</span></div>
                <div>Critical Backlog: <span className="font-semibold">{plan.postCall.criticalBacklog}</span></div>
                <div>Scale-Down Safe: <span className="font-semibold">{plan.recommendation.scaleDownSafe ? 'Yes' : 'No'}</span></div>
              </div>
              {failedChecks.length > 0 && (
                <p className="mt-3 text-xs font-semibold text-admin-danger">
                  {failedChecks.length} check{failedChecks.length === 1 ? '' : 's'} failing.
                </p>
              )}
            </section>

            <section className="border border-admin-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <ShieldCheck size={16} className="text-admin-primary" />
                <h3 className="text-sm font-bold text-admin-text-light">Override</h3>
              </div>
              <label className="block text-xs font-semibold text-admin-text-light" htmlFor="target-replicas">
                Target Replicas
              </label>
              <input
                id="target-replicas"
                type="number"
                min={0}
                max={50}
                value={targetReplicas}
                onChange={(event) => setTargetReplicas(Number(event.target.value))}
                className="mt-1 w-full border border-admin-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary"
              />
              <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-admin-text-light">
                <input
                  type="checkbox"
                  checked={confirmScale}
                  onChange={(event) => setConfirmScale(event.target.checked)}
                  className="h-4 w-4"
                />
                Apply to Railway
              </label>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <button
                  onClick={runAutoscalerOnce}
                  disabled={running}
                  className="inline-flex items-center justify-center gap-1.5 bg-gray-100 px-2 py-2 text-xs font-semibold text-admin-text hover:bg-gray-200 disabled:opacity-60"
                >
                  <Play size={14} />
                  Run
                </button>
                <button
                  onClick={() => override(targetReplicas, 'admin_scale_up_override')}
                  disabled={running || targetReplicas <= plan.capacity.currentReplicas}
                  className="inline-flex items-center justify-center gap-1.5 bg-admin-accent px-2 py-2 text-xs font-semibold text-white hover:bg-admin-accent-hover disabled:opacity-60"
                >
                  <ArrowUp size={14} />
                  Up
                </button>
                <button
                  onClick={() => override(targetReplicas, 'admin_scale_down_override')}
                  disabled={running || targetReplicas >= plan.capacity.currentReplicas}
                  className="inline-flex items-center justify-center gap-1.5 bg-admin-danger px-2 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-60"
                >
                  <ArrowDown size={14} />
                  Down
                </button>
              </div>
            </section>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-separate border-spacing-y-2">
              <thead>
                <tr className="text-left text-[11px] uppercase text-admin-text-muted">
                  <th className="px-3 py-1 font-semibold">Check</th>
                  <th className="px-3 py-1 font-semibold">Status</th>
                  <th className="px-3 py-1 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {plan.checks.map((check) => (
                  <tr key={check.name} className="bg-gray-50 text-sm text-admin-text">
                    <td className="rounded-l-xl border-y border-l border-gray-100 px-3 py-3 font-semibold">
                      {formatAction(check.name)}
                    </td>
                    <td className="border-y border-gray-100 px-3 py-3">
                      <StatusPill status={check.status} />
                    </td>
                    <td className="rounded-r-xl border-y border-r border-gray-100 px-3 py-3 text-xs text-admin-text-muted">
                      {check.detail || check.reason || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
