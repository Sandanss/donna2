import { useState, useEffect, useCallback } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useDashboard } from './DashboardContext';
import CallCard from './components/CallCard';

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] },
};

const INITIAL_LIMIT = 8;
const PAGE_SIZE = 10;

export default function HomePage() {
  const { user } = useUser();
  const navigate = useNavigate();
  const { senior, loading: ctxLoading, error: ctxError, reload, api } = useDashboard();
  const [conversations, setConversations] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [notifPrefs, setNotifPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!senior) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      try {
        const [convos, schedData, nPrefs] = await Promise.all([
          api.getConversations(senior.id, { limit: INITIAL_LIMIT }),
          api.getSchedule(senior.id),
          api.getNotificationPrefs().catch(() => null),
        ]);
        if (!cancelled) {
          const list = Array.isArray(convos) ? convos : [];
          setConversations(list);
          setHasMore(list.length >= INITIAL_LIMIT);
          const sched = schedData?.schedule;
          setSchedule(Array.isArray(sched) ? sched : []);
          setNotifPrefs(nPrefs || { callSummaries: true, pauseCalls: false });
        }
      } catch (err) {
        console.error('Failed to load home data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [senior]);

  const loadMore = useCallback(async () => {
    if (!senior || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await api.getConversations(senior.id, { limit: PAGE_SIZE, offset: conversations.length });
      const list = Array.isArray(more) ? more : [];
      setConversations(prev => [...prev, ...list]);
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      console.error('Failed to load more calls:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [senior, conversations.length, loadingMore, api]);

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

  const firstName = user?.firstName || 'there';
  const seniorName = senior?.name || senior?.seniorName || 'your loved one';
  const seniorInitial = seniorName.charAt(0).toUpperCase();
  const nextCall = getNextCall(schedule);

  return (
    <div>
      {/* Header */}
      <motion.div
        className="db-page__header"
        {...fadeUp}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <h1 className="db-page__title">Hello, {firstName}</h1>
          <p className="db-page__subtitle">Here&apos;s what&apos;s happening with {seniorName}</p>
        </div>
        <div className="db-avatar" onClick={() => navigate('/dashboard/settings/loved-one')} style={{ cursor: 'pointer' }}>{seniorInitial}</div>
      </motion.div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Next Call Card — paused state or normal */}
        {notifPrefs?.pauseCalls ? (
          <motion.div
            className="db-card db-card--sage"
            {...fadeUp}
            transition={{ delay: 0.1, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => navigate('/dashboard/settings/notifications')}
            style={{ cursor: 'pointer' }}
          >
            <div className="db-card__label">Next Call</div>
            <div style={{ fontSize: 16, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              Donna calls have been paused. Resume them in{' '}
              <span style={{ fontWeight: 600, color: 'var(--fg-1)', textDecoration: 'underline' }}>Notifications</span>.
            </div>
          </motion.div>
        ) : nextCall ? (
          <motion.div
            className="db-card db-card--sage"
            {...fadeUp}
            transition={{ delay: 0.1, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => navigate('/dashboard/schedule')}
            style={{ cursor: 'pointer' }}
          >
            <div className="db-card__label">Next Call</div>
            <div style={{ fontSize: 26, fontWeight: 600, fontFamily: 'var(--font-heading)' }}>
              {nextCall.day} at {nextCall.time}
            </div>
          </motion.div>
        ) : null}

        {/* Summaries-off banner */}
        {notifPrefs && notifPrefs.callSummaries === false && conversations.length > 0 && (
          <motion.div
            className="db-card"
            {...fadeUp}
            transition={{ delay: 0.12, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => navigate('/dashboard/settings/notifications')}
            style={{ cursor: 'pointer', padding: '12px 16px', background: 'var(--bg-2)', fontSize: 14, color: 'var(--fg-2)' }}
          >
            Call summaries are off. Turn on in{' '}
            <span style={{ fontWeight: 600, color: 'var(--fg-1)', textDecoration: 'underline' }}>Notifications</span>.
          </motion.div>
        )}

        {/* Recent Calls */}
        <motion.div className="db-section" {...fadeUp} transition={{ delay: 0.15, duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
          <h2 className="db-section__title">Recent Calls</h2>
          {conversations.length === 0 ? (
            <div className="db-empty">
              <div className="db-empty__icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
                </svg>
              </div>
              <p className="db-empty__text">No calls yet. Donna will start calling {seniorName} based on your schedule.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {conversations.map((convo) => (
                <CallCard key={convo.id} conversation={convo} seniorName={seniorName} hideSummary={notifPrefs?.callSummaries === false} />
              ))}
              {hasMore && (
                <button
                  className="db-btn db-btn--secondary"
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{ alignSelf: 'center', marginTop: 4 }}
                >
                  {loadingMore ? 'Loading...' : 'Show More'}
                </button>
              )}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

function getNextCall(scheduleData) {
  const calls = Array.isArray(scheduleData) ? scheduleData : [];
  if (calls.length === 0) return null;

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const now = new Date();
  const currentDay = now.getDay();
  const currentTime = now.getHours() * 60 + now.getMinutes();

  let best = null;
  let bestDistance = Infinity;

  for (const call of calls) {
    // Build list of day indices this call occurs on
    let dayIndices = [];
    if (call.frequency === 'daily') {
      dayIndices = [0, 1, 2, 3, 4, 5, 6];
    } else if (call.frequency === 'recurring' && call.recurringDays) {
      dayIndices = call.recurringDays;
    }

    for (const dayIdx of dayIndices) {
      const timeStr = call.time || '10:00';
      const timeParts = timeStr.replace(/\s*(AM|PM)/i, '').split(':').map(Number);
      let [h, m] = timeParts;
      if (/PM/i.test(timeStr) && h < 12) h += 12;
      if (/AM/i.test(timeStr) && h === 12) h = 0;
      const callMinutes = h * 60 + m;

      let distance = (dayIdx - currentDay) * 1440 + (callMinutes - currentTime);
      if (distance <= 0) distance += 7 * 1440;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = {
          day: days[dayIdx],
          time: formatTime(call.time || '10:00'),
          title: call.title,
        };
      }
    }
  }

  return best;
}

function formatTime(time) {
  if (/am|pm/i.test(time)) return time;
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}
