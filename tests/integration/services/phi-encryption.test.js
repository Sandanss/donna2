import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_PLACEHOLDER,
  decryptDailyContextPhi,
  decryptNotificationPhi,
  decryptReminderPhi,
  decryptSeniorPhi,
  encryptDailyContextPhi,
  encryptNotificationPhi,
  encryptReminderPhi,
  encryptSeniorPhi,
  encryptWaitlistPhi,
} from '../../../lib/phi.js';

describe('PHI encryption helpers', () => {
  it('moves senior profile PHI into encrypted companion fields', () => {
    const encrypted = encryptSeniorPhi({
      name: 'Margaret',
      familyInfo: { relation: 'mother' },
      profileNotes: 'Prefers short morning check-ins',
      preferredCallTimes: { schedule: { time: '10:00' }, topicsToAvoid: ['politics'] },
      additionalInfo: 'Likes reminders after breakfast',
    });

    expect(encrypted.familyInfo).toBeNull();
    expect(encrypted.profileNotes).toBeNull();
    expect(encrypted.preferredCallTimes).toBeNull();
    expect(encrypted.additionalInfo).toBeNull();
    expect(encrypted.familyInfoEncrypted).toBeTruthy();
    expect(encrypted.profileNotesEncrypted).toBeTruthy();
    expect(encrypted.preferredCallTimesEncrypted).toBeTruthy();
    expect(encrypted.additionalInfoEncrypted).toBeTruthy();

    const decrypted = decryptSeniorPhi(encrypted);
    expect(decrypted.familyInfo).toEqual({ relation: 'mother' });
    expect(decrypted.profileNotes).toBe('Prefers short morning check-ins');
    expect(decrypted.preferredCallTimes.topicsToAvoid).toEqual(['politics']);
    expect(decrypted.additionalInfo).toBe('Likes reminders after breakfast');
    expect(decrypted).not.toHaveProperty('profileNotesEncrypted');
  });

  it('moves reminders and notifications out of plaintext fields', () => {
    const reminder = encryptReminderPhi({
      title: 'Water porch plants',
      description: 'After dinner',
    });
    expect(reminder.title).toBe(ENCRYPTED_PLACEHOLDER);
    expect(reminder.description).toBeNull();
    expect(decryptReminderPhi(reminder)).toMatchObject({
      title: 'Water porch plants',
      description: 'After dinner',
    });

    const notification = encryptNotificationPhi({
      content: 'Donna noticed a missed porch-plant reminder.',
      metadata: { severity: 'medium' },
    });
    expect(notification.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(notification.metadata).toBeNull();
    expect(decryptNotificationPhi(notification)).toMatchObject({
      content: 'Donna noticed a missed porch-plant reminder.',
      metadata: { severity: 'medium' },
    });
  });

  it('stores daily context and waitlist payloads as encrypted blobs', () => {
    const daily = encryptDailyContextPhi({
      topicsDiscussed: ['sleep'],
      remindersDelivered: ['Water porch plants'],
      adviceGiven: ['Drink water'],
      keyMoments: [{ type: 'mood', value: 'tired' }],
      summary: 'Senior sounded tired.',
    });
    expect(daily.topicsDiscussed).toBeNull();
    expect(daily.remindersDelivered).toBeNull();
    expect(daily.adviceGiven).toBeNull();
    expect(daily.keyMoments).toBeNull();
    expect(daily.summary).toBeNull();
    expect(decryptDailyContextPhi(daily)).toMatchObject({
      topicsDiscussed: ['sleep'],
      remindersDelivered: ['Water porch plants'],
      adviceGiven: ['Drink water'],
      keyMoments: [{ type: 'mood', value: 'tired' }],
      summary: 'Senior sounded tired.',
    });

    const waitlist = encryptWaitlistPhi({
      name: 'Ana',
      email: 'ana@example.com',
      phone: '5551234567',
      whoFor: 'mom',
      thoughts: 'Needs companionship',
    });
    expect(waitlist.name).toBe(ENCRYPTED_PLACEHOLDER);
    expect(waitlist.email).toBe(ENCRYPTED_PLACEHOLDER);
    expect(waitlist.phone).toBeNull();
    expect(waitlist.payloadEncrypted).toBeTruthy();
  });
});
