import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { caregivers, notificationPreferences, reminders, seniors } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter, authLimiter } from '../middleware/rate-limit.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { validateBody } from '../middleware/validate.js';
import { onboardingPhoneAvailabilitySchema, onboardingSchema } from '../validators/schemas.js';
import { cronExpressionFromTime, resolveTimezoneFromProfile, wallTimeTodayToUtcDate } from '../lib/timezone.js';
import { sendError } from '../lib/http-response.js';
import { decryptReminderPhi, decryptSeniorPhi, encryptReminderPhi, encryptSeniorPhi } from '../lib/phi.js';
import { resolveCallArchitectureConfig } from '../services/call-queue.js';
import { syncSeniorCallSchedulesFromPreferredCallTimes } from '../services/call-schedules.js';
import { routeError } from './helpers.js';
import { createLogger } from '../lib/logger.js';

const router = Router();
const log = createLogger('Onboarding');

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // Accept 10-digit US or 11-digit with leading 1 — reject anything else
  // to prevent international numbers silently colliding with domestic ones.
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
  return digits.slice(-10); // fallback for legacy data compat
}

function phonesMatch(a, b) {
  const first = normalizePhone(a);
  const second = normalizePhone(b);
  return first.length === 10 && first === second;
}

function blocksCaregiverPhoneReuse({ seniorPhone, caregiverPhone, relation }) {
  return Boolean(caregiverPhone) && relation !== 'Myself' && phonesMatch(seniorPhone, caregiverPhone);
}

function shouldSyncCallSchedules() {
  const config = resolveCallArchitectureConfig();
  return process.env.CALL_QUEUE_DUAL_WRITE_SCHEDULES === 'true' || config.shadowMaterialize;
}

router.post('/api/onboarding/validate-phone', requireAuth, validateBody(onboardingPhoneAvailabilitySchema), authLimiter, async (req, res) => {
  try {
    if (!req.auth.userId || req.auth.userId === 'cofounder') {
      return sendError(res, 400, { error: 'Clerk authentication required for onboarding' });
    }

    const phone = normalizePhone(req.body.phone);
    if (phone.length !== 10) {
      return sendError(res, 400, { error: 'Please enter a valid 10-digit US phone number' });
    }
    if (blocksCaregiverPhoneReuse({
      seniorPhone: phone,
      caregiverPhone: req.body.caregiverPhone,
      relation: req.body.relation,
    })) {
      return sendError(res, 400, {
        error: 'Senior phone can match caregiver phone only when relation is Myself',
        code: 'senior_phone_matches_caregiver',
      });
    }

    const [existing] = await db.select({ id: seniors.id })
      .from(seniors)
      .where(eq(seniors.phone, phone))
      .limit(1);

    if (existing) {
      return sendError(res, 409, {
        error: 'This phone number is already registered for another senior',
        code: 'senior_phone_taken',
      });
    }

    res.json({ available: true });
  } catch (error) {
    routeError(res, error, 'POST /api/onboarding/validate-phone');
  }
});

// Complete onboarding - creates senior + links to Clerk user + creates reminders.
// Caregiver identity is Clerk-derived; clients do not need to submit email.
router.post('/api/onboarding', requireAuth, validateBody(onboardingSchema), idempotencyMiddleware, writeLimiter, async (req, res) => {
  let clerkUserId;

  try {
    const { senior: seniorData, relation, interests, additionalInfo, reminders: reminderStrings, topicsToAvoid, callSchedule, caregiverPhone } = req.body;
    const caregiverData = req.body.caregiverProfile || req.body.caregiver || {};

    // Get Clerk user ID from auth
    clerkUserId = req.auth.userId;
    if (!clerkUserId || clerkUserId === 'cofounder') {
      return sendError(res, 400, { error: 'Clerk authentication required for onboarding' });
    }

    // Get familyInfo from request body (contains interestDetails from frontend)
    const { familyInfo: clientFamilyInfo } = req.body;

    const topicsToAvoidText = Array.isArray(topicsToAvoid)
      ? topicsToAvoid.filter(Boolean).join('; ')
      : topicsToAvoid || '';

    if (blocksCaregiverPhoneReuse({
      seniorPhone: seniorData.phone,
      caregiverPhone,
      relation,
    })) {
      return sendError(res, 400, {
        error: 'Senior phone can match caregiver phone only when relation is Myself',
        code: 'senior_phone_matches_caregiver',
      });
    }

    // Prepare senior data with structured info in JSON fields
    const seniorCreateData = {
      name: seniorData.name,
      phone: seniorData.phone,
      timezone: seniorData.timezone || 'America/New_York',
      city: seniorData.city,
      state: seniorData.state,
      zipCode: seniorData.zipCode,
      additionalInfo,
      // Store interests as flat array (topics) - frontend sends strings
      interests: interests || [],
      // Store interest details and other consumer data in familyInfo
      familyInfo: {
        relation,
        donnaLanguage: clientFamilyInfo?.donnaLanguage || 'en',
        interestDetails: clientFamilyInfo?.interestDetails || {},
        topicsToAvoid: topicsToAvoidText || undefined,
      },
      // Store call schedule and topics to avoid in preferredCallTimes
      preferredCallTimes: {
        schedule: callSchedule,
        topicsToAvoid: topicsToAvoid || [],
      },
    };

    const { senior, createdReminders } = await db.transaction(async (tx) => {
      const caregiverCreateData = {
        phone: caregiverData.phone || caregiverPhone,
        city: caregiverData.city,
        state: caregiverData.state,
        zipCode: caregiverData.zipCode,
        timezone: resolveTimezoneFromProfile(caregiverData),
      };

      const [senior] = await tx.insert(seniors).values({
        ...encryptSeniorPhi(seniorCreateData),
        phone: normalizePhone(seniorCreateData.phone),
        timezone: resolveTimezoneFromProfile(seniorCreateData),
      }).returning();

      const [caregiver] = await tx.insert(caregivers).values({
        clerkUserId,
        seniorId: senior.id,
        role: 'caregiver',
        ...caregiverCreateData,
      }).returning();

      await tx.insert(notificationPreferences).values({
        caregiverId: caregiver.id,
        timezone: caregiverCreateData.timezone,
      });

      // Create reminders from strings at the senior's local wall-clock time.
      const reminderTime = callSchedule?.time || '10:00';
      const reminderScheduledTime = wallTimeTodayToUtcDate(reminderTime, senior.timezone) || new Date();
      const reminderCronExpression = cronExpressionFromTime(reminderTime);

      const createdReminders = [];
      if (reminderStrings && reminderStrings.length > 0) {
        for (const reminderTitle of reminderStrings) {
          if (reminderTitle.trim()) {
            const [reminder] = await tx.insert(reminders).values({
              ...encryptReminderPhi({
                seniorId: senior.id,
                type: 'custom',
                title: reminderTitle.trim(),
              }),
              isRecurring: true,
              scheduledTime: reminderScheduledTime,
              cronExpression: reminderCronExpression,
            }).returning();
            createdReminders.push(decryptReminderPhi(reminder));
          }
        }
      }

      return { senior: decryptSeniorPhi(senior), createdReminders };
    });

    log.info('Completed onboarding', {
      userId: clerkUserId,
      seniorId: senior.id,
      remindersCreated: createdReminders.length,
    });

    if (shouldSyncCallSchedules()) {
      try {
        await syncSeniorCallSchedulesFromPreferredCallTimes(senior);
      } catch (error) {
        log.warn('Onboarding call schedule dual-write failed; legacy schedule remains source of truth', {
          seniorId: senior.id,
          error: error.message,
        });
      }
    }

    res.json({
      senior,
      reminders: createdReminders,
    });
  } catch (error) {
    const pgCode = error.code || error.cause?.code;
    const pgConstraint = error.constraint || error.cause?.constraint;
    if (pgCode === '23505' && pgConstraint?.includes('phone')) {
      return sendError(res, 409, { error: 'This phone number is already registered for another senior' });
    }

    routeError(res, error, 'POST /api/onboarding');
  }
});

export default router;
