import { db } from '../db/client.js';
import { notificationPreferences, notifications, caregivers, seniors } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { Resend } from 'resend';
import { Expo } from 'expo-server-sdk';
import { clerkClient } from '@clerk/express';
import { createLogger } from '../lib/logger.js';
import { decryptNotificationPhi, encryptNotificationPhi } from '../lib/phi.js';
import { sanitizeUntrustedMessageText } from '../lib/sanitize.js';

const log = createLogger('Notifications');

// Lazy-init Resend
let resendClient = null;
const getResendClient = () => {
  if (!resendClient && process.env.RESEND_API_KEY) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
};

// Lazy-init Expo SDK. Works without an access token for unaccepted-receipt
// flow; an EXPO_ACCESS_TOKEN can be provided later for stricter rate limits.
let expoClient = null;
const getExpoClient = () => {
  if (!expoClient) {
    expoClient = new Expo({
      accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
    });
  }
  return expoClient;
};

const FROM_EMAIL = process.env.NOTIFICATION_FROM_EMAIL || 'Donna <notifications@donna.care>';
const MAX_NOTIFICATION_CONTENT_CHARS = 1200;

export function decryptNotificationRow(row) {
  return decryptNotificationPhi(row);
}

export function sanitizeNotificationContent(content, options = {}) {
  return sanitizeUntrustedMessageText(content, {
    maxLen: MAX_NOTIFICATION_CONTENT_CHARS,
    replacement: 'Donna has a new update available.',
    ...options,
  });
}

function sanitizeNotificationMetadata(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (typeof value === 'string') {
    return sanitizeUntrustedMessageText(value, { maxLen: 1000, replacement: '' });
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeNotificationMetadata(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeNotificationMetadata(nested, depth + 1)])
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Clerk contact info cache (clerkUserId → { email, phone, firstName })
// Expires after 10 minutes to balance freshness with API rate limits.
// ---------------------------------------------------------------------------
const contactCache = new Map();
const CONTACT_CACHE_TTL = 10 * 60 * 1000;

async function getClerkContact(clerkUserId) {
  const cached = contactCache.get(clerkUserId);
  if (cached && Date.now() - cached.ts < CONTACT_CACHE_TTL) {
    return cached.data;
  }

  try {
    const user = await clerkClient.users.getUser(clerkUserId);
    const data = {
      email: user.emailAddresses?.[0]?.emailAddress || null,
      phone: user.phoneNumbers?.[0]?.phoneNumber || null,
      firstName: user.firstName || null,
    };
    contactCache.set(clerkUserId, { data, ts: Date.now() });
    return data;
  } catch (err) {
    log.warn('Failed to fetch Clerk user', { clerkUserId, error: err.message });
    return { email: null, phone: null, firstName: null };
  }
}

// ---------------------------------------------------------------------------
// Map event_type (snake_case from trigger API) → pref key (camelCase in DB)
// ---------------------------------------------------------------------------
const EVENT_TO_PREF = {
  call_completed: 'callCompleted',
  reminder_missed: 'reminderMissed',
  weekly_summary: 'weeklySummary',
};

// ---------------------------------------------------------------------------
// Quiet hours check
// ---------------------------------------------------------------------------
function isInQuietHours(prefs) {
  if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;

  const tz = prefs.timezone || 'America/New_York';
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value);
  const minute = parseInt(parts.find(p => p.type === 'minute').value);
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = prefs.quietHoursStart.split(':').map(Number);
  const [endH, endM] = prefs.quietHoursEnd.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight quiet hours (e.g., 22:00 → 07:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export const notificationService = {

  // -------------------------------------------------------------------------
  // Preferences CRUD
  // -------------------------------------------------------------------------

  async getPreferences(caregiverId) {
    const [prefs] = await db.select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.caregiverId, caregiverId))
      .limit(1);

    // Return defaults if none set
    if (!prefs) {
      return {
        caregiverId,
        callCompleted: true,
        concernDetected: false,
        reminderMissed: true,
        weeklySummary: true,
        callSummaries: true,
        pauseCalls: false,
        smsEnabled: false,
        emailEnabled: true,
        quietHoursStart: null,
        quietHoursEnd: null,
        timezone: 'America/New_York',
        weeklyReportDay: 1,
        weeklyReportTime: '09:00',
      };
    }

    return { ...prefs, smsEnabled: false };
  },

  async upsertPreferences(caregiverId, data) {
    const normalizedData = { ...data, concernDetected: false, smsEnabled: false };

    // Try update first
    const [existing] = await db.select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.caregiverId, caregiverId))
      .limit(1);

    if (existing) {
      const [updated] = await db.update(notificationPreferences)
        .set({ ...normalizedData, updatedAt: new Date() })
        .where(eq(notificationPreferences.caregiverId, caregiverId))
        .returning();
      return { ...updated, smsEnabled: false };
    }

    const [created] = await db.insert(notificationPreferences)
      .values({ caregiverId, ...normalizedData })
      .returning();
    return { ...created, smsEnabled: false };
  },

  // -------------------------------------------------------------------------
  // Event handlers (called from /api/notifications/trigger)
  // -------------------------------------------------------------------------

  async onCallCompleted(seniorId, data) {
    const caregiverList = await this._getCaregiversForSenior(seniorId);
    const senior = await this._getSenior(seniorId);
    const seniorName = senior?.name || 'your loved one';

    // Prefer the AI-generated caregiver message. The payload key is still
    // caregiver_sms for legacy schema compatibility, even though SMS is inactive.
    const content = sanitizeNotificationContent(
      data.caregiver_sms
      || `Donna just finished a call with ${seniorName}. ${data.summary || 'Call completed successfully.'}`
    );

    for (const cg of caregiverList) {
      await this._sendIfAllowed(
        cg.id,
        cg.clerkUserId,
        seniorId,
        'call_completed',
        content,
        data,
        { expoPushToken: cg.expoPushToken },
      );
    }
  },

  async onReminderMissed(seniorId, data) {
    const caregiverList = await this._getCaregiversForSenior(seniorId);
    const senior = await this._getSenior(seniorId);
    const seniorName = senior?.name || 'your loved one';

    const reminder = sanitizeNotificationContent(
      data.reminderTitle || 'a reminder',
      { maxLen: 160, replacement: 'a reminder' }
    );
    const content = sanitizeNotificationContent(
      `${seniorName} was not reached for ${reminder}. Donna tried but could not complete the reminder call.`
    );

    for (const cg of caregiverList) {
      await this._sendIfAllowed(
        cg.id,
        cg.clerkUserId,
        seniorId,
        'reminder_missed',
        content,
        data,
        { expoPushToken: cg.expoPushToken },
      );
    }
  },

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async _getCaregiversForSenior(seniorId) {
    return db.select({
      id: caregivers.id,
      clerkUserId: caregivers.clerkUserId,
      expoPushToken: caregivers.expoPushToken,
    })
      .from(caregivers)
      .where(eq(caregivers.seniorId, seniorId));
  },

  async _getSenior(seniorId) {
    const [senior] = await db.select({ name: seniors.name, phone: seniors.phone })
      .from(seniors)
      .where(eq(seniors.id, seniorId))
      .limit(1);
    return senior || null;
  },

  async _sendIfAllowed(caregiverId, clerkUserId, seniorId, eventType, content, metadata, opts = {}) {
    const prefs = await this.getPreferences(caregiverId);

    // Check if this event type is enabled (map snake_case → camelCase)
    const prefKey = EVENT_TO_PREF[eventType];
    if (prefKey && prefs[prefKey] === false) {
      log.info(`${eventType} disabled for caregiver ${caregiverId}, skipping`);
      return;
    }

    // Check quiet hours (unless bypassed for urgent events)
    if (!opts.bypassQuietHours && isInQuietHours(prefs)) {
      log.info(`Quiet hours active for caregiver ${caregiverId}, skipping ${eventType}`);
      return;
    }

    // Resolve contact info from Clerk
    const contact = await getClerkContact(clerkUserId);

    // SMS is intentionally inactive for now; keep the preference field only for
    // backward-compatible API responses and legacy rows.
    if (prefs.emailEnabled) {
      await this._sendEmail(caregiverId, seniorId, eventType, content, metadata, contact.email);
    }

    // Push notification doubles as a cache-invalidation signal for the mobile
    // app — for example, a voice-created reminder needs the reminder/schedule
    // tabs to refresh. Same event-type gate as email so the user is not woken
    // up by events they have disabled.
    if (opts.expoPushToken) {
      await this._sendPush(caregiverId, seniorId, eventType, content, metadata, opts.expoPushToken);
    }
  },

  async _sendPush(caregiverId, seniorId, eventType, content, metadata, pushToken) {
    if (!Expo.isExpoPushToken(pushToken)) {
      log.warn('Invalid Expo push token, skipping', { caregiverId });
      return;
    }

    const safeContent = sanitizeNotificationContent(content);
    const titles = {
      call_completed: 'Donna call summary',
      reminder_missed: 'Missed reminder',
      weekly_summary: 'Weekly summary',
    };

    try {
      const expo = getExpoClient();
      const tickets = await expo.sendPushNotificationsAsync([{
        to: pushToken,
        sound: 'default',
        title: titles[eventType] || 'Donna',
        body: safeContent,
        data: {
          type: eventType,
          seniorId,
          // Include only safe ids — the mobile listener uses these to
          // invalidate the right query keys, not to display PHI.
        },
        priority: 'high',
      }]);

      const ticket = tickets[0];
      if (ticket?.status === 'error') {
        log.warn('Expo push ticket error', {
          caregiverId,
          eventType,
          message: ticket.message,
          details: ticket.details,
        });
        // DeviceNotRegistered means the token is dead — clear it so we stop
        // trying to push to it.
        if (ticket.details?.error === 'DeviceNotRegistered') {
          await db.update(caregivers)
            .set({ expoPushToken: null })
            .where(eq(caregivers.id, caregiverId));
        }
      } else {
        log.info('Push sent', { caregiverId, eventType });
      }
    } catch (err) {
      log.error('Push delivery failed', { caregiverId, error: err.message });
    }
  },

  async _sendEmail(caregiverId, seniorId, eventType, content, metadata, email) {
    const safeContent = sanitizeNotificationContent(content);
    const safeMetadata = sanitizeNotificationMetadata(metadata);

    // Always record the notification
    await db.insert(notifications).values({
      ...encryptNotificationPhi({
        caregiverId,
        seniorId,
        eventType,
        channel: 'email',
        content: safeContent,
        metadata: safeMetadata,
      }),
    });

    const resend = getResendClient();
    if (!resend) {
      log.warn('Resend not configured, email recorded but not delivered');
      return;
    }

    if (!email) {
      log.warn('No email for caregiver, email recorded but not delivered', { caregiverId });
      return;
    }

    // Build subject from event type
    const subjects = {
      call_completed: 'Donna call summary',
      reminder_missed: 'Missed reminder',
      weekly_summary: 'Weekly summary from Donna',
    };

    try {
      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: subjects[eventType] || 'Notification from Donna',
        text: safeContent,
      });

      if (error) {
        log.error('Email send failed', { caregiverId, error: error.message });
      } else {
        log.info('Email sent', { caregiverId, eventType });
      }
    } catch (err) {
      log.error('Email delivery failed', { caregiverId, error: err.message });
    }
  },

  async sendWeeklyReport(caregiverId, seniorId) {
    try {
      const { weeklyReportService } = await import('./weekly-report.js');
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

      const report = await weeklyReportService.buildReport(seniorId, startDate, endDate);
      const html = weeklyReportService.buildEmailHTML(report);

      // Get caregiver's clerkUserId for contact lookup
      const [cg] = await db.select({ clerkUserId: caregivers.clerkUserId })
        .from(caregivers)
        .where(eq(caregivers.id, caregiverId))
        .limit(1);
      if (!cg?.clerkUserId) return;

      const contact = await getClerkContact(cg.clerkUserId);
      const resend = getResendClient();

      if (resend && contact?.email) {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: contact.email,
          subject: `Donna Weekly Report: This week with ${report.senior.name}`,
          html,
        });
        log.info('Weekly report sent', { caregiverId, seniorId });
      }

      await db.insert(notifications).values({
        ...encryptNotificationPhi({
          caregiverId,
          seniorId,
          eventType: 'weekly_summary',
          channel: 'email',
          content: `Weekly report for ${report.senior.name}`,
          metadata: { period: report.period, calls: report.calls },
        }),
      });
    } catch (error) {
      log.error('Weekly report failed', { error: error.message, caregiverId, seniorId });
    }
  },
};
