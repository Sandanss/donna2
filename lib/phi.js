import { decrypt, decryptJson, encrypt, encryptJson } from './encryption.js';

export const ENCRYPTED_PLACEHOLDER = '[encrypted]';

function hasOwn(data, key) {
  return Object.prototype.hasOwnProperty.call(data || {}, key);
}

function encryptedText(row, plaintextKey, encryptedKey) {
  if (row?.[encryptedKey]) return decrypt(row[encryptedKey]);
  return row?.[plaintextKey] ?? null;
}

function encryptedJson(row, plaintextKey, encryptedKey) {
  if (row?.[encryptedKey]) return decryptJson(row[encryptedKey]);
  return row?.[plaintextKey] ?? null;
}

function stripKeys(row, keys) {
  for (const key of keys) {
    delete row[key];
  }
  return row;
}

export function encryptSeniorPhi(data = {}) {
  const values = { ...data };

  if (hasOwn(data, 'familyInfo')) {
    values.familyInfoEncrypted = encryptJson(data.familyInfo);
    values.familyInfo = null;
  }
  if (hasOwn(data, 'profileNotes')) {
    values.profileNotesEncrypted = encrypt(data.profileNotes);
    values.profileNotes = null;
  }
  delete values.medicalNotes;
  delete values.medicalNotesEncrypted;
  if (hasOwn(data, 'preferredCallTimes')) {
    values.preferredCallTimesEncrypted = encryptJson(data.preferredCallTimes);
    values.preferredCallTimes = null;
  }
  if (hasOwn(data, 'additionalInfo')) {
    values.additionalInfoEncrypted = encrypt(data.additionalInfo);
    values.additionalInfo = null;
  }
  if (hasOwn(data, 'callContextSnapshot')) {
    values.callContextSnapshotEncrypted = encryptJson(data.callContextSnapshot);
    values.callContextSnapshot = null;
  }

  return values;
}

export function decryptSeniorPhi(row) {
  if (!row) return row;
  const senior = {
    ...row,
    familyInfo: encryptedJson(row, 'familyInfo', 'familyInfoEncrypted'),
    profileNotes: encryptedText(row, 'profileNotes', 'profileNotesEncrypted'),
    preferredCallTimes: encryptedJson(row, 'preferredCallTimes', 'preferredCallTimesEncrypted'),
    additionalInfo: encryptedText(row, 'additionalInfo', 'additionalInfoEncrypted'),
    callContextSnapshot: encryptedJson(row, 'callContextSnapshot', 'callContextSnapshotEncrypted'),
  };
  return stripKeys(senior, [
    'familyInfoEncrypted',
    'profileNotesEncrypted',
    'medicalNotes',
    'medicalNotesEncrypted',
    'preferredCallTimesEncrypted',
    'additionalInfoEncrypted',
    'callContextSnapshotEncrypted',
  ]);
}

export function encryptReminderPhi(data = {}) {
  const values = { ...data };
  if (hasOwn(data, 'title')) {
    values.titleEncrypted = encrypt(data.title);
    values.title = ENCRYPTED_PLACEHOLDER;
  }
  if (hasOwn(data, 'description')) {
    values.descriptionEncrypted = encrypt(data.description);
    values.description = null;
  }
  return values;
}

export function decryptReminderPhi(row) {
  if (!row) return row;
  const reminder = {
    ...row,
    title: encryptedText(row, 'title', 'titleEncrypted'),
    description: encryptedText(row, 'description', 'descriptionEncrypted'),
  };
  return stripKeys(reminder, ['titleEncrypted', 'descriptionEncrypted']);
}

export function encryptReminderDeliveryPhi(data = {}) {
  const values = { ...data };
  if (hasOwn(data, 'userResponse')) {
    values.userResponseEncrypted = encrypt(data.userResponse);
    values.userResponse = null;
  }
  return values;
}

export function decryptReminderDeliveryPhi(row) {
  if (!row) return row;
  const delivery = {
    ...row,
    userResponse: encryptedText(row, 'userResponse', 'userResponseEncrypted'),
  };
  return stripKeys(delivery, ['userResponseEncrypted']);
}

export function dailyContextPayload(row) {
  return {
    topicsDiscussed: row?.topicsDiscussed || [],
    remindersDelivered: row?.remindersDelivered || [],
    adviceGiven: row?.adviceGiven || [],
    keyMoments: row?.keyMoments || [],
    summary: row?.summary || null,
  };
}

export function encryptDailyContextPhi(data = {}) {
  return {
    contextEncrypted: encryptJson(dailyContextPayload(data)),
    topicsDiscussed: null,
    remindersDelivered: null,
    adviceGiven: null,
    keyMoments: null,
    summary: null,
  };
}

export function decryptDailyContextPhi(row) {
  if (!row) return row;
  const payload = row.contextEncrypted ? decryptJson(row.contextEncrypted) : dailyContextPayload(row);
  const dailyContext = {
    ...row,
    topicsDiscussed: payload?.topicsDiscussed || [],
    remindersDelivered: payload?.remindersDelivered || [],
    adviceGiven: payload?.adviceGiven || [],
    keyMoments: payload?.keyMoments || [],
    summary: payload?.summary || null,
  };
  return stripKeys(dailyContext, ['contextEncrypted']);
}

export function encryptNotificationPhi(data = {}) {
  const values = { ...data };
  if (hasOwn(data, 'content')) {
    values.contentEncrypted = encrypt(data.content);
    values.content = ENCRYPTED_PLACEHOLDER;
  }
  if (hasOwn(data, 'metadata')) {
    values.metadataEncrypted = encryptJson(data.metadata);
    values.metadata = null;
  }
  return values;
}

export function decryptNotificationPhi(row) {
  if (!row) return row;
  const notification = {
    ...row,
    content: encryptedText(row, 'content', 'contentEncrypted'),
    metadata: encryptedJson(row, 'metadata', 'metadataEncrypted'),
  };
  return stripKeys(notification, ['contentEncrypted', 'metadataEncrypted']);
}

export function encryptWaitlistPhi(data = {}) {
  return {
    name: ENCRYPTED_PLACEHOLDER,
    email: ENCRYPTED_PLACEHOLDER,
    phone: null,
    whoFor: null,
    thoughts: null,
    payloadEncrypted: encryptJson({
      name: data.name || null,
      email: data.email || null,
      phone: data.phone || null,
      whoFor: data.whoFor || null,
      thoughts: data.thoughts || null,
    }),
  };
}
