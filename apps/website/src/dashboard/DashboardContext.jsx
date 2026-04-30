import { createContext, useContext, useState, useEffect } from 'react';
import { useApi } from '../lib/api';

const DashboardContext = createContext(null);

export function DashboardProvider({ children }) {
  const api = useApi();
  const [senior, setSenior] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.getMe();
        if (cancelled) return;
        if (data.seniors?.length > 0) {
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

  return (
    <DashboardContext.Provider value={{ senior, setSenior, loading, error, api }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}
