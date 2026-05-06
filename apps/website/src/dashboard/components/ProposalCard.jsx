import { useState } from 'react';
import { useDashboard } from '../DashboardContext';

function formatTime(time24) {
  if (!time24) return '';
  const [h, m] = time24.split(':');
  const hour = parseInt(h, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12}:${m} ${ampm}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function ScheduleItemRow({ item }) {
  return (
    <div className="db-proposal__item">
      <div className="db-proposal__item-badge db-proposal__item-badge--call">Call</div>
      <div className="db-proposal__item-details">
        <span className="db-proposal__item-title">{item.title}</span>
        <span className="db-proposal__item-meta">
          {formatTime(item.time)}
          {item.date && ` \u2022 ${formatDate(item.date)}`}
          {item.recurringDays?.length > 0 && ` \u2022 ${item.recurringDays.join(', ')}`}
        </span>
      </div>
    </div>
  );
}

function ReminderItemRow({ reminder }) {
  return (
    <div className="db-proposal__item db-proposal__item--reminder">
      <div className="db-proposal__item-badge db-proposal__item-badge--reminder">Reminder</div>
      <div className="db-proposal__item-details">
        <span className="db-proposal__item-title">{reminder.title}</span>
        {reminder.description && (
          <span className="db-proposal__item-meta">{reminder.description}</span>
        )}
      </div>
    </div>
  );
}

function normalizeScheduleItem(item) {
  const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ...item,
    frequency: item.frequency === 'weekly' ? 'recurring' : item.frequency,
    recurringDays: item.recurringDays?.map(d => typeof d === 'string' ? DAY_MAP[d] ?? d : d),
  };
}

export default function ProposalCard({ proposal, onConfirmed }) {
  const { senior, api } = useDashboard();
  const [status, setStatus] = useState('pending'); // pending | confirming | confirmed | error
  const [errorMsg, setErrorMsg] = useState('');
  const [expanded, setExpanded] = useState(false);

  const isLarge = (proposal.items?.length || 0) > 10 ||
    (proposal.scheduleItems?.length || 0) > 10;

  async function handleConfirm() {
    setStatus('confirming');
    setErrorMsg('');

    try {
      if (proposal.type === 'schedule_proposal') {
        // Get current schedule first, then append
        const current = await api.getSchedule(senior.id);
        const existingSchedule = current.schedule || [];
        const newItems = proposal.items.map(item => normalizeScheduleItem({
          title: item.title,
          frequency: item.frequency,
          time: item.time,
          ...(item.date && { date: item.date }),
          ...(item.recurringDays && { recurringDays: item.recurringDays }),
          ...(item.contextNotes && { contextNotes: item.contextNotes }),
        }));
        await api.updateSchedule(senior.id, {
          schedule: [...existingSchedule, ...newItems],
        });
      } else if (proposal.type === 'reminder_proposal') {
        for (const rem of proposal.reminders) {
          await api.createReminder({
            seniorId: senior.id,
            title: rem.title,
            description: rem.description,
            ...(rem.scheduledTime && { scheduledTime: rem.scheduledTime }),
            ...(rem.isRecurring !== undefined && { isRecurring: rem.isRecurring }),
            ...(rem.recurringDays && { recurringDays: rem.recurringDays }),
          });
        }
      } else if (proposal.type === 'blended_proposal') {
        // Create schedule items
        const current = await api.getSchedule(senior.id);
        const existingSchedule = current.schedule || [];
        const newItems = proposal.scheduleItems.map(item => normalizeScheduleItem({
          title: item.title,
          frequency: item.frequency,
          time: item.time,
          ...(item.date && { date: item.date }),
          ...(item.recurringDays && { recurringDays: item.recurringDays }),
          ...(item.contextNotes && { contextNotes: item.contextNotes }),
          reminderIds: [],
        }));

        // Create reminders and collect IDs
        const reminderIds = [];
        for (const rem of proposal.reminders) {
          const created = await api.createReminder({
            seniorId: senior.id,
            title: rem.title,
            description: rem.description,
            ...(rem.scheduledTime && { scheduledTime: rem.scheduledTime }),
            ...(rem.isRecurring !== undefined && { isRecurring: rem.isRecurring }),
            ...(rem.recurringDays && { recurringDays: rem.recurringDays }),
          });
          reminderIds.push(created.id);
        }

        // Link reminders to schedule items via linkages
        for (const link of proposal.linkages || []) {
          if (newItems[link.scheduleIndex] && reminderIds[link.reminderIndex]) {
            newItems[link.scheduleIndex].reminderIds.push(reminderIds[link.reminderIndex]);
          }
        }

        await api.updateSchedule(senior.id, {
          schedule: [...existingSchedule, ...newItems],
        });
      }

      setStatus('confirmed');
      if (onConfirmed) onConfirmed();
    } catch (err) {
      setStatus('error');
      setErrorMsg(err.message || 'Failed to save');
    }
  }

  function handleCancel() {
    setStatus('cancelled');
  }

  if (status === 'confirmed') {
    return (
      <div className="db-proposal-card db-proposal-card--confirmed">
        <div className="db-proposal__confirmed">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>Added!</span>
        </div>
      </div>
    );
  }

  if (status === 'cancelled') {
    return null;
  }

  const allItems = [];
  if (proposal.type === 'schedule_proposal') {
    (proposal.items || []).forEach((item, i) => allItems.push({ ...item, _type: 'schedule', _key: `s${i}` }));
  } else if (proposal.type === 'reminder_proposal') {
    (proposal.reminders || []).forEach((rem, i) => allItems.push({ ...rem, _type: 'reminder', _key: `r${i}` }));
  } else if (proposal.type === 'blended_proposal') {
    // Show schedule items with their linked reminders grouped together
    (proposal.scheduleItems || []).forEach((item, si) => {
      allItems.push({ ...item, _type: 'schedule', _key: `s${si}` });
      const linkedReminders = (proposal.linkages || [])
        .filter(l => l.scheduleIndex === si)
        .map(l => proposal.reminders[l.reminderIndex])
        .filter(Boolean);
      linkedReminders.forEach((rem, ri) => {
        allItems.push({ ...rem, _type: 'reminder', _linked: true, _key: `s${si}r${ri}` });
      });
    });
    // Add any unlinked reminders
    const linkedIndices = new Set((proposal.linkages || []).map(l => l.reminderIndex));
    (proposal.reminders || []).forEach((rem, i) => {
      if (!linkedIndices.has(i)) {
        allItems.push({ ...rem, _type: 'reminder', _key: `ur${i}` });
      }
    });
  }

  const displayItems = isLarge && !expanded ? allItems.slice(0, 5) : allItems;
  const totalCount = allItems.length;

  return (
    <div className="db-proposal-card">
      <div className="db-proposal__header">
        <span className="db-proposal__explanation">{proposal.explanation}</span>
        {isLarge && (
          <span className="db-proposal__count">{totalCount} items total</span>
        )}
      </div>

      <div className="db-proposal__items">
        {displayItems.map(item => (
          item._type === 'schedule'
            ? <ScheduleItemRow key={item._key} item={item} />
            : <ReminderItemRow key={item._key} reminder={item} />
        ))}
      </div>

      {isLarge && !expanded && (
        <button
          className="db-proposal__expand"
          onClick={() => setExpanded(true)}
        >
          Show all {totalCount} items
        </button>
      )}
      {isLarge && expanded && (
        <button
          className="db-proposal__expand"
          onClick={() => setExpanded(false)}
        >
          Collapse
        </button>
      )}

      {errorMsg && <div className="db-error-inline">{errorMsg}</div>}

      <div className="db-proposal__actions">
        <button
          className="db-btn db-btn--primary db-btn--small"
          onClick={handleConfirm}
          disabled={status === 'confirming'}
        >
          {status === 'confirming' ? 'Saving...' : 'Confirm All'}
        </button>
        <button
          className="db-btn db-btn--ghost db-btn--small"
          onClick={handleCancel}
          disabled={status === 'confirming'}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
