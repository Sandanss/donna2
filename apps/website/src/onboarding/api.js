import { apiUrl } from '../lib/config.js';

// Map full day names / indices to short day names expected by backend
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Map frontend relationship values to backend enum: Mother | Father | Client | Other Loved One
function mapRelation(relationship) {
  if (relationship === 'Mother') return 'Mother';
  if (relationship === 'Father') return 'Father';
  if (relationship === 'Client') return 'Client';
  return 'Other Loved One';
}

export async function submitOnboarding(data, clerkToken) {
  // Transform interests from { gardening: { selected: true, detail: '...' } }
  // to flat topic strings for the backend, and interestDetails for familyInfo
  const interestEntries = Object.entries(data.interests || {}).filter(([, v]) => v.selected);
  const interests = interestEntries.map(([key]) => key);
  const interestDetails = {};
  for (const [key, v] of interestEntries) {
    if (v.detail) interestDetails[key] = v.detail;
  }

  // Reminders: array of title strings
  const reminders = (data.reminders || []).map((r) => r.title).filter(Boolean);

  // Build additionalInfo from topics to avoid / additional topics
  const additionalParts = [];
  if (data.additionalTopics) additionalParts.push(`Additional topics: ${data.additionalTopics}`);
  if (data.topicsToAvoid) additionalParts.push(`Topics to avoid: ${data.topicsToAvoid}`);
  const additionalInfo = additionalParts.length > 0 ? additionalParts.join('. ') : undefined;

  // Call schedule: pick the first call entry's schedule for the backend
  // Backend expects { days: ['Mon', 'Tue'], time: 'HH:MM' }
  let callSchedule;
  const firstCall = (data.calls || [])[0];
  if (firstCall) {
    let days;
    if (firstCall.frequency === 'daily' || !firstCall.days || firstCall.days.length === 0) {
      days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    } else {
      // days might be indices (0-6) or full names
      days = firstCall.days.map((d) => {
        if (typeof d === 'number') return DAY_SHORT[d];
        if (DAY_SHORT.includes(d)) return d;
        // Full day name → short
        const idx = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(d);
        return idx >= 0 ? DAY_SHORT[idx] : d;
      });
    }
    callSchedule = {
      days,
      time: firstCall.time || '10:00',
    };
  }

  // Format phone: ensure it's just digits with country code
  const seniorPhone = formatPhone(data.lovedOnePhone, data.lovedOneCountryCode);

  const payload = {
    senior: {
      name: data.lovedOneName,
      phone: seniorPhone,
      city: data.city || undefined,
      state: data.state || undefined,
      zipCode: data.zipcode || undefined,
    },
    relation: mapRelation(data.relationship),
    interests,
    additionalInfo,
    reminders,
    callSchedule,
    familyInfo: {
      relation: data.relationship,
      interestDetails,
    },
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (clerkToken) {
    headers['Authorization'] = `Bearer ${clerkToken}`;
  }

  const res = await fetch(apiUrl('/api/onboarding'), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) {
      throw new Error(body.message || body.error || 'An account with this phone number already exists.');
    }
    if (res.status === 422) {
      throw new Error(body.message || body.error || 'Please check your information and try again.');
    }
    throw new Error(body.message || body.error || 'Something went wrong. Please try again.');
  }

  return res.json();
}

function formatPhone(phone, countryCode) {
  if (!phone) return '';
  // Strip non-digits
  const digits = phone.replace(/\D/g, '');
  // If already has country code prefix, return as-is
  if (digits.length > 10) return `+${digits}`;
  // Add country code
  const code = (countryCode || '+1').replace(/\D/g, '');
  return `+${code}${digits}`;
}
