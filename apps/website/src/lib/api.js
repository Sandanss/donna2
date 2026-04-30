import { useAuth } from '@clerk/clerk-react';

const API_URL = 'https://donna-api-production-2450.up.railway.app';

async function fetchWithAuth(path, options = {}, token) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(error || `HTTP ${res.status}`);
  }

  return res.json();
}

export function useApi() {
  const { getToken } = useAuth();

  async function get(path) {
    const token = await getToken();
    return fetchWithAuth(path, { method: 'GET' }, token);
  }

  async function post(path, body) {
    const token = await getToken();
    return fetchWithAuth(path, { method: 'POST', body: JSON.stringify(body) }, token);
  }

  async function patch(path, body) {
    const token = await getToken();
    return fetchWithAuth(path, { method: 'PATCH', body: JSON.stringify(body) }, token);
  }

  async function del(path) {
    const token = await getToken();
    return fetchWithAuth(path, { method: 'DELETE' }, token);
  }

  return {
    // Caregiver
    getMe: () => get('/api/caregivers/me'),

    // Seniors
    getSeniors: () => get('/api/seniors'),
    updateSenior: (id, data) => patch(`/api/seniors/${id}`, data),

    // Schedule
    getSchedule: (seniorId) => get(`/api/seniors/${seniorId}/schedule`),
    updateSchedule: (seniorId, data) => patch(`/api/seniors/${seniorId}/schedule`, data),

    // Reminders
    getReminders: () => get('/api/reminders'),
    createReminder: (data) => post('/api/reminders', data),
    updateReminder: (id, data) => patch(`/api/reminders/${id}`, data),
    deleteReminder: (id) => del(`/api/reminders/${id}`),

    // Conversations / Calls
    getConversations: (seniorId) => get(`/api/seniors/${seniorId}/conversations`),
    getCalls: () => get('/api/calls'),
    initiateCall: (data) => post('/api/call', data),

    // Notifications
    getNotificationPrefs: () => get('/api/notifications/preferences'),
    updateNotificationPrefs: (data) => patch('/api/notifications/preferences', data),

    // Account
    deleteAccount: () => del('/api/caregivers/me/account'),
  };
}
