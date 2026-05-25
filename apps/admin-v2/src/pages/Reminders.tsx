import { useEffect, useState } from 'react';
import { api, type Reminder, type Senior } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useToast } from '@/components/Toast';

const typeIcons: Record<string, string> = {
  custom: '\u{1F4CC}',
  social: '\u{1F4DE}',
};

function getScheduleLabel(r: Reminder): string {
  if (r.isRecurring) {
    return r.cronExpression === '0 * * * *' ? 'Daily' : r.cronExpression || 'Recurring';
  }
  return 'One-time';
}

export default function Reminders() {
  const { showToast } = useToast();

  const [seniors, setSeniors] = useState<Senior[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [seniorId, setSeniorId] = useState('');
  const [type, setType] = useState('custom');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [recurring, setRecurring] = useState('one-time');
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    try {
      const [s, r] = await Promise.all([api.seniors.list(), api.reminders.list()]);
      setSeniors(s);
      setReminders(r);
    } catch (err: any) {
      showToast(err.message || 'Failed to load data', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function resetForm() {
    setSeniorId('');
    setType('custom');
    setTitle('');
    setDescription('');
    setDate('');
    setTime('');
    setRecurring('one-time');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!seniorId || !title || !time) {
      showToast('Please fill in all required fields', 'error');
      return;
    }

    let scheduledTime: string | null = null;
    let isRecurring = false;
    let cronExpression: string | null = null;

    if (recurring === 'daily') {
      isRecurring = true;
      cronExpression = '0 * * * *';
      const today = new Date();
      const [h, m] = time.split(':');
      today.setHours(parseInt(h), parseInt(m), 0, 0);
      scheduledTime = today.toISOString();
    } else if (recurring === 'weekly') {
      isRecurring = true;
      cronExpression = 'weekly';
      const today = new Date();
      const [h, m] = time.split(':');
      today.setHours(parseInt(h), parseInt(m), 0, 0);
      scheduledTime = today.toISOString();
    } else {
      if (date && time) {
        scheduledTime = new Date(`${date}T${time}`).toISOString();
      }
    }

    setSubmitting(true);
    try {
      await api.reminders.create({
        seniorId,
        type,
        title,
        description,
        scheduledTime,
        isRecurring,
        cronExpression,
      });
      showToast('Reminder created successfully');
      resetForm();
      const r = await api.reminders.list();
      setReminders(r);
    } catch (err: any) {
      showToast(err.message || 'Failed to create reminder', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this reminder?')) return;
    try {
      await api.reminders.delete(id);
      showToast('Reminder deleted');
      const r = await api.reminders.list();
      setReminders(r);
    } catch (err: any) {
      showToast(err.message || 'Failed to delete reminder', 'error');
    }
  }

  if (loading) {
    return <p className="text-center py-10 text-admin-text-muted">Loading...</p>;
  }

  return (
    <div>
      {/* Add New Reminder */}
      <div className="bg-white rounded-xl p-5 mb-5 shadow-card">
        <h2 className="text-base font-bold text-admin-text-light border-b-2 border-admin-primary pb-2 mb-4">
          Add New Reminder
        </h2>
        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-3.5">
            <div>
              <label htmlFor="reminder-senior" className="block text-sm font-semibold text-admin-text-light mb-1">Senior *</label>
              <select
                id="reminder-senior"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={seniorId}
                onChange={(e) => setSeniorId(e.target.value)}
                required
              >
                <option value="">Select a senior</option>
                {seniors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="reminder-type" className="block text-sm font-semibold text-admin-text-light mb-1">Type</label>
              <select
                id="reminder-type"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                <option value="custom">Custom</option>
                <option value="social">Social</option>
              </select>
            </div>
            <div>
              <label htmlFor="reminder-title" className="block text-sm font-semibold text-admin-text-light mb-1">Title *</label>
              <input
                id="reminder-title"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Call Emma after lunch"
                required
              />
            </div>
            <div>
              <label htmlFor="reminder-description" className="block text-sm font-semibold text-admin-text-light mb-1">Description</label>
              <textarea
                id="reminder-description"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={1}
                placeholder="Optional details"
              />
            </div>
            <div>
              <label htmlFor="reminder-date" className="block text-sm font-semibold text-admin-text-light mb-1">Date</label>
              <input
                id="reminder-date"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <p className="text-[11px] text-admin-text-muted mt-0.5">Required for one-time reminders</p>
            </div>
            <div>
              <label htmlFor="reminder-time" className="block text-sm font-semibold text-admin-text-light mb-1">Time *</label>
              <input
                id="reminder-time"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </div>
          </div>

          <fieldset className="mt-3.5">
            <legend className="block text-sm font-semibold text-admin-text-light mb-1">Recurring</legend>
            <div className="flex gap-4">
              {[
                { value: 'one-time', label: 'One-time' },
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
              ].map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 text-sm text-admin-text cursor-pointer">
                  <input
                    type="radio"
                    name="recurring"
                    value={opt.value}
                    checked={recurring === opt.value}
                    onChange={(e) => setRecurring(e.target.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-4">
            <button
              type="submit"
              disabled={submitting}
              className="bg-admin-accent hover:bg-admin-accent-hover text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:-translate-y-0.5 hover:shadow-card-hover transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
            >
              {submitting ? 'Adding...' : 'Add Reminder'}
            </button>
          </div>
        </form>
      </div>

      {/* Active Reminders */}
      <div className="bg-white rounded-xl p-5 mb-5 shadow-card">
        <h2 className="text-base font-bold text-admin-text-light border-b-2 border-admin-primary pb-2 mb-4">
          Active Reminders
        </h2>
        {reminders.length === 0 ? (
          <p className="text-center py-10 text-admin-text-muted">No reminders yet</p>
        ) : (
          reminders.map((r) => (
            <div
              key={r.id}
              className="bg-gray-50 border border-gray-100 rounded-xl p-3.5 mb-3 flex justify-between items-start"
            >
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span>{typeIcons[r.type] || '\u{1F4CC}'}</span>
                  <span className="text-[15px] font-semibold">{r.title}</span>
                </div>
                <p className="text-sm text-admin-text-light mb-1">{r.seniorName}</p>
                <div className="flex flex-wrap gap-1.5 mb-1">
                  <span className="inline-block bg-admin-tag text-admin-primary px-2 py-0.5 rounded-full text-[11px]">
                    {getScheduleLabel(r)}
                  </span>
                  <span className="inline-block bg-admin-tag text-admin-primary px-2 py-0.5 rounded-full text-[11px]">
                    {new Date(r.scheduledTime).toLocaleString()}
                  </span>
                </div>
                {r.lastDeliveredAt && (
                  <p className="text-xs text-admin-text-muted">
                    Last delivered: {formatDate(r.lastDeliveredAt)}
                  </p>
                )}
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  className="bg-admin-danger text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-red-600 transition-colors"
                  onClick={() => handleDelete(r.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
