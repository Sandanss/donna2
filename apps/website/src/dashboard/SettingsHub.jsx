import { useState } from 'react';
import { useClerk, useUser } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import { useDashboard } from './DashboardContext';
import SettingsRow from './components/SettingsRow';

export default function SettingsHub() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const navigate = useNavigate();
  const { senior, api } = useDashboard();
  const seniorName = senior?.name || senior?.seniorName || 'Loved One';
  const seniorInitial = seniorName.charAt(0).toUpperCase();
  const caregiverInitial = (user?.firstName || 'Y').charAt(0).toUpperCase();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      await api.deleteAccount();
      await signOut();
      navigate('/');
    } catch (err) {
      alert('Failed to delete account: ' + err.message);
    } finally {
      setDeleting(false);
      setShowDeleteModal(false);
    }
  };

  return (
    <div>
      <div className="db-page__header">
        <h1 className="db-page__title">Settings</h1>
      </div>

      {/* Profiles */}
      <div className="db-section__title" style={{ marginBottom: 4 }}>Profiles</div>
      <div className="db-card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
        <SettingsRow
          to="/dashboard/settings/loved-one"
          label={`${seniorName}'s Profile`}
          iconBg="var(--color-sage-dark)"
          icon={<span style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{seniorInitial}</span>}
        />
        <SettingsRow
          to="/dashboard/settings/account"
          label="Your Account"
          iconBg="var(--color-sage-dark)"
          icon={<span style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{caregiverInitial}</span>}
        />
      </div>

      {/* Preferences */}
      <div className="db-section__title" style={{ marginBottom: 4 }}>Preferences</div>
      <div className="db-card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
        <SettingsRow
          to="/dashboard/settings/notifications"
          label="Notification Preferences"
          iconBg="var(--color-sage-dark)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
          }
        />
        <SettingsRow
          to="/dashboard/settings/help"
          label="Help Center"
          iconBg="var(--color-sage-dark)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          }
        />
      </div>

      {/* Account */}
      <div className="db-section__title" style={{ marginBottom: 4 }}>Account</div>
      <div className="db-card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
        <button className="db-srow" onClick={handleSignOut} style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer' }}>
          <div className="db-srow__icon" style={{ background: 'var(--color-danger-light, #FEE2E2)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </div>
          <span className="db-srow__label">Sign Out</span>
        </button>
        <button className="db-srow" onClick={() => setShowDeleteModal(true)} style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer' }}>
          <div className="db-srow__icon" style={{ background: 'var(--color-danger-light, #FEE2E2)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </div>
          <span className="db-srow__label">Delete Account</span>
        </button>
      </div>

      {/* Delete Account Confirmation Modal */}
      {showDeleteModal && (
        <div className="db-modal-overlay" onClick={() => !deleting && setShowDeleteModal(false)}>
          <div className="db-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="db-modal__title">Delete Account</h2>
            <p style={{ fontSize: 15, color: 'var(--fg-2)', lineHeight: 1.6, marginBottom: 8 }}>
              Are you sure you want to delete your account? This action is permanent and cannot be undone.
            </p>
            <p style={{ fontSize: 14, color: 'var(--color-danger)', lineHeight: 1.5 }}>
              All of your data will be permanently removed, including your loved one&apos;s profile, call history, reminders, and conversation memories.
            </p>
            <div className="db-modal__actions">
              <button
                className="db-btn db-btn--ghost"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="db-btn"
                onClick={handleDeleteAccount}
                disabled={deleting}
                style={{
                  background: 'var(--color-danger)',
                  color: 'white',
                }}
              >
                {deleting ? 'Deleting...' : 'Yes, Delete My Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
