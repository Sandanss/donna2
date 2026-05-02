import { useState, useEffect, useRef } from 'react';
import { useDashboard } from './DashboardContext';
import BackButton from './components/BackButton';

const DEFAULTS = { callSummaries: true, pauseCalls: false };

export default function NotificationSettings() {
  const { api } = useDashboard();
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savedPrefs = useRef(null);

  useEffect(() => {
    loadPrefs();
  }, []);

  async function loadPrefs() {
    try {
      const data = await api.getNotificationPrefs();
      const merged = { ...DEFAULTS, ...data };
      setPrefs(merged);
      savedPrefs.current = merged;
    } catch {
      setPrefs({ ...DEFAULTS });
      savedPrefs.current = { ...DEFAULTS };
    } finally {
      setLoading(false);
    }
  }

  const togglePref = (key) => {
    setPrefs(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const isDirty = prefs && savedPrefs.current && (
    prefs.callSummaries !== savedPrefs.current.callSummaries ||
    prefs.pauseCalls !== savedPrefs.current.pauseCalls
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateNotificationPrefs({
        callSummaries: prefs.callSummaries,
        pauseCalls: prefs.pauseCalls,
      });
      savedPrefs.current = { ...prefs };
    } catch (err) {
      setPrefs({ ...savedPrefs.current });
      alert('Failed to save: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="db-loading"><div className="db-spinner" /></div>;
  }

  return (
    <div>
      <BackButton />
      <div className="db-page__header">
        <h1 className="db-page__title">Notifications</h1>
      </div>

      <div className="db-card" style={{ padding: 24 }}>
        <ToggleRow
          label="Call Summaries"
          description="Receive a summary after each call"
          checked={prefs?.callSummaries}
          onChange={() => togglePref('callSummaries')}
        />
        <ToggleRow
          label="Pause All Calls"
          description="Temporarily stop all scheduled calls"
          checked={prefs?.pauseCalls}
          onChange={() => togglePref('pauseCalls')}
        />

        <button
          className="db-btn db-btn--primary"
          onClick={handleSave}
          disabled={!isDirty || saving}
          style={{ marginTop: 20, width: '100%' }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }) {
  return (
    <div className="db-toggle">
      <div>
        <div className="db-toggle__label">{label}</div>
        {description && <div className="db-toggle__desc">{description}</div>}
      </div>
      <button
        className={`db-toggle__switch ${checked ? 'db-toggle__switch--on' : ''}`}
        onClick={onChange}
        type="button"
        aria-label={label}
      />
    </div>
  );
}
