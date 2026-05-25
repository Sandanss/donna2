import { PlusIcon, TrashIcon } from './icons';

const CALL_TITLES = ['Daily Check-in', 'Morning Call', 'Evening Chat', 'Reminder Call'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FREQUENCIES = [
  { value: 'daily', label: 'Every day' },
  { value: 'recurring', label: 'Specific days' },
  { value: 'one-time', label: 'One time' },
];

function generateTimeOptions() {
  const times = [];
  for (let h = 7; h <= 21; h++) {
    for (let m = 0; m < 60; m += 30) {
      const hour = h % 12 || 12;
      const ampm = h < 12 ? 'AM' : 'PM';
      const label = `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
      const value = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      times.push({ label, value });
    }
  }
  return times;
}

const TIME_OPTIONS = generateTimeOptions();

function CallEditor({ call, index, reminders, onUpdate, onRemove }) {
  return (
    <div className="ob-reminder-card">
      {index > 0 && (
        <button
          className="ob-reminder-card__remove"
          onClick={() => onRemove(index)}
          aria-label="Remove call"
          type="button"
        >
          <TrashIcon size={16} />
        </button>
      )}

      <div className="ob-form-group">
        <label className="ob-label">Call title</label>
        <div className="ob-chip-row">
          {CALL_TITLES.map((t) => (
            <button
              key={t}
              type="button"
              className={`ob-chip${call.title === t ? ' ob-chip--selected' : ''}`}
              onClick={() => onUpdate(index, 'title', t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="ob-form-group">
        <label className="ob-label">Frequency</label>
        <div className="ob-freq-options">
          {FREQUENCIES.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`ob-freq-option${call.frequency === f.value ? ' ob-freq-option--selected' : ''}`}
              onClick={() => onUpdate(index, 'frequency', f.value)}
            >
              <div className="ob-freq-option__radio" />
              <span className="ob-freq-option__label">{f.label}</span>
            </button>
          ))}
        </div>
      </div>

      {call.frequency === 'recurring' && (
        <div className="ob-form-group">
          <label className="ob-label">Days</label>
          <div className="ob-day-grid">
            {DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                className={`ob-day-btn${(call.days || []).includes(i) ? ' ob-day-btn--selected' : ''}`}
                onClick={() => {
                  const days = call.days || [];
                  const next = days.includes(i)
                    ? days.filter((x) => x !== i)
                    : [...days, i];
                  onUpdate(index, 'days', next);
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="ob-form-group">
        <label className="ob-label">Time</label>
        <select
          className="ob-select"
          value={call.time || '10:00'}
          onChange={(e) => onUpdate(index, 'time', e.target.value)}
        >
          {TIME_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>

      {reminders.length > 0 && (
        <div className="ob-form-group">
          <label className="ob-label">Link reminders to this call</label>
          {reminders.map((r, ri) => {
            if (!r.title) return null;
            const linked = (call.reminderIds || []).includes(ri);
            return (
              <label
                key={ri}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={linked}
                  onChange={() => {
                    const ids = call.reminderIds || [];
                    const next = linked
                      ? ids.filter((x) => x !== ri)
                      : [...ids, ri];
                    onUpdate(index, 'reminderIds', next);
                  }}
                  style={{ accentColor: 'var(--color-sage)' }}
                />
                {r.title}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Step7_Schedule({ data, update }) {
  const calls = data.calls?.length
    ? data.calls
    : [{ title: 'Daily Check-in', frequency: 'daily', days: [], time: '10:00', reminderIds: [] }];

  const updateCall = (index, field, value) => {
    const updated = calls.map((c, i) =>
      i === index ? { ...c, [field]: value } : c
    );
    update({ calls: updated });
  };

  const addCall = () => {
    update({
      calls: [...calls, { title: '', frequency: 'daily', days: [], time: '10:00', reminderIds: [] }],
    });
  };

  const removeCall = (index) => {
    update({ calls: calls.filter((_, i) => i !== index) });
  };

  return (
    <div>
      <h1 className="ob-step-title">Call schedule</h1>
      <p className="ob-step-subtitle">
        Set up when Donna should call your loved one.
      </p>

      {calls.map((call, i) => (
        <CallEditor
          key={i}
          call={call}
          index={i}
          reminders={data.reminders || []}
          onUpdate={updateCall}
          onRemove={removeCall}
        />
      ))}

      <button type="button" className="ob-add-btn" onClick={addCall} style={{ marginTop: 12 }}>
        <PlusIcon size={18} />
        Add another call
      </button>
    </div>
  );
}
