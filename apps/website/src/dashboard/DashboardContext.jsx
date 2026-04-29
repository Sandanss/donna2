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
  const [dataLoading, setDataLoading] = useState(true);

  // Phase 1: Load senior
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.getMe();
        if (!cancelled && data.seniors?.length > 0) {
          setSenior(data.seniors[0]);
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

  // Phase 2: Load schedule + reminders once senior is available
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
        console.error('Failed to load dashboard data:', err);
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    }
    loadData();
    return () => { cancelled = true; };
  }, [senior]);

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
      dataLoading,
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
