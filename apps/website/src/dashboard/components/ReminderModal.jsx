import { useState } from 'react';

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function ReminderModal({ reminder, schedule = [], onSave, onClose }) {
  // Split description and FAQs for editing
  const parts = (reminder?.description || '').split('\n\nFAQs:\n');
  const [title, setTitle] = useState(reminder?.title || '');
  const [description, setDescription] = useState(parts[0] || '');
  const [faqs, setFaqs] = useState(parts[1] || '');
  const [selectedCallIndices, setSelectedCallIndices] = useState(() => {
    if (!reminder?.id) return [];
    return schedule
      .map((call, idx) => (call.reminderIds || []).includes(reminder.id) ? idx : -1)
      .filter((i) => i !== -1);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleCall = (idx) => {
    setSelectedCallIndices((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      let fullDescription = description.trim();
      if (faqs.trim()) {
        fullDescription += '\n\nFAQs:\n' + faqs.trim();
      }
      await onSave(
        { title: title.trim(), description: fullDescription, type: 'custom', isActive: true },
        selectedCallIndices
      );
    } catch (err) {
      setError(err.message || 'Failed to save reminder.');
      setSaving(false);
    }
  };

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-6)' }}>
          <h2 className="db-modal__title" style={{ marginBottom: 0 }}>
            {reminder ? 'Edit Reminder' : 'New Reminder'}
          </h2>
          <button className="db-btn db-btn--icon" onClick={onClose} title="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="db-field">
            <label className="db-label">Title</label>
            <input
              className="db-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Call Emma after lunch"
              required
            />
          </div>

          <div className="db-field">
            <label className="db-label">Description (Optional)</label>
            <textarea
              className="db-input db-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add more details about this reminder..."
            />
          </div>

          <div className="db-field">
            <label className="db-label">FAQs - Answers to common questions (Optional)</label>
            <textarea
              className="db-input db-textarea"
              value={faqs}
              onChange={(e) => setFaqs(e.target.value)}
              placeholder="e.g., Emma usually answers after 1 PM. Ask how her trip went."
              style={{ minHeight: 100 }}
            />
            <div className="db-helper-text">
              Help Donna answer follow-up questions about this reminder.
            </div>
          </div>

          {schedule.length > 0 && (
            <div className="db-field">
              <label className="db-label">Which scheduled calls should deliver this reminder?</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {schedule.map((call, idx) => (
                  <label key={idx} className="db-call-check">
                    <input
                      type="checkbox"
                      checked={selectedCallIndices.includes(idx)}
                      onChange={() => toggleCall(idx)}
                    />
                    <div className="db-call-check__info">
                      <span className="db-call-check__title">{call.title || 'Scheduled Call'}</span>
                      <span className="db-call-check__schedule">{formatCallSchedule(call)}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && <p className="db-error-inline">{error}</p>}

          <button
            type="submit"
            className="db-btn db-btn--primary db-btn--wide"
            disabled={saving || !title.trim()}
            style={{ marginTop: 'var(--space-4)' }}
          >
            {saving ? 'Saving...' : 'Save Reminder'}
          </button>
        </form>
      </div>
    </div>
  );
}

function formatCallSchedule(call) {
  const time = formatTime(call.time || '10:00');
  if (call.frequency === 'daily') return `Daily at ${time}`;
  if (call.frequency === 'recurring' && call.recurringDays) {
    if (call.recurringDays.length === 7) return `Daily at ${time}`;
    const days = call.recurringDays.map((i) => DAYS_FULL[i]?.slice(0, 3)).join(', ');
    return `${days} at ${time}`;
  }
  if (call.date) {
    const [y, m, d] = call.date.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const formatted = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `One-time on ${formatted} at ${time}`;
  }
  return `One-time at ${time}`;
}

function formatTime(time) {
  if (/am|pm/i.test(time)) return time;
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}
