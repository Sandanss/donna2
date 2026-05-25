import { useEffect, useState } from 'react';
import { api, type CallAnalysis } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { useToast } from '@/components/Toast';

function getScoreColor(score: number | null | undefined): string {
  if (score == null) return 'text-admin-text-muted';
  if (score >= 7) return 'text-admin-success';
  if (score >= 4) return 'text-admin-warning';
  return 'text-admin-danger';
}

export default function CallAnalyses() {
  const { showToast } = useToast();
  const [analyses, setAnalyses] = useState<CallAnalysis[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.callAnalyses
      .list()
      .then(setAnalyses)
      .catch((err: any) => showToast(err.message || 'Failed to load analyses', 'error'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-center py-10 text-admin-text-muted">Loading...</p>;
  }

  return (
    <div>
      <div className="bg-white rounded-xl p-5 mb-5 shadow-card">
        <h2 className="text-base font-bold text-admin-text-light border-b-2 border-admin-primary pb-2 mb-4">
          Call Analyses
        </h2>
        {analyses.length === 0 ? (
          <p className="text-center py-10 text-admin-text-muted">No analyses yet</p>
        ) : (
          analyses.map((a) => {
            const scoreColor = getScoreColor(a.engagementScore);

            return (
              <div key={a.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3.5 mb-3">
                {/* Header */}
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h3 className="text-[15px] font-semibold">{a.seniorName || 'Unknown'}</h3>
                    <p className="text-xs text-admin-text-muted">{formatDate(a.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <div className={cn('text-2xl font-bold', scoreColor)}>
                      {a.engagementScore || '-'}/10
                    </div>
                    <p className="text-xs text-admin-text-muted">Engagement</p>
                  </div>
                </div>

                {/* Summary */}
                <p className="text-sm text-admin-text-light">{a.summary || 'No summary'}</p>

                {/* Topics */}
                {Array.isArray(a.topics) && a.topics.length > 0 && (
                  <div className="mt-2">
                    {a.topics.map((t, i) => (
                      <span
                        key={i}
                        className="inline-block bg-admin-tag text-admin-primary px-2 py-0.5 rounded-full text-[11px] mr-1"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}

                {/* Positive Observations */}
                {Array.isArray(a.positiveObservations) && a.positiveObservations.length > 0 && (
                  <div className="mt-2">
                    <span className="text-xs font-semibold text-admin-success">Positive: </span>
                    <span className="text-sm text-admin-text-light">
                      {a.positiveObservations.join(', ')}
                    </span>
                  </div>
                )}

                {/* Follow-up Suggestions */}
                {Array.isArray(a.followUpSuggestions) && a.followUpSuggestions.length > 0 && (
                  <div className="mt-2">
                    <span className="text-xs font-semibold text-admin-primary">Follow-up: </span>
                    <span className="text-sm text-admin-text-light">
                      {a.followUpSuggestions.join(', ')}
                    </span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
