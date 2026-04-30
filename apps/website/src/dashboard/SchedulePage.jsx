import { useState, useEffect, useMemo } from 'react';
import { useDashboard } from './DashboardContext';
import WeekStrip from './components/WeekStrip';
import MonthPicker from './components/MonthPicker';
import ScheduleCallCard from './components/ScheduleCallCard';
import ScheduleCallModal from './components/ScheduleCallModal';

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function SchedulePage() {
  const { senior, loading: ctxLoading, api } = useDashboard();
  const [schedule, setSchedule] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCall, setEditingCall] = useState(null);

  useEffect(() => {
    if (!senior) return;
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
        console.error('Failed to load schedule data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadData();
    return () => { cancelled = true; };
  }, [senior]);

  const handleAdd = () => {
    setEditingCall(null);
    setModalOpen(true);
  };

  const handleEdit = (call, index) => {
    setEditingCall({ ...call, _index: index });
    setModalOpen(true);
  };

  const handleDelete = async (index) => {
    if (!confirm('Delete this scheduled call?')) return;
    const updated = schedule.filter((_, i) => i !== index);
    try {
      await api.updateSchedule(senior.id, { schedule: updated });
      setSchedule(updated);
    } catch (err) {
      alert('Failed to delete call: ' + err.message);
    }
  };

  const handleSave = async (callData) => {
    let updated;
    if (editingCall !== null && editingCall._index !== undefined) {
      updated = schedule.map((c, i) => (i === editingCall._index ? callData : c));
    } else {
      updated = [...schedule, callData];
    }
    try {
      await api.updateSchedule(senior.id, { schedule: updated });
      setSchedule(updated);
      setModalOpen(false);
      setEditingCall(null);
    } catch (err) {
      alert('Failed to save call: ' + err.message);
    }
  };

  const navigateWeek = (delta) => {
    setSelectedDate((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + delta * 7);
      return d;
    });
  };

  const handleMonthSelect = (date) => {
    setSelectedDate(date);
  };

  const selectedDayIdx = selectedDate.getDay();
  const selectedDayName = DAYS_FULL[selectedDayIdx];

  const safeSchedule = Array.isArray(schedule) ? schedule : [];

  const scheduledDays = useMemo(() => {
    const days = new Set();
    for (const call of safeSchedule) {
      if (call.frequency === 'daily') {
        DAYS_FULL.forEach((d) => days.add(d));
      } else if (call.frequency === 'recurring' && call.recurringDays) {
        call.recurringDays.forEach((idx) => days.add(DAYS_FULL[idx]));
      }
    }
    return days;
  }, [safeSchedule]);

  const reminderMap = useMemo(() => {
    const map = {};
    const safeReminders = Array.isArray(reminders) ? reminders : [];
    for (const r of safeReminders) {
      map[r.id] = r.title;
    }
    return map;
  }, [reminders]);

  const callsForDay = safeSchedule
    .map((c, i) => ({ ...c, _index: i }))
    .filter((c) => {
      if (c.frequency === 'daily') return true;
      if (c.frequency === 'recurring' && c.recurringDays?.includes(selectedDayIdx)) return true;
      return false;
    });

  if (ctxLoading || loading) {
    return <div className="db-loading"><div className="db-spinner" /></div>;
  }

  return (
    <div>
      <div
        className="db-page__header"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <h1 className="db-page__title">Schedule</h1>
        <button className="db-btn db-btn--primary db-btn--small" onClick={handleAdd}>
          Add Call
        </button>
      </div>

      <MonthPicker currentDate={selectedDate} onSelectMonth={handleMonthSelect} />

      <WeekStrip
        selectedDate={selectedDate}
        onSelectDate={setSelectedDate}
        scheduledDays={scheduledDays}
        onPrevWeek={() => navigateWeek(-1)}
        onNextWeek={() => navigateWeek(1)}
      />

      <div className="db-section">
        <h2 className="db-section__title">
          {selectedDayName}
        </h2>
        {callsForDay.length === 0 ? (
          <div className="db-empty">
            <p className="db-empty__text">No calls scheduled for {selectedDayName}.</p>
            <button className="db-btn db-btn--primary db-btn--small" onClick={handleAdd}>
              Schedule a Call
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {callsForDay.map((call) => (
              <ScheduleCallCard
                key={call._index}
                call={call}
                reminderMap={reminderMap}
                onEdit={() => handleEdit(call, call._index)}
                onDelete={() => handleDelete(call._index)}
              />
            ))}
          </div>
        )}
      </div>

      {modalOpen && (
        <ScheduleCallModal
          call={editingCall}
          reminders={Array.isArray(reminders) ? reminders : []}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditingCall(null); }}
        />
      )}
    </div>
  );
}
