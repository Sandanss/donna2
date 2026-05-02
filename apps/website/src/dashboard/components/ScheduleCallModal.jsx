import { useState, useRef, useEffect } from 'react';

const ALL_DAYS = [
  { idx: 1, label: 'Mon' },
  { idx: 2, label: 'Tue' },
  { idx: 3, label: 'Wed' },
  { idx: 4, label: 'Thu' },
  { idx: 5, label: 'Fri' },
  { idx: 6, label: 'Sat' },
  { idx: 0, label: 'Sun' },
];

const TIME_OPTIONS = [];
for (let h = 0; h <= 23; h++) {
  for (const m of ['00', '30']) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    TIME_OPTIONS.push({ value: `${h}:${m}`, label: `${hour}:${m} ${ampm}` });
  }
}

function formatTime24to12(time24) {
  const [hStr, mStr] = time24.split(':');
  const h = parseInt(hStr, 10);
  const m = mStr || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.padStart(2, '0')} ${ampm}`;
}

function parseTimeInput(input) {
  const s = input.trim().replace(/\s+/g, ' ');

  // Try "H:MM AM/PM" or "HH:MM AM/PM" or "H:MMAM"
  const ampmMatch = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm|Am|Pm)$/i);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = parseInt(ampmMatch[2], 10);
    const period = ampmMatch[3].toUpperCase();
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (period === 'AM' && h === 12) h = 0;
    else if (period === 'PM' && h !== 12) h += 12;
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  // Try "HH:MM" (24h)
  const h24Match = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24Match) {
    const h = parseInt(h24Match[1], 10);
    const m = parseInt(h24Match[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  // Try "HHMM" (4 digits)
  const digitsMatch = s.match(/^(\d{3,4})$/);
  if (digitsMatch) {
    const digits = digitsMatch[1].padStart(4, '0');
    const h = parseInt(digits.slice(0, 2), 10);
    const m = parseInt(digits.slice(2), 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  return null;
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function TimeCombobox({ value, onChange }) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [editText, setEditText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const displayValue = formatTime24to12(value);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setDropdownOpen(false);
        if (isEditing) {
          commitEdit();
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isEditing, editText]);

  // Scroll to current value when dropdown opens
  useEffect(() => {
    if (dropdownOpen && listRef.current) {
      const activeItem = listRef.current.querySelector('.db-time-dropdown__item--active');
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [dropdownOpen]);

  const commitEdit = () => {
    const parsed = parseTimeInput(editText);
    if (parsed) {
      onChange(parsed);
    }
    setIsEditing(false);
  };

  const handleInputClick = () => {
    setIsEditing(true);
    setEditText(displayValue);
    setDropdownOpen(false);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const handleArrowClick = (e) => {
    e.stopPropagation();
    if (isEditing) {
      commitEdit();
    }
    setDropdownOpen((prev) => !prev);
  };

  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  const handleOptionClick = (optValue) => {
    onChange(optValue);
    setDropdownOpen(false);
    setIsEditing(false);
  };

  return (
    <div className="db-time-combobox" ref={containerRef}>
      <div className="db-time-combobox__control" onClick={handleInputClick}>
        {isEditing ? (
          <input
            ref={inputRef}
            className="db-time-combobox__input"
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleInputKeyDown}
            onBlur={commitEdit}
            autoFocus
          />
        ) : (
          <span className="db-time-combobox__display">{displayValue}</span>
        )}
        <button
          type="button"
          className="db-time-combobox__arrow"
          onClick={handleArrowClick}
          tabIndex={-1}
          aria-label="Toggle time dropdown"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
      {dropdownOpen && (
        <div className="db-time-dropdown" ref={listRef}>
          {TIME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`db-time-dropdown__item ${opt.value === value ? 'db-time-dropdown__item--active' : ''}`}
              onClick={() => handleOptionClick(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ScheduleCallModal({ call, reminders = [], onSave, onClose }) {
  const [title, setTitle] = useState(call?.title || 'Daily Check-in');
  const [frequency, setFrequency] = useState(call?.frequency || 'daily');
  const [recurringDays, setRecurringDays] = useState(
    call?.recurringDays || [1, 2, 3, 4, 5]
  );
  const [time, setTime] = useState(call?.time || '10:00');
  const [date, setDate] = useState(call?.date || getTodayStr());
  const [selectedReminderIds, setSelectedReminderIds] = useState(call?.reminderIds || []);
  const [saving, setSaving] = useState(false);

  const toggleDay = (dayIdx) => {
    setRecurringDays((prev) =>
      prev.includes(dayIdx) ? prev.filter((d) => d !== dayIdx) : [...prev, dayIdx]
    );
  };

  const toggleReminder = (reminderId) => {
    setSelectedReminderIds((prev) =>
      prev.includes(reminderId) ? prev.filter((id) => id !== reminderId) : [...prev, reminderId]
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const callData = {
      title: title.trim() || 'Daily Check-in',
      frequency,
      time,
    };
    if (frequency === 'recurring') {
      callData.recurringDays = recurringDays;
    }
    if (frequency === 'one_time') {
      callData.date = date;
    }
    if (selectedReminderIds.length > 0) {
      callData.reminderIds = selectedReminderIds;
    }
    await onSave(callData);
    setSaving(false);
  };

  const isSubmitDisabled =
    saving ||
    (frequency === 'recurring' && recurringDays.length === 0) ||
    (frequency === 'one_time' && !date);

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="db-modal__title">{call ? 'Edit Call' : 'Schedule a Call'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="db-field">
            <label className="db-label">Title</label>
            <input
              className="db-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Morning Check-in"
            />
          </div>

          <div className="db-field">
            <label className="db-label">Frequency</label>
            <div className="db-pills">
              <button
                type="button"
                className={`db-pill ${frequency === 'daily' ? 'db-pill--active' : ''}`}
                onClick={() => setFrequency('daily')}
              >
                Every Day
              </button>
              <button
                type="button"
                className={`db-pill ${frequency === 'recurring' ? 'db-pill--active' : ''}`}
                onClick={() => setFrequency('recurring')}
              >
                Specific Days
              </button>
              <button
                type="button"
                className={`db-pill ${frequency === 'one_time' ? 'db-pill--active' : ''}`}
                onClick={() => setFrequency('one_time')}
              >
                One Time
              </button>
            </div>
          </div>

          {frequency === 'recurring' && (
            <div className="db-field">
              <label className="db-label">Days</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {ALL_DAYS.map(({ idx, label }) => (
                  <button
                    key={idx}
                    type="button"
                    className={`db-pill ${recurringDays.includes(idx) ? 'db-pill--active' : ''}`}
                    onClick={() => toggleDay(idx)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {frequency === 'one_time' && (
            <div className="db-field">
              <label className="db-label">Date</label>
              <input
                className="db-input"
                type="date"
                value={date}
                min={getTodayStr()}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          )}

          <div className="db-field">
            <label className="db-label">Time</label>
            <TimeCombobox value={time} onChange={setTime} />
          </div>

          {reminders.length > 0 && (
            <div className="db-field">
              <label className="db-label">Reminders to deliver on this call</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {reminders.filter((r) => r.isActive !== false).map((reminder) => (
                  <label
                    key={reminder.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      fontSize: 14,
                      color: 'var(--fg-1)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedReminderIds.includes(reminder.id)}
                      onChange={() => toggleReminder(reminder.id)}
                      style={{ accentColor: 'var(--color-sage-dark)' }}
                    />
                    {reminder.title}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="db-modal__actions">
            <button type="button" className="db-btn db-btn--ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="db-btn db-btn--primary"
              disabled={isSubmitDisabled}
            >
              {saving ? 'Saving...' : call ? 'Save Changes' : 'Add Call'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
