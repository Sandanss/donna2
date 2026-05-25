import { useState, useEffect } from 'react';
import { api, type Senior, type Memory } from '@/lib/api';

import { useToast } from '@/components/Toast';
import Modal from '@/components/Modal';

const MEMORY_TYPES = ['fact', 'preference', 'event', 'relationship'] as const;

export default function Seniors() {
  const { showToast } = useToast();

  // List state
  const [seniors, setSeniors] = useState<(Senior & { memories?: Memory[] })[]>([]);
  const [loading, setLoading] = useState(true);

  // Add form state
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState('');
  const [interests, setInterests] = useState('');
  const [profileNotes, setProfileNotes] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit modal state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editSenior, setEditSenior] = useState<Senior | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editLocation, setEditLocation] = useState('');
  const [editInterests, setEditInterests] = useState('');
  const [editProfileNotes, setEditProfileNotes] = useState('');
  const [editMemories, setEditMemories] = useState<Memory[]>([]);
  const [newMemoryType, setNewMemoryType] = useState<string>('fact');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [saving, setSaving] = useState(false);

  async function loadSeniors() {
    try {
      const list = await api.seniors.list();
      const withMemories = await Promise.all(
        list.map(async (s) => {
          try {
            const memories = await api.seniors.getMemories(s.id);
            return { ...s, memories: memories.slice(0, 5) };
          } catch {
            return { ...s, memories: [] };
          }
        })
      );
      setSeniors(withMemories);
    } catch (e) {
      console.error('Failed to load seniors', e);
      showToast('Failed to load seniors', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSeniors();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) return;
    setAdding(true);
    try {
      await api.seniors.create({
        name: name.trim(),
        phone: phone.trim(),
        interests: interests ? interests.split(',').map((s) => s.trim()).filter(Boolean) : [],
        familyInfo: { location: location.trim() },
        profileNotes: profileNotes.trim(),
      });
      showToast('Senior added successfully');
      setName('');
      setPhone('');
      setLocation('');
      setInterests('');
      setProfileNotes('');
      await loadSeniors();
    } catch (e: any) {
      showToast(e.message || 'Failed to add senior', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(senior: Senior) {
    if (!confirm(`Are you sure you want to remove ${senior.name}?`)) return;
    try {
      await api.seniors.delete(senior.id);
      showToast('Senior removed');
      await loadSeniors();
    } catch (e: any) {
      showToast(e.message || 'Failed to remove senior', 'error');
    }
  }

  async function handleCall(senior: Senior) {
    if (!confirm(`Call ${senior.name} at ${senior.phone}?`)) return;
    try {
      await api.calls.initiate(senior.id);
      showToast('Call initiated');
    } catch (e: any) {
      showToast(e.message || 'Failed to initiate call', 'error');
    }
  }

  function openEditModal(senior: Senior & { memories?: Memory[] }) {
    setEditSenior(senior);
    setEditName(senior.name);
    setEditPhone(senior.phone);
    setEditLocation(senior.familyInfo?.location || '');
    setEditInterests(senior.interests?.join(', ') || '');
    setEditProfileNotes(senior.profileNotes || '');
    setEditMemories(senior.memories || []);
    setNewMemoryType('fact');
    setNewMemoryContent('');
    setEditModalOpen(true);
  }

  async function handleEditSave() {
    if (!editSenior) return;
    setSaving(true);
    try {
      await api.seniors.update(editSenior.id, {
        name: editName.trim(),
        phone: editPhone.trim(),
        interests: editInterests ? editInterests.split(',').map((s) => s.trim()).filter(Boolean) : [],
        familyInfo: { location: editLocation.trim() },
        profileNotes: editProfileNotes.trim(),
      });
      showToast('Senior updated');
      setEditModalOpen(false);
      await loadSeniors();
    } catch (e: any) {
      showToast(e.message || 'Failed to update senior', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleAddMemory() {
    if (!editSenior || !newMemoryContent.trim()) return;
    try {
      await api.seniors.addMemory(editSenior.id, {
        type: newMemoryType,
        content: newMemoryContent.trim(),
        importance: 70,
      });
      showToast('Memory added');
      setNewMemoryContent('');
      const memories = await api.seniors.getMemories(editSenior.id);
      setEditMemories(memories);
    } catch (e: any) {
      showToast(e.message || 'Failed to add memory', 'error');
    }
  }

  if (loading) {
    return <p className="text-center py-10 text-admin-text-muted">Loading seniors...</p>;
  }

  return (
    <div>
      {/* Add Senior Form */}
      <div className="bg-white rounded-xl p-5 mb-5 shadow-card">
        <h2 className="text-base font-bold text-admin-text-light border-b-2 border-admin-primary pb-2 mb-4">
          Add New Senior
        </h2>
        <form onSubmit={handleAdd}>
          <div className="grid grid-cols-2 gap-3.5">
            <div>
              <label htmlFor="senior-name" className="block text-sm font-semibold text-admin-text-light mb-1">Name</label>
              <input
                id="senior-name"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                required
              />
            </div>
            <div>
              <label htmlFor="senior-phone" className="block text-sm font-semibold text-admin-text-light mb-1">Phone</label>
              <input
                id="senior-phone"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1234567890"
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3.5 mt-3.5">
            <div>
              <label htmlFor="senior-location" className="block text-sm font-semibold text-admin-text-light mb-1">Location</label>
              <input
                id="senior-location"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, State"
              />
            </div>
            <div>
              <label htmlFor="senior-interests" className="block text-sm font-semibold text-admin-text-light mb-1">Interests (comma-separated)</label>
              <input
                id="senior-interests"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={interests}
                onChange={(e) => setInterests(e.target.value)}
                placeholder="gardening, crosswords, jazz"
              />
            </div>
          </div>
          <div className="mt-3.5">
            <label htmlFor="senior-profile-notes" className="block text-sm font-semibold text-admin-text-light mb-1">Profile Notes</label>
            <textarea
              id="senior-profile-notes"
              className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
              rows={2}
              value={profileNotes}
              onChange={(e) => setProfileNotes(e.target.value)}
              placeholder="Conversation preferences, routines, and family context..."
            />
          </div>
          <button
            type="submit"
            disabled={adding}
            className="mt-4 bg-admin-accent hover:bg-admin-accent-hover text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:-translate-y-0.5 hover:shadow-card-hover transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
          >
            {adding ? 'Adding...' : 'Add Senior'}
          </button>
        </form>
      </div>

      {/* Seniors List */}
      <div className="bg-white rounded-xl p-5 mb-5 shadow-card">
        <h2 className="text-base font-bold text-admin-text-light border-b-2 border-admin-primary pb-2 mb-4">
          Seniors ({seniors.length})
        </h2>
        {seniors.length ? (
          seniors.map((s) => (
            <div key={s.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3.5 mb-3 flex justify-between items-start">
              <div>
                <h3 className="text-[15px] font-semibold">{s.name}</h3>
                <p className="text-xs text-admin-text-muted">{s.phone} {s.familyInfo?.location ? `- ${s.familyInfo.location}` : ''}</p>
                {s.interests?.length > 0 && (
                  <div className="mt-1.5">
                    {s.interests.map((interest) => (
                      <span key={interest} className="inline-block bg-admin-tag text-admin-primary px-2 py-0.5 rounded-full text-[11px] mr-1">
                        {interest}
                      </span>
                    ))}
                  </div>
                )}
                {s.memories && s.memories.length > 0 && (
                  <div className="mt-1.5 text-xs text-admin-text-muted">
                    {s.memories.length} {s.memories.length === 1 ? 'memory' : 'memories'}
                  </div>
                )}
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => handleCall(s)}
                  className="bg-admin-accent hover:bg-admin-accent-hover text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:-translate-y-0.5 hover:shadow-card-hover transition-all"
                >
                  Call
                </button>
                <button
                  onClick={() => openEditModal(s)}
                  className="bg-gray-200 text-admin-text px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-gray-300 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(s)}
                  className="bg-admin-danger text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-red-600 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="text-center py-10 text-admin-text-muted">No seniors yet</p>
        )}
      </div>

      {/* Edit Modal */}
      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title={`Edit ${editSenior?.name || 'Senior'}`} maxWidth="700px">
        <div>
          <div className="grid grid-cols-2 gap-3.5">
            <div>
              <label htmlFor="edit-senior-name" className="block text-sm font-semibold text-admin-text-light mb-1">Name</label>
              <input
                id="edit-senior-name"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="edit-senior-phone" className="block text-sm font-semibold text-admin-text-light mb-1">Phone</label>
              <input
                id="edit-senior-phone"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={editPhone}
                onChange={(e) => setEditPhone(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3.5 mt-3.5">
            <div>
              <label htmlFor="edit-senior-location" className="block text-sm font-semibold text-admin-text-light mb-1">Location</label>
              <input
                id="edit-senior-location"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={editLocation}
                onChange={(e) => setEditLocation(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="edit-senior-interests" className="block text-sm font-semibold text-admin-text-light mb-1">Interests (comma-separated)</label>
              <input
                id="edit-senior-interests"
                className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                value={editInterests}
                onChange={(e) => setEditInterests(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-3.5">
            <label htmlFor="edit-senior-profile-notes" className="block text-sm font-semibold text-admin-text-light mb-1">Profile Notes</label>
            <textarea
              id="edit-senior-profile-notes"
              className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
              rows={2}
              value={editProfileNotes}
              onChange={(e) => setEditProfileNotes(e.target.value)}
            />
          </div>
          <button
            onClick={handleEditSave}
            disabled={saving}
            className="mt-4 bg-admin-accent hover:bg-admin-accent-hover text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:-translate-y-0.5 hover:shadow-card-hover transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>

          {/* Memories Section */}
          <div className="mt-6 pt-4 border-t border-admin-border">
            <h3 className="text-sm font-bold text-admin-text-light mb-3">Memories</h3>
            {editMemories.length > 0 ? (
              <div className="mb-4 max-h-48 overflow-y-auto">
                {editMemories.map((m) => (
                  <div key={m.id} className="bg-gray-50 border border-gray-100 rounded-lg p-2.5 mb-2">
                    <span className="inline-block bg-admin-tag text-admin-primary px-2 py-0.5 rounded-full text-[11px] mr-1.5">
                      {m.type}
                    </span>
                    <span className="text-sm text-admin-text">{m.content}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-admin-text-muted mb-4">No memories yet</p>
            )}

            {/* Add Memory */}
            <div className="flex gap-2 items-end">
              <div className="shrink-0">
                <label htmlFor="memory-type" className="block text-sm font-semibold text-admin-text-light mb-1">Type</label>
                <select
                  id="memory-type"
                  className="px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                  value={newMemoryType}
                  onChange={(e) => setNewMemoryType(e.target.value)}
                >
                  {MEMORY_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label htmlFor="memory-content" className="block text-sm font-semibold text-admin-text-light mb-1">Content</label>
                <input
                  id="memory-content"
                  className="w-full px-3 py-2.5 border border-admin-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-admin-primary focus:border-admin-primary transition-colors"
                  value={newMemoryContent}
                  onChange={(e) => setNewMemoryContent(e.target.value)}
                  placeholder="Enter memory content..."
                />
              </div>
              <button
                onClick={handleAddMemory}
                disabled={!newMemoryContent.trim()}
                className="shrink-0 bg-admin-accent hover:bg-admin-accent-hover text-white px-3 py-2.5 rounded-lg text-xs font-semibold hover:-translate-y-0.5 hover:shadow-card-hover transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
              >
                Add Memory
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
