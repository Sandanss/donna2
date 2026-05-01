import { useState, useEffect } from 'react';
import { useDashboard } from './DashboardContext';
import ReminderCard from './components/ReminderCard';
import ReminderModal from './components/ReminderModal';
import DeleteReminderModal from './components/DeleteReminderModal';

export default function RemindersPage() {
  const { senior, loading: ctxLoading, error: ctxError, reload, api } = useDashboard();
  const [schedule, setSchedule] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingReminder, setEditingReminder] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletingReminder, setDeletingReminder] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!senior) { setLoading(false); return; }
    let cancelled = false;
    async function loadData() {
      try {
        const [schedData, remData] = await Promise.all([
          api.getSchedule(senior.id),
          api.getReminders(),
        ]);
        if (!cancelled) {
          const sched = schedData?.schedule;
          setSchedule(Array.isArray(sched) ? sched : []);
          setReminders(Array.isArray(remData) ? remData : []);
        }
      } catch (err) {
        console.error('Failed to load reminders data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadData();
    return () => { cancelled = true; };
  }, [senior]);

  const seniorFirstName = senior?.name?.split(' ')[0] || 'your senior';

  const safeSchedule = Array.isArray(schedule) ? schedule : [];
  const safeReminders = Array.isArray(reminders) ? reminders : [];
  const activeReminders = safeReminders.filter((r) => r.isActive !== false);

  function getLinkedCalls(reminderId) {
    return safeSchedule.filter((call) => (call.reminderIds || []).includes(reminderId));
  }

  const handleAdd = () => {
    setEditingReminder(null);
    setModalOpen(true);
  };

  const handleEdit = (reminder) => {
    setEditingReminder(reminder);
    setModalOpen(true);
  };

  const handleDeleteClick = (reminder) => {
    setDeletingReminder(reminder);
    setDeleteError('');
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingReminder) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api.deleteReminder(deletingReminder.id);
      // Remove reminder ID from all schedule entries
      const updatedSchedule = safeSchedule.map((call) => {
        if (!(call.reminderIds || []).includes(deletingReminder.id)) return call;
        return { ...call, reminderIds: call.reminderIds.filter((id) => id !== deletingReminder.id) };
      });
      if (JSON.stringify(updatedSchedule) !== JSON.stringify(safeSchedule)) {
        await api.updateSchedule(senior.id, { schedule: updatedSchedule });
        setSchedule(updatedSchedule);
      }
      setReminders((prev) => prev.filter((r) => r.id !== deletingReminder.id));
      setDeleteModalOpen(false);
      setDeletingReminder(null);
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete reminder.');
    } finally {
      setDeleting(false);
    }
  };

  const handleSave = async (reminderData, selectedCallIndices) => {
    let savedReminder;
    if (editingReminder) {
      savedReminder = await api.updateReminder(editingReminder.id, reminderData);
      savedReminder = { ...editingReminder, ...savedReminder, ...reminderData };
      setReminders((prev) => prev.map((r) => (r.id === editingReminder.id ? savedReminder : r)));
    } else {
      savedReminder = await api.createReminder({ ...reminderData, seniorId: senior.id });
      setReminders((prev) => [...prev, savedReminder]);
    }

    // Update schedule: add/remove this reminder's ID from calls
    const reminderId = savedReminder.id;
    const updatedSchedule = safeSchedule.map((call, idx) => {
      const currentIds = call.reminderIds || [];
      const shouldHave = selectedCallIndices.includes(idx);
      const hasIt = currentIds.includes(reminderId);
      if (shouldHave && !hasIt) return { ...call, reminderIds: [...currentIds, reminderId] };
      if (!shouldHave && hasIt) return { ...call, reminderIds: currentIds.filter((id) => id !== reminderId) };
      return call;
    });

    if (JSON.stringify(updatedSchedule) !== JSON.stringify(safeSchedule)) {
      await api.updateSchedule(senior.id, { schedule: updatedSchedule });
      setSchedule(updatedSchedule);
    }

    setModalOpen(false);
    setEditingReminder(null);
  };

  if (ctxLoading) {
    return <div className="db-loading"><div className="db-spinner" /></div>;
  }

  if (ctxError) {
    return (
      <div className="db-error">
        <p className="db-error__text">Something went wrong: {ctxError}</p>
        <button className="db-btn db-btn--primary" onClick={reload}>Try Again</button>
      </div>
    );
  }

  if (!senior) {
    return (
      <div className="db-empty">
        <p className="db-empty__text">No loved one found. Complete onboarding to get started.</p>
        <a className="db-btn db-btn--primary" href="/signup">Start Onboarding</a>
      </div>
    );
  }

  if (loading) {
    return <div className="db-loading"><div className="db-spinner" /></div>;
  }

  return (
    <div>
      <div className="db-page__header">
        <h1 className="db-page__title">Reminders</h1>
        <p className="db-page__subtitle">Manage what Donna reminds {seniorFirstName} about</p>
      </div>

      <button
        className="db-btn db-btn--primary db-btn--wide"
        onClick={handleAdd}
        style={{ marginBottom: 'var(--space-6)' }}
      >
        + Add New Reminder
      </button>

      {activeReminders.length === 0 ? (
        <div className="db-empty">
          <div className="db-empty__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
          </div>
          <p className="db-empty__text">
            No reminders yet. Add a reminder for Donna to mention during calls with {seniorFirstName}.
          </p>
        </div>
      ) : (
        <div>
          {activeReminders.map((reminder) => (
            <ReminderCard
              key={reminder.id}
              reminder={reminder}
              linkedCalls={getLinkedCalls(reminder.id)}
              onEdit={() => handleEdit(reminder)}
              onDelete={() => handleDeleteClick(reminder)}
            />
          ))}
        </div>
      )}

      {modalOpen && (
        <ReminderModal
          reminder={editingReminder}
          schedule={safeSchedule}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditingReminder(null); }}
        />
      )}

      {deleteModalOpen && deletingReminder && (
        <DeleteReminderModal
          reminder={deletingReminder}
          seniorName={seniorFirstName}
          onConfirm={handleDeleteConfirm}
          onClose={() => { setDeleteModalOpen(false); setDeletingReminder(null); }}
          deleting={deleting}
          error={deleteError}
        />
      )}
    </div>
  );
}
