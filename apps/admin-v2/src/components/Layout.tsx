import { NavLink } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { LayoutDashboard, Users, Phone, Bell, BarChart3, Heart, Calendar, AlertTriangle, Activity, LogOut } from 'lucide-react';

const tabs = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/seniors', label: 'Seniors', icon: Users },
  { path: '/calls', label: 'Calls', icon: Phone },
  { path: '/reminders', label: 'Reminders', icon: Bell },
  { path: '/call-analyses', label: 'Call Analyses', icon: BarChart3 },
  { path: '/caregivers', label: 'Caregivers', icon: Heart },
  { path: '/daily-context', label: 'Daily Context', icon: Calendar },
  { path: '/post-call-jobs', label: 'Post-Call Jobs', icon: AlertTriangle },
  { path: '/scale-operations', label: 'Scale Ops', icon: Activity },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();

  return (
    <div className="max-w-[1100px] mx-auto p-5">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[200] focus:bg-admin-primary focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:text-sm focus:font-semibold"
      >
        Skip to main content
      </a>
      {/* Header */}
      <header className="bg-admin-primary text-admin-text p-5 mb-5 rounded-xl flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Donna Admin</h1>
          <p className="text-admin-text-light text-sm">Manage seniors, calls, and reminders</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="bg-admin-primary-dark/30 px-3.5 py-2 rounded-lg text-xs font-semibold text-admin-text-light">v3.3</span>
          <button
            onClick={logout}
            className="flex items-center gap-1.5 bg-admin-primary-dark/30 hover:bg-admin-primary-dark/50 text-admin-text text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
          >
            <LogOut size={14} />
            Logout
          </button>
        </div>
      </header>

      {/* Tab Navigation */}
      <nav className="flex gap-1 mb-5 border-b-2 border-admin-border overflow-x-auto">
        {tabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            end={tab.path === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 px-4 py-3 text-[15px] font-medium border-b-2 -mb-[2px] transition-colors whitespace-nowrap',
                isActive
                  ? 'text-admin-primary border-admin-primary'
                  : 'text-admin-text-light border-transparent hover:text-admin-primary'
              )
            }
          >
            <tab.icon size={16} />
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {/* Page Content */}
      <main id="main-content">{children}</main>
    </div>
  );
}
