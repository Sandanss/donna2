# Multi-Senior Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow caregivers to manage multiple seniors from the dashboard — switch between them, add new ones, and see per-senior data.

**Architecture:** Add a senior switcher to the dashboard sidebar and an "Add Loved One" flow that reuses the onboarding form logic. The backend already supports multiple seniors per caregiver via the `caregivers` join table and `/api/onboarding` endpoint, so this is purely frontend work in `apps/consumer/`.

**Tech Stack:** React, TypeScript, Clerk auth, CSS (matching existing Dashboard.css style)

---

### Task 1: Add Senior Switcher to Dashboard Sidebar

**Files:**
- Modify: `apps/consumer/src/pages/Dashboard.tsx`
- Modify: `apps/consumer/src/pages/Dashboard.css`

**Step 1: Add senior switcher UI to the sidebar**

In `Dashboard.tsx`, replace the static `user-profile-mini` section (lines 363-369) with a senior switcher component. Insert it between the nav menu and signout button.

Replace:
```tsx
<div className="user-profile-mini">
  <div className="user-avatar-mini"></div>
  <div className="user-info-mini">
    <h4>{activeSenior?.name || 'Caregiver'}</h4>
    <span>Managing {seniors.length} senior{seniors.length !== 1 ? 's' : ''}</span>
  </div>
</div>
```

With:
```tsx
<div className="senior-switcher">
  <div className="senior-switcher-label">Your Loved Ones</div>
  {seniors.map((senior) => (
    <div
      key={senior.id}
      className={`senior-switcher-item ${activeSenior?.id === senior.id ? 'active' : ''}`}
      onClick={() => handleSwitchSenior(senior)}
    >
      <div className="senior-avatar">{senior.name.charAt(0)}</div>
      <div className="senior-switcher-info">
        <span className="senior-switcher-name">{senior.name}</span>
        <span className="senior-switcher-role">{senior.role}</span>
      </div>
    </div>
  ))}
  <button className="add-senior-btn" onClick={() => setShowAddSenior(true)}>
    <Plus size={16} />
    Add Loved One
  </button>
</div>
```

**Step 2: Add `handleSwitchSenior` function and `showAddSenior` state**

Add new state at the top of the component (after existing state declarations):
```tsx
const [showAddSenior, setShowAddSenior] = useState(false);
```

Add the switch handler (after existing handlers):
```tsx
const handleSwitchSenior = async (senior: Senior) => {
  setActiveSenior(senior);
  try {
    const token = await getToken();
    const [remindersRes, callsRes] = await Promise.all([
      fetch(`${API_URL}/api/seniors/${senior.id}/reminders`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch(`${API_URL}/api/seniors/${senior.id}/calls`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    if (remindersRes.ok) setReminders(await remindersRes.json());
    if (callsRes.ok) setCalls(await callsRes.json());
  } catch (err) {
    console.error('Failed to load senior data:', err);
  }
};
```

**Step 3: Add CSS for the senior switcher**

Append to `Dashboard.css`:
```css
/* Senior Switcher */
.senior-switcher {
  margin-top: auto;
  margin-bottom: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.senior-switcher-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #8b949e;
  padding: 0 16px;
  margin-bottom: 8px;
}

.senior-switcher-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
}

.senior-switcher-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.senior-switcher-item.active {
  background: rgba(74, 93, 79, 0.3);
}

.senior-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--color-sage-green);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.senior-switcher-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.senior-switcher-name {
  font-size: 0.9rem;
  color: white;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.senior-switcher-role {
  font-size: 0.7rem;
  color: #8b949e;
  text-transform: capitalize;
}

.add-senior-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 16px;
  margin-top: 8px;
  background: none;
  border: 1px dashed rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  color: #8b949e;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
}

.add-senior-btn:hover {
  border-color: var(--color-sage-green);
  color: white;
  background: rgba(74, 93, 79, 0.2);
}
```

**Step 4: Verify it renders correctly**

Run: `cd apps/consumer && npm run dev`
Expected: Sidebar shows list of seniors with avatars, active senior highlighted, "Add Loved One" button at bottom.

**Step 5: Commit**

```bash
git add apps/consumer/src/pages/Dashboard.tsx apps/consumer/src/pages/Dashboard.css
git commit -m "feat: add senior switcher to dashboard sidebar"
```

---

### Task 2: Build Add Senior Modal

**Files:**
- Modify: `apps/consumer/src/pages/Dashboard.tsx`
- Modify: `apps/consumer/src/pages/Dashboard.css`

**Step 1: Add the Add Senior modal component inline in Dashboard.tsx**

This is a simplified version of the onboarding form — just the essential fields (name, phone, relation, location, reminders, call schedule). Add this JSX right before the closing `</div>` of `dashboard-container`:

```tsx
{showAddSenior && (
  <div className="modal-overlay" onClick={() => setShowAddSenior(false)}>
    <div className="modal-content add-senior-modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h2>Add a Loved One</h2>
        <button className="modal-close" onClick={() => setShowAddSenior(false)}>
          <X size={20} />
        </button>
      </div>

      {addSeniorStep === 1 && (
        <div className="modal-body">
          <p className="modal-description">Who will Donna be calling?</p>

          <div className="modal-field">
            <label>Name</label>
            <input
              type="text"
              placeholder="e.g. Martha"
              value={newSeniorData.name}
              onChange={(e) => setNewSeniorData({ ...newSeniorData, name: e.target.value })}
              autoFocus
            />
          </div>

          <div className="modal-field">
            <label>Phone Number</label>
            <input
              type="tel"
              placeholder="(555) 123-4567"
              value={newSeniorData.phone}
              onChange={(e) => setNewSeniorData({ ...newSeniorData, phone: e.target.value })}
            />
          </div>

          <div className="modal-field">
            <label>Relationship</label>
            <select
              value={newSeniorData.relation}
              onChange={(e) => setNewSeniorData({ ...newSeniorData, relation: e.target.value })}
            >
              <option>Mother</option>
              <option>Father</option>
              <option>Client</option>
              <option>Other Loved One</option>
            </select>
          </div>

          <div className="modal-field">
            <label>Location</label>
            <div className="modal-location-row">
              <input
                type="text"
                placeholder="City"
                value={newSeniorData.city}
                onChange={(e) => setNewSeniorData({ ...newSeniorData, city: e.target.value })}
              />
              <input
                type="text"
                placeholder="State"
                value={newSeniorData.state}
                onChange={(e) => setNewSeniorData({ ...newSeniorData, state: e.target.value })}
              />
            </div>
          </div>
        </div>
      )}

      {addSeniorStep === 2 && (
        <div className="modal-body">
          <p className="modal-description">Set up reminders and call schedule</p>

          <div className="modal-field">
            <label>Daily Reminders</label>
            {newSeniorData.reminders.map((reminder, index) => (
              <input
                key={index}
                type="text"
                placeholder={index === 0 ? "e.g. Take medication at 9am" : `Reminder ${index + 1}`}
                value={reminder}
                onChange={(e) => {
                  const updated = [...newSeniorData.reminders];
                  updated[index] = e.target.value;
                  setNewSeniorData({ ...newSeniorData, reminders: updated });
                }}
                style={{ marginBottom: '8px' }}
              />
            ))}
            <button className="add-reminder-link" onClick={() => setNewSeniorData({ ...newSeniorData, reminders: [...newSeniorData.reminders, ''] })}>
              <Plus size={14} /> Add another reminder
            </button>
          </div>

          <div className="modal-field">
            <label>Call Days</label>
            <div className="modal-days-row">
              {DAYS_OF_WEEK.map(day => (
                <div
                  key={day}
                  className={`modal-day-toggle ${newSeniorData.callDays.includes(day) ? 'active' : ''}`}
                  onClick={() => {
                    const days = newSeniorData.callDays.includes(day)
                      ? newSeniorData.callDays.filter(d => d !== day)
                      : [...newSeniorData.callDays, day];
                    setNewSeniorData({ ...newSeniorData, callDays: days });
                  }}
                >
                  {day}
                </div>
              ))}
            </div>
          </div>

          <div className="modal-field">
            <label>Call Time</label>
            <input
              type="time"
              value={newSeniorData.callTime}
              onChange={(e) => setNewSeniorData({ ...newSeniorData, callTime: e.target.value })}
              className="time-input"
            />
          </div>
        </div>
      )}

      <div className="modal-footer">
        {addSeniorStep > 1 && (
          <button className="btn-cancel" onClick={() => setAddSeniorStep(addSeniorStep - 1)}>
            <ArrowLeft size={16} /> Back
          </button>
        )}
        <div style={{ flex: 1 }} />
        {addSeniorStep === 1 ? (
          <button
            className="add-btn-primary"
            onClick={() => setAddSeniorStep(2)}
            disabled={!newSeniorData.name || !newSeniorData.phone}
          >
            Next <ArrowRight size={16} />
          </button>
        ) : (
          <button
            className="add-btn-primary"
            onClick={handleAddSenior}
            disabled={isAddingSenior}
          >
            {isAddingSenior ? 'Adding...' : 'Add Loved One'} <Check size={16} />
          </button>
        )}
      </div>
    </div>
  </div>
)}
```

**Step 2: Add state and handler for the Add Senior flow**

Add new state variables:
```tsx
const [addSeniorStep, setAddSeniorStep] = useState(1);
const [isAddingSenior, setIsAddingSenior] = useState(false);
const [newSeniorData, setNewSeniorData] = useState({
  name: '',
  phone: '',
  relation: 'Mother',
  city: '',
  state: '',
  reminders: [''],
  callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  callTime: '10:00',
});
```

Add the `ArrowLeft`, `ArrowRight` imports to the existing lucide-react import line.

Add handler:
```tsx
const handleAddSenior = async () => {
  setIsAddingSenior(true);
  try {
    const token = await getToken();
    const payload = {
      senior: {
        name: newSeniorData.name,
        phone: newSeniorData.phone,
        city: newSeniorData.city,
        state: newSeniorData.state,
        timezone: 'America/New_York',
      },
      relation: newSeniorData.relation,
      interests: [],
      reminders: newSeniorData.reminders.filter(r => r.trim()),
      updateTopics: [],
      callSchedule: {
        days: newSeniorData.callDays,
        time: newSeniorData.callTime,
      },
      familyInfo: {
        relation: newSeniorData.relation,
        interestDetails: {},
      },
    };

    const res = await fetch(`${API_URL}/api/onboarding`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to add senior' }));
      throw new Error(err.error || err.message || 'Failed to add');
    }

    const data = await res.json();
    const newSenior = { ...data.senior, role: newSeniorData.relation };
    setSeniors([...seniors, newSenior]);
    setActiveSenior(newSenior);
    setReminders([]); // New senior has no reminder objects returned from /api/onboarding with ids
    setCalls([]);

    // Fetch reminders that were just created
    const remindersRes = await fetch(`${API_URL}/api/seniors/${data.senior.id}/reminders`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (remindersRes.ok) setReminders(await remindersRes.json());

    // Reset modal state
    setShowAddSenior(false);
    setAddSeniorStep(1);
    setNewSeniorData({
      name: '', phone: '', relation: 'Mother', city: '', state: '',
      reminders: [''], callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], callTime: '10:00',
    });
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Failed to add loved one');
  } finally {
    setIsAddingSenior(false);
  }
};
```

**Step 3: Add modal CSS to Dashboard.css**

```css
/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: white;
  border-radius: 20px;
  width: 90%;
  max-width: 520px;
  max-height: 85vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 24px 0 24px;
}

.modal-header h2 {
  margin: 0;
  font-size: 1.4rem;
}

.modal-close {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}

.modal-close:hover {
  background: #f3f4f6;
  color: #333;
}

.modal-body {
  padding: 20px 24px;
}

.modal-description {
  color: #666;
  margin-bottom: 1.5rem;
}

.modal-field {
  margin-bottom: 1.25rem;
}

.modal-field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  color: #333;
  margin-bottom: 6px;
}

.modal-field input,
.modal-field select {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #ddd;
  border-radius: 10px;
  font-size: 0.95rem;
  box-sizing: border-box;
}

.modal-field input:focus,
.modal-field select:focus {
  outline: none;
  border-color: var(--color-sage-green);
}

.modal-location-row {
  display: flex;
  gap: 10px;
}

.modal-location-row input:first-child {
  flex: 2;
}

.modal-location-row input:last-child {
  flex: 1;
}

.add-reminder-link {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--color-sage-green);
  font-size: 0.85rem;
  cursor: pointer;
  padding: 4px 0;
  font-weight: 500;
}

.add-reminder-link:hover {
  text-decoration: underline;
}

.modal-days-row {
  display: flex;
  gap: 6px;
}

.modal-day-toggle {
  flex: 1;
  padding: 8px 4px;
  text-align: center;
  background: #f3f4f6;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 600;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s;
}

.modal-day-toggle.active {
  background: var(--color-sage-green);
  color: white;
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 24px 24px 24px;
  border-top: 1px solid #f0f0f0;
}

.modal-footer .add-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

**Step 4: Test the flow**

Run: `cd apps/consumer && npm run dev`
Test: Click "Add Loved One" → fill in name/phone → Next → add reminders + schedule → "Add Loved One" → verify new senior appears in sidebar.

**Step 5: Commit**

```bash
git add apps/consumer/src/pages/Dashboard.tsx apps/consumer/src/pages/Dashboard.css
git commit -m "feat: add 'Add Loved One' modal for multi-senior management"
```

---

### Task 3: Fix the No-Senior State to Also Show Add Button

**Files:**
- Modify: `apps/consumer/src/pages/Dashboard.tsx`

**Step 1: Update the no-senior-state to also work when the user has seniors but wants to add more from the dashboard tab**

No change needed for the no-senior state — it already redirects to onboarding. But update the dashboard header to show which senior is selected when multiple exist:

Replace the dashboard header (lines 394-397):
```tsx
<div className="dashboard-header">
  <h1>{getGreeting()}!</h1>
  <p>Here's how things are going with {activeSenior.name}.</p>
</div>
```

With:
```tsx
<div className="dashboard-header">
  <h1>{getGreeting()}!</h1>
  <p>Here's how things are going with <strong>{activeSenior.name}</strong>.</p>
</div>
```

This is a minor enhancement. The main work was in Tasks 1 and 2.

**Step 2: Commit**

```bash
git add apps/consumer/src/pages/Dashboard.tsx
git commit -m "feat: minor dashboard header enhancement for multi-senior context"
```

---

### Task 4: Reset Modal State When Closing

**Files:**
- Modify: `apps/consumer/src/pages/Dashboard.tsx`

**Step 1: Ensure modal resets properly on close**

Create a helper function:
```tsx
const resetAddSeniorModal = () => {
  setShowAddSenior(false);
  setAddSeniorStep(1);
  setNewSeniorData({
    name: '', phone: '', relation: 'Mother', city: '', state: '',
    reminders: [''], callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], callTime: '10:00',
  });
};
```

Replace all `setShowAddSenior(false)` calls in the modal (overlay click and X button) with `resetAddSeniorModal()`.

**Step 2: Commit**

```bash
git add apps/consumer/src/pages/Dashboard.tsx
git commit -m "fix: properly reset add-senior modal state on close"
```
