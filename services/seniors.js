import { db } from '../db/client.js';
import { seniors, conversations, memories, reminders, reminderDeliveries, caregivers, callAnalyses, dailyCallContext, notificationPreferences, notifications, dataDeletionLogs } from '../db/schema.js';
import { eq, sql, inArray } from 'drizzle-orm';
import { createLogger } from '../lib/logger.js';
import { maskName, maskPhone } from '../lib/sanitize.js';
import { resolveTimezoneFromProfile } from '../lib/timezone.js';
import { decryptSeniorPhi, encryptSeniorPhi } from '../lib/phi.js';
import { resolveCallArchitectureConfig } from './call-queue.js';
import { syncSeniorCallSchedulesFromPreferredCallTimes } from './call-schedules.js';

const log = createLogger('Senior');

function shouldSyncCallSchedules() {
  const config = resolveCallArchitectureConfig();
  return process.env.CALL_QUEUE_DUAL_WRITE_SCHEDULES === 'true' || config.shadowMaterialize;
}

async function syncCallSchedulesIfEnabled(senior) {
  if (!senior?.id || !shouldSyncCallSchedules()) return;
  try {
    await syncSeniorCallSchedulesFromPreferredCallTimes(senior);
  } catch (error) {
    log.warn('Call schedule dual-write failed; legacy schedule remains source of truth', {
      seniorId: senior.id,
      error: error.message,
    });
  }
}

async function assertNoActiveSeniorLegalHold(tx, seniorId) {
  const result = await tx.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM legal_holds lh
    WHERE lh.released_at IS NULL
      AND (
        (lh.resource_type = 'senior' AND lh.resource_id = ${seniorId})
        OR EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.senior_id = ${seniorId}
            AND lh.resource_type = 'conversation'
            AND lh.resource_id = c.id::text
        )
        OR EXISTS (
          SELECT 1 FROM memories m
          WHERE m.senior_id = ${seniorId}
            AND lh.resource_type = 'memory'
            AND lh.resource_id = m.id::text
        )
        OR EXISTS (
          SELECT 1 FROM reminders r
          WHERE r.senior_id = ${seniorId}
            AND lh.resource_type = 'reminder'
            AND lh.resource_id = r.id::text
        )
        OR EXISTS (
          SELECT 1 FROM reminder_deliveries rd
          JOIN reminders r ON r.id = rd.reminder_id
          WHERE r.senior_id = ${seniorId}
            AND lh.resource_type = 'reminder_delivery'
            AND lh.resource_id = rd.id::text
        )
        OR EXISTS (
          SELECT 1 FROM call_analyses ca
          WHERE ca.senior_id = ${seniorId}
            AND lh.resource_type = 'call_analysis'
            AND lh.resource_id = ca.id::text
        )
        OR EXISTS (
          SELECT 1 FROM daily_call_context dcc
          WHERE dcc.senior_id = ${seniorId}
            AND lh.resource_type = 'daily_call_context'
            AND lh.resource_id = dcc.id::text
        )
        OR EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.senior_id = ${seniorId}
            AND lh.resource_type = 'notification'
            AND lh.resource_id = n.id::text
        )
        OR EXISTS (
          SELECT 1 FROM senior_call_schedules scs
          WHERE scs.senior_id = ${seniorId}
            AND lh.resource_type = 'senior_call_schedule'
            AND lh.resource_id = scs.id::text
        )
        OR EXISTS (
          SELECT 1 FROM call_queue cq
          WHERE cq.senior_id = ${seniorId}
            AND lh.resource_type = 'call_queue'
            AND lh.resource_id = cq.id::text
        )
        OR EXISTS (
          SELECT 1 FROM call_attempts cat
          WHERE cat.senior_id = ${seniorId}
            AND lh.resource_type = 'call_attempt'
            AND lh.resource_id = cat.id::text
        )
        OR EXISTS (
          SELECT 1 FROM post_call_jobs pcj
          WHERE (
              pcj.senior_id = ${seniorId}
              OR pcj.conversation_id IN (
                SELECT c.id FROM conversations c WHERE c.senior_id = ${seniorId}
              )
            )
            AND lh.resource_type = 'post_call_job'
            AND lh.resource_id = pcj.id::text
        )
        OR EXISTS (
          SELECT 1 FROM outbound_call_guards ocg
          WHERE ocg.senior_id = ${seniorId}
            AND lh.resource_type = 'outbound_call_guard'
            AND lh.resource_id = ocg.id::text
        )
        OR EXISTS (
          SELECT 1 FROM scheduler_shadow_comparisons ssc
          WHERE ssc.senior_id = ${seniorId}
            AND lh.resource_type = 'scheduler_shadow_comparison'
            AND lh.resource_id = ssc.id::text
        )
        OR EXISTS (
          SELECT 1 FROM caregiver_notes cn
          WHERE cn.senior_id = ${seniorId}
            AND lh.resource_type = 'caregiver_note'
            AND lh.resource_id = cn.id::text
        )
      )
  `);

  const count = result.rows?.[0]?.count || 0;
  if (count > 0) {
    const err = new Error('Data deletion is blocked by an active legal hold');
    err.status = 423;
    throw err;
  }
}

export const seniorService = {
  // Find senior by phone number
  async findByPhone(phone) {
    // Normalize phone - keep last 10 digits
    const normalized = phone.replace(/\D/g, '').slice(-10);

    const [senior] = await db.select().from(seniors)
      .where(eq(seniors.phone, normalized));

    return senior ? decryptSeniorPhi(senior) : null;
  },

  // Create a new senior
  async create(data) {
    try {
      const [senior] = await db.insert(seniors).values({
        ...encryptSeniorPhi(data),
        phone: data.phone.replace(/\D/g, '').slice(-10),
        timezone: resolveTimezoneFromProfile(data),
      }).returning();

      log.info('Created senior', { name: maskName(senior.name), phone: maskPhone(senior.phone) });
      const decrypted = decryptSeniorPhi(senior);
      await syncCallSchedulesIfEnabled(decrypted);
      return decrypted;
    } catch (error) {
      if (error.code === '23505' && error.constraint?.includes('phone')) {
        const err = new Error('This phone number is already registered for another senior');
        err.status = 409;
        throw err;
      }
      throw error;
    }
  },

  // Update a senior
  async update(id, data) {
    try {
      const updateData = { ...encryptSeniorPhi(data), updatedAt: new Date() };

      if (data.phone) {
        updateData.phone = data.phone.replace(/\D/g, '').slice(-10);
      }

      if (
        data.timezone !== undefined ||
        data.city !== undefined ||
        data.state !== undefined ||
        data.zipCode !== undefined
      ) {
        const [existing] = await db.select({
          timezone: seniors.timezone,
          city: seniors.city,
          state: seniors.state,
          zipCode: seniors.zipCode,
        }).from(seniors).where(eq(seniors.id, id)).limit(1);

        updateData.timezone = resolveTimezoneFromProfile({
          ...(existing || {}),
          ...data,
        });
      }

      const [senior] = await db.update(seniors)
        .set(updateData)
        .where(eq(seniors.id, id))
        .returning();

      const decrypted = senior ? decryptSeniorPhi(senior) : null;
      await syncCallSchedulesIfEnabled(decrypted);
      return decrypted;
    } catch (error) {
      if (error.code === '23505' && error.constraint?.includes('phone')) {
        const err = new Error('This phone number is already registered for another senior');
        err.status = 409;
        throw err;
      }
      throw error;
    }
  },

  // List all active seniors
  async list() {
    const rows = await db.select().from(seniors)
      .where(eq(seniors.isActive, true));
    return rows.map(decryptSeniorPhi);
  },

  // Get senior by ID
  async getById(id) {
    const [senior] = await db.select().from(seniors)
      .where(eq(seniors.id, id));
    return senior ? decryptSeniorPhi(senior) : null;
  },

  // Deactivate (soft delete) a senior
  async delete(id) {
    const [senior] = await db.update(seniors)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(seniors.id, id))
      .returning();
    return senior ? decryptSeniorPhi(senior) : null;
  },

  // Hard-delete a senior and ALL associated data
  async hardDelete(id, deletedBy, reason = 'user_request') {
    const counts = {};

    // Use a transaction for atomicity
    await db.transaction(async (tx) => {
      await assertNoActiveSeniorLegalHold(tx, id);

      // 1. Count records per table for audit log
      const [npCount] = await tx.select({ count: sql`COUNT(*)::int` })
        .from(notificationPreferences)
        .where(inArray(notificationPreferences.caregiverId,
          tx.select({ id: caregivers.id }).from(caregivers).where(eq(caregivers.seniorId, id))
        ));
      counts.notification_preferences = npCount?.count || 0;

      // Count notifications via BOTH FK paths: senior_id and caregiver_id
      const notifResult = await tx.execute(sql`
        SELECT COUNT(*)::int AS count FROM notifications
        WHERE senior_id = ${id}
           OR caregiver_id IN (SELECT id FROM caregivers WHERE senior_id = ${id})
      `);
      counts.notifications = notifResult.rows?.[0]?.count || 0;

      const [cgCount] = await tx.select({ count: sql`COUNT(*)::int` })
        .from(caregivers).where(eq(caregivers.seniorId, id));
      counts.caregivers = cgCount?.count || 0;

      const [rdCount] = await tx.select({ count: sql`COUNT(*)::int` })
        .from(reminderDeliveries)
        .where(inArray(reminderDeliveries.reminderId,
          tx.select({ id: reminders.id }).from(reminders).where(eq(reminders.seniorId, id))
        ));
      counts.reminder_deliveries = rdCount?.count || 0;

      const [remCount] = await tx.select({ count: sql`COUNT(*)::int` })
        .from(reminders).where(eq(reminders.seniorId, id));
      counts.reminders = remCount?.count || 0;

      const [dccCount] = await tx.select({ count: sql`COUNT(*)::int` })
        .from(dailyCallContext).where(eq(dailyCallContext.seniorId, id));
      counts.daily_call_context = dccCount?.count || 0;

      const [caCount] = await tx.select({ count: sql`COUNT(*)::int` })
        .from(callAnalyses).where(eq(callAnalyses.seniorId, id));
      counts.call_analyses = caCount?.count || 0;

      const [memCount] = await tx.select({ count: sql`COUNT(*)::int` })
        .from(memories).where(eq(memories.seniorId, id));
      counts.memories = memCount?.count || 0;

      const [convCount] = await tx.select({ count: sql`COUNT(*)::int` })
        .from(conversations).where(eq(conversations.seniorId, id));
      counts.conversations = convCount?.count || 0;

      // call_metrics and caregiver_notes not in Drizzle schema — use raw SQL
      const [cmCount] = (await tx.execute(sql`SELECT COUNT(*)::int AS count FROM call_metrics WHERE senior_id = ${id}`)).rows;
      counts.call_metrics = cmCount?.count || 0;

      const [cnCount] = (await tx.execute(sql`SELECT COUNT(*)::int AS count FROM caregiver_notes WHERE senior_id = ${id}`)).rows;
      counts.caregiver_notes = cnCount?.count || 0;

      const [idemCount] = (await tx.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM idempotency_keys
        WHERE user_id = ${deletedBy}
          AND created_at >= NOW() - INTERVAL '1 day'
      `)).rows;
      counts.idempotency_keys = idemCount?.count || 0;

      const [scheduleCount] = (await tx.execute(sql`SELECT COUNT(*)::int AS count FROM senior_call_schedules WHERE senior_id = ${id}`)).rows;
      counts.senior_call_schedules = scheduleCount?.count || 0;

      const [queueCount] = (await tx.execute(sql`SELECT COUNT(*)::int AS count FROM call_queue WHERE senior_id = ${id}`)).rows;
      counts.call_queue = queueCount?.count || 0;

      const [attemptCount] = (await tx.execute(sql`SELECT COUNT(*)::int AS count FROM call_attempts WHERE senior_id = ${id}`)).rows;
      counts.call_attempts = attemptCount?.count || 0;

      const [jobCount] = (await tx.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM post_call_jobs
        WHERE senior_id = ${id}
           OR conversation_id IN (SELECT id FROM conversations WHERE senior_id = ${id})
      `)).rows;
      counts.post_call_jobs = jobCount?.count || 0;

      const [guardCount] = (await tx.execute(sql`SELECT COUNT(*)::int AS count FROM outbound_call_guards WHERE senior_id = ${id}`)).rows;
      counts.outbound_call_guards = guardCount?.count || 0;

      const [shadowCount] = (await tx.execute(sql`SELECT COUNT(*)::int AS count FROM scheduler_shadow_comparisons WHERE senior_id = ${id}`)).rows;
      counts.scheduler_shadow_comparisons = shadowCount?.count || 0;

      // 2. DELETE in dependency order (deepest children first)
      await tx.execute(sql`
        DELETE FROM post_call_jobs
        WHERE senior_id = ${id}
           OR conversation_id IN (SELECT id FROM conversations WHERE senior_id = ${id})
      `);
      await tx.execute(sql`DELETE FROM scheduler_shadow_comparisons WHERE senior_id = ${id}`);
      await tx.execute(sql`DELETE FROM outbound_call_guards WHERE senior_id = ${id}`);
      await tx.execute(sql`DELETE FROM call_attempts WHERE senior_id = ${id}`);
      await tx.execute(sql`DELETE FROM call_queue WHERE senior_id = ${id}`);
      await tx.execute(sql`DELETE FROM senior_call_schedules WHERE senior_id = ${id}`);
      await tx.delete(notificationPreferences)
        .where(inArray(notificationPreferences.caregiverId,
          tx.select({ id: caregivers.id }).from(caregivers).where(eq(caregivers.seniorId, id))
        ));
      // Delete notifications via BOTH FK paths: senior_id and caregiver_id
      await tx.execute(sql`
        DELETE FROM notifications
        WHERE senior_id = ${id}
           OR caregiver_id IN (SELECT id FROM caregivers WHERE senior_id = ${id})
      `);
      await tx.execute(sql`DELETE FROM caregiver_notes WHERE senior_id = ${id}`);
      await tx.delete(caregivers).where(eq(caregivers.seniorId, id));
      await tx.delete(reminderDeliveries)
        .where(inArray(reminderDeliveries.reminderId,
          tx.select({ id: reminders.id }).from(reminders).where(eq(reminders.seniorId, id))
        ));
      await tx.delete(reminders).where(eq(reminders.seniorId, id));
      await tx.delete(dailyCallContext).where(eq(dailyCallContext.seniorId, id));
      await tx.delete(callAnalyses).where(eq(callAnalyses.seniorId, id));
      await tx.execute(sql`DELETE FROM call_metrics WHERE senior_id = ${id}`);
      await tx.delete(memories).where(eq(memories.seniorId, id));
      await tx.delete(conversations).where(eq(conversations.seniorId, id));

      // 3. Unlink prospects
      await tx.execute(sql`UPDATE prospects SET converted_senior_id = NULL WHERE converted_senior_id = ${id}`);

      // 4. Remove short-lived encrypted replay rows for the deleting user so
      // hard-delete responses cannot be replayed after the data is gone.
      await tx.execute(sql`
        DELETE FROM idempotency_keys
        WHERE user_id = ${deletedBy}
          AND created_at >= NOW() - INTERVAL '1 day'
      `);

      // 5. Delete senior
      const delResult = await tx.execute(sql`DELETE FROM seniors WHERE id = ${id}`);
      counts.seniors = delResult.rowCount || 0;

      // 6. Audit log
      await tx.insert(dataDeletionLogs).values({
        entityType: 'senior',
        entityId: id,
        deletionType: 'hard_delete',
        reason,
        deletedBy,
        recordCounts: counts,
      });
    });

    log.info('Hard-deleted senior', { seniorId: id.slice(0, 8), counts });
    return counts;
  }
};
