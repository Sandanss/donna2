import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useApi } from '../lib/api';

const DashboardContext = createContext(null);

export function DashboardProvider({ children }) {
  const api = useApi();
  const [senior, setSenior] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [schedule, setSchedule] = useState([]);
  const [reminders, setReminders] = useState([]);

  // Single-phase load: senior → then schedule + reminders in one effect
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.getMe();
        if (cancelled) return;
        if (data.seniors?.length > 0) {
          const s = data.seniors[0];
          setSenior(s);
          // Load schedule + reminders now that we have the senior
          try {
            const [schedData, remData] = await Promise.all([
              api.getSchedule(s.id),
              api.getReminders(),
            ]);
            if (!cancelled) {
              const sched = schedData?.schedule;
              setSchedule(Array.isArray(sched) ? sched : []);
              setReminders(Array.isArray(remData) ? remData : []);
            }
          } catch (dataErr) {
            console.error('Failed to load schedule/reminders:', dataErr);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const refreshSchedule = useCallback(async () => {
    if (!senior) return;
    try {
      const schedData = await api.getSchedule(senior.id);
      const sched = schedData?.schedule;
      setSchedule(Array.isArray(sched) ? sched : []);
    } catch (err) {
      console.error('Failed to refresh schedule:', err);
    }
  }, [senior]);

  const refreshReminders = useCallback(async () => {
    try {
      const remData = await api.getReminders();
      setReminders(Array.isArray(remData) ? remData : []);
    } catch (err) {
      console.error('Failed to refresh reminders:', err);
    }
  }, []);

  return (
    <DashboardContext.Provider value={{
      senior, setSenior,
      loading, error, api,
      schedule, setSchedule,
      reminders, setReminders,
      refreshSchedule, refreshReminders,
    }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}
