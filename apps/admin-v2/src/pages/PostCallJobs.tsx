import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';
import { api, type PostCallJob } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { useToast } from '@/components/Toast';

function formatJobType(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function shortId(value: string | null | undefined) {
  if (!value) return '-';
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function failureLabel(job: PostCallJob) {
  return job.deadLetterReason || job.lastErrorCode || 'unknown';
}

export default function PostCallJobs() {
  const [jobs, setJobs] = useState<PostCallJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  async function loadJobs({ silent = false } = {}) {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const data = await api.postCallJobs.deadLetters();
      setJobs(data.jobs);
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load post-call jobs';
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function replayJob(job: PostCallJob) {
    setReplayingId(job.id);
    try {
      await api.postCallJobs.replay(job.id);
      setJobs((current) => current.filter((item) => item.id !== job.id));
      showToast('Post-call job replay queued');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to queue replay';
      showToast(message, 'error');
    } finally {
      setReplayingId(null);
    }
  }

  useEffect(() => {
    loadJobs();
  }, []);

  return (
    <div className="bg-white rounded-xl p-5 mb-5 shadow-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between border-b-2 border-admin-primary pb-2 mb-4">
        <div>
          <h2 className="text-base font-bold text-admin-text-light">Post-Call Dead Letters ({jobs.length})</h2>
          {error && (
            <p className="mt-1 text-xs font-semibold text-admin-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <button
          onClick={() => loadJobs({ silent: true })}
          disabled={loading || refreshing}
          className="inline-flex items-center justify-center gap-1.5 bg-gray-100 text-admin-text px-3 py-2 rounded-lg text-xs font-semibold hover:bg-gray-200 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-center py-10 text-admin-text-muted">Loading post-call jobs...</p>
      ) : !jobs.length ? (
        <div className="flex flex-col items-center justify-center py-10 text-admin-text-muted">
          <AlertTriangle size={22} className="mb-2 text-admin-text-muted" />
          <p>No dead-lettered post-call jobs</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-separate border-spacing-y-2">
            <thead>
              <tr className="text-left text-[11px] uppercase text-admin-text-muted">
                <th className="px-3 py-1 font-semibold">Job</th>
                <th className="px-3 py-1 font-semibold">Failure</th>
                <th className="px-3 py-1 font-semibold">Attempts</th>
                <th className="px-3 py-1 font-semibold">Call</th>
                <th className="px-3 py-1 font-semibold">Dead-Lettered</th>
                <th className="px-3 py-1 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="bg-gray-50 text-sm text-admin-text">
                  <td className="rounded-l-xl border-y border-l border-gray-100 px-3 py-3">
                    <div className="font-semibold">{formatJobType(job.jobType)}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-admin-text-muted">{shortId(job.id)}</div>
                  </td>
                  <td className="border-y border-gray-100 px-3 py-3">
                    <span className="inline-block max-w-[220px] truncate rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">
                      {failureLabel(job)}
                    </span>
                    {job.lastErrorAt && (
                      <div className="mt-1 text-[11px] text-admin-text-muted">{formatDate(job.lastErrorAt)}</div>
                    )}
                  </td>
                  <td className="border-y border-gray-100 px-3 py-3">
                    <span className="rounded-full bg-admin-tag px-2 py-0.5 text-[11px] font-semibold text-admin-primary">
                      {job.attemptCount}/{job.maxAttempts}
                    </span>
                  </td>
                  <td className="border-y border-gray-100 px-3 py-3">
                    <div className="font-mono text-[11px] text-admin-text-light">{shortId(job.callSid)}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-admin-text-muted">{shortId(job.conversationId)}</div>
                  </td>
                  <td className="border-y border-gray-100 px-3 py-3 text-xs text-admin-text-muted">
                    {formatDate(job.deadLetteredAt)}
                  </td>
                  <td className="rounded-r-xl border-y border-r border-gray-100 px-3 py-3 text-right">
                    <button
                      onClick={() => replayJob(job)}
                      disabled={replayingId === job.id}
                      className="inline-flex items-center justify-center gap-1.5 bg-admin-accent hover:bg-admin-accent-hover text-white px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    >
                      <RotateCcw size={14} className={cn(replayingId === job.id && 'animate-spin')} />
                      Replay
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
