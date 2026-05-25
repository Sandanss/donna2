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
      medicalNotes: 'Blood pressure medication',
      preferredCallTimes: { schedule: { time: '10:00' }, topicsToAvoid: ['politics'] },
      additionalInfo: 'Likes reminders after breakfast',
    });

    expect(encrypted.familyInfo).toBeNull();
    expect(encrypted).not.toHaveProperty('medicalNotes');
    expect(encrypted.preferredCallTimes).toBeNull();
    expect(encrypted.additionalInfo).toBeNull();
    expect(encrypted.familyInfoEncrypted).toBeTruthy();
    expect(encrypted).not.toHaveProperty('medicalNotesEncrypted');
    expect(encrypted.preferredCallTimesEncrypted).toBeTruthy();
    expect(encrypted.additionalInfoEncrypted).toBeTruthy();

    const decrypted = decryptSeniorPhi(encrypted);
    expect(decrypted.familyInfo).toEqual({ relation: 'mother' });
    expect(decrypted).not.toHaveProperty('medicalNotes');
    expect(decrypted.preferredCallTimes.topicsToAvoid).toEqual(['politics']);
    expect(decrypted.additionalInfo).toBe('Likes reminders after breakfast');
    expect(decrypted).not.toHaveProperty('medicalNotesEncrypted');
  });

  it('moves reminders and notifications out of plaintext fields', () => {
    const reminder = encryptReminderPhi({
      title: 'Call Emma',
      description: 'Ask about the weekend trip',
    });
    expect(reminder.title).toBe(ENCRYPTED_PLACEHOLDER);
    expect(reminder.description).toBeNull();
    expect(decryptReminderPhi(reminder)).toMatchObject({
      title: 'Call Emma',
      description: 'Ask about the weekend trip',
    });

    const notification = encryptNotificationPhi({
      content: 'Donna noticed a missed reminder.',
      metadata: { severity: 'medium' },
    });
    expect(notification.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(notification.metadata).toBeNull();
    expect(decryptNotificationPhi(notification)).toMatchObject({
      content: 'Donna noticed a missed reminder.',
      metadata: { severity: 'medium' },
    });
  });

  it('stores daily context and waitlist payloads as encrypted blobs', () => {
    const daily = encryptDailyContextPhi({
      topicsDiscussed: ['sleep'],
      remindersDelivered: ['Call Emma'],
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
      remindersDelivered: ['Call Emma'],
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
