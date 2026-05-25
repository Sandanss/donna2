import { PlusIcon, TrashIcon } from './icons';

export default function Step5_Reminders({ data, update }) {
  const reminders = data.reminders || [];

  // Start with one empty reminder by default
  if (reminders.length === 0) {
    update({ reminders: [{ title: '', description: '' }] });
    return null;
  }

  const addReminder = () => {
    update({ reminders: [...reminders, { title: '', description: '' }] });
  };

  const updateReminder = (index, field, value) => {
    const updated = reminders.map((r, i) =>
      i === index ? { ...r, [field]: value } : r
    );
    update({ reminders: updated });
  };

  const removeReminder = (index) => {
    const filtered = reminders.filter((_, i) => i !== index);
    update({ reminders: filtered.length > 0 ? filtered : [{ title: '', description: '' }] });
  };

  return (
    <div>
      <h1 className="ob-step-title">Reminders</h1>
      <p className="ob-step-subtitle">
        Donna can begin calls by giving your loved one any reminders you suggest here. You can always edit these later.
      </p>

      <div className="ob-reminder-list">
        {reminders.map((reminder, i) => (
          <div key={i} className="ob-reminder-card">
            {reminders.length > 1 && (
              <button
                className="ob-reminder-card__remove"
                onClick={() => removeReminder(i)}
                aria-label="Remove reminder"
                type="button"
              >
                <TrashIcon size={16} />
              </button>
            )}
            <div className="ob-form-group" style={{ marginBottom: 12 }}>
              <label className="ob-label">Reminder Title</label>
              <input
                className="ob-input"
                type="text"
                value={reminder.title}
                onChange={(e) => updateReminder(i, 'title', e.target.value)}
                placeholder="e.g. Call Emma after lunch"
              />
            </div>
            <div className="ob-form-group" style={{ marginBottom: 0 }}>
              <label className="ob-label">Reminder Details</label>
              <textarea
                className="ob-textarea"
                value={reminder.description}
                onChange={(e) => updateReminder(i, 'description', e.target.value)}
                placeholder="e.g. Emma usually answers after 1 PM. Ask how her trip went."
                rows={3}
              />
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="ob-add-btn" onClick={addReminder}>
        <PlusIcon size={18} />
        Add Another Reminder
      </button>

      <div className="ob-reminder-tip">
        <em>Keep reminders focused on everyday routines and personal preferences.</em>
      </div>
    </div>
  );
}
