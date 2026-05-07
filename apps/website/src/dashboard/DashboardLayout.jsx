import React, { useState, Suspense } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { DashboardProvider, useDashboard } from './DashboardContext';
import FloatingActionButton from './components/FloatingActionButton';
import InstantCallModal from './components/InstantCallModal';
import './dashboard.css';

const ChatPanel = React.lazy(() => import('./components/ChatPanel'));

const navItems = [
  { to: '/dashboard', label: 'Home', icon: 'home', end: true },
  { to: '/dashboard/schedule', label: 'Schedule', icon: 'schedule' },
  { to: '/dashboard/reminders', label: 'Reminders', icon: 'reminders' },
  { to: '/dashboard/settings', label: 'Settings', icon: 'settings' },
];

function NavIcon({ icon }) {
  switch (icon) {
    case 'home':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case 'reminders':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
      );
    case 'schedule':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case 'settings':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
}

const pageVariants = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
};

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

function DashboardInner() {
  const { senior, api } = useDashboard();
  const [callModalOpen, setCallModalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const location = useLocation();

  return (
    <div className="dashboard">
      {/* Desktop sidebar */}
      <aside className="db-sidebar">
        <a href="/" className="db-sidebar__logo">Donna</a>
        <nav className="db-sidebar__nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `db-sidebar__link ${isActive ? 'db-sidebar__link--active' : ''}`
              }
            >
              <NavIcon icon={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <button className="db-sidebar__chat-btn" onClick={() => setChatOpen(true)}>
          <ChatIcon />
          <span>Ask Donna</span>
        </button>
      </aside>

      {/* Main content */}
      <div className="db-content">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Mobile bottom tabs */}
      <nav className="db-tabs">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `db-tabs__link ${isActive ? 'db-tabs__link--active' : ''}`
            }
          >
            <NavIcon icon={item.icon} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* FAB */}
      <FloatingActionButton onClick={() => setCallModalOpen(true)} />

      {/* Mobile chat button */}
      <button className="db-chat-fab" onClick={() => setChatOpen(true)} aria-label="Ask Donna">
        <ChatIcon />
      </button>

      {/* Instant Call Modal */}
      {callModalOpen && senior && (
        <InstantCallModal
          senior={senior}
          api={api}
          onClose={() => setCallModalOpen(false)}
        />
      )}

      {/* Chat Panel */}
      {senior && (
        <Suspense fallback={null}>
          <ChatPanel
            visible={chatOpen}
            messages={chatMessages}
            setMessages={setChatMessages}
            onClose={() => setChatOpen(false)}
            onEndSession={() => { setChatMessages([]); setChatOpen(false); }}
          />
        </Suspense>
      )}
    </div>
  );
}

export default function DashboardLayout() {
  return (
    <DashboardProvider>
      <DashboardInner />
    </DashboardProvider>
  );
}
