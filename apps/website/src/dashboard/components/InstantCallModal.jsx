import { useState } from 'react';

export default function InstantCallModal({ senior, api, onClose }) {
  const [calling, setCalling] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [contextNotes, setContextNotes] = useState('');

  const handleCall = async () => {
    setCalling(true);
    setError(null);
    try {
      const trimmed = contextNotes.trim();
      await api.initiateCall({ seniorId: senior.id, ...(trimmed && { contextNotes: trimmed }) });
      setSuccess(true);
    } catch (err) {
      setError(err.message || 'Failed to initiate call');
    } finally {
      setCalling(false);
    }
  };

  const seniorName = senior?.name || senior?.seniorName || 'Loved One';

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="db-modal__title">
          {success ? 'Call Initiated!' : `Call ${seniorName}`}
        </h2>

        {success ? (
          <div>
            <p style={{ color: 'var(--fg-2)', lineHeight: 1.6, marginBottom: 24 }}>
              Donna is now calling {seniorName}. The call will begin shortly.
            </p>
            <div className="db-modal__actions">
              <button className="db-btn db-btn--primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--fg-2)', lineHeight: 1.6, marginBottom: 16 }}>
              Donna will call {seniorName} right now for a friendly check-in conversation.
            </p>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 13, color: 'var(--fg-2)', marginBottom: 6 }}>
                Add any additional context
              </label>
              <textarea
                value={contextNotes}
                onChange={(e) => setContextNotes(e.target.value)}
                placeholder="e.g., Let her know I'm coming to pick her up at 5pm"
                maxLength={1000}
                rows={3}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-2)',
                  color: 'var(--fg-1)',
                  fontSize: 14,
                  lineHeight: 1.5,
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
            </div>

            {error && (
              <div style={{
                color: 'var(--color-danger)',
                fontSize: 14,
                marginBottom: 16,
                padding: 12,
                background: 'var(--color-rose-bg)',
                borderRadius: 'var(--radius-md)',
              }}>
                {error}
              </div>
            )}

            <div className="db-modal__actions">
              <button className="db-btn db-btn--ghost" onClick={onClose} disabled={calling}>
                Cancel
              </button>
              <button className="db-btn db-btn--primary" onClick={handleCall} disabled={calling}>
                {calling ? 'Calling...' : 'Call Now'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
