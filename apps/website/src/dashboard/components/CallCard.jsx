function formatRelativeDate(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const callDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (callDay.getTime() === today.getTime()) return 'Today';
  if (callDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CallCard({ conversation, seniorName, hideSummary }) {
  const date = new Date(conversation.startedAt || conversation.createdAt);
  const dateStr = formatRelativeDate(date);
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  const displayStatus = conversation.displayStatus || conversation.status || 'completed';
  const name = seniorName || conversation.seniorName || 'them';
  const rawSummary = conversation.summary || conversation.analysis?.summary;

  // Build display summary with senior name for missed calls
  let summary = rawSummary;
  if (!summary && displayStatus === 'Missed') {
    summary = `Donna called but didn\u2019t reach ${name}. A voicemail was left.`;
  }

  const badgeClassMap = {
    Answered: 'db-badge--answered',
    Missed: 'db-badge--missed',
    Inbound: 'db-badge--inbound',
  };
  const badgeClass = badgeClassMap[displayStatus] || 'db-badge--completed';

  return (
    <div className="db-card" style={{ padding: 16, borderRadius: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: summary ? 8 : 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-1)' }}>
          {dateStr} at {timeStr}
        </div>
        <span className={`db-badge ${badgeClass}`}>{displayStatus}</span>
      </div>
      {summary && !hideSummary && (
        <p style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5, marginTop: 4 }}>
          {summary}
        </p>
      )}
    </div>
  );
}
