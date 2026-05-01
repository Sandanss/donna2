export default function CallCard({ conversation }) {
  const date = new Date(conversation.startedAt || conversation.createdAt);
  const dateStr = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  const displayStatus = conversation.displayStatus || conversation.status || 'completed';
  const summary = conversation.summary || conversation.analysis?.summary;

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
      {summary && (
        <p style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5, marginTop: 4 }}>
          {summary}
        </p>
      )}
    </div>
  );
}
