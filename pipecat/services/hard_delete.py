"""Hard-delete cascade — permanently remove a senior or prospect and all data.

Application-level cascade in a single transaction. No DB-level CASCADE
constraints (they would break soft-delete). Every table referencing
seniors(id) must be listed here.
"""

from __future__ import annotations

import json

from loguru import logger
from db.client import get_pool


async def _assert_no_active_senior_legal_hold(conn, senior_id: str) -> None:
    count = await conn.fetchval(
        """
        SELECT COUNT(*)::int
        FROM legal_holds lh
        WHERE lh.released_at IS NULL
          AND (
            (lh.resource_type = 'senior' AND lh.resource_id = $1)
            OR EXISTS (
              SELECT 1 FROM conversations c
              WHERE c.senior_id = $1
                AND lh.resource_type = 'conversation'
                AND lh.resource_id = c.id::text
            )
            OR EXISTS (
              SELECT 1 FROM memories m
              WHERE m.senior_id = $1
                AND lh.resource_type = 'memory'
                AND lh.resource_id = m.id::text
            )
            OR EXISTS (
              SELECT 1 FROM reminders r
              WHERE r.senior_id = $1
                AND lh.resource_type = 'reminder'
                AND lh.resource_id = r.id::text
            )
            OR EXISTS (
              SELECT 1 FROM reminder_deliveries rd
              JOIN reminders r ON r.id = rd.reminder_id
              WHERE r.senior_id = $1
                AND lh.resource_type = 'reminder_delivery'
                AND lh.resource_id = rd.id::text
            )
            OR EXISTS (
              SELECT 1 FROM call_analyses ca
              WHERE ca.senior_id = $1
                AND lh.resource_type = 'call_analysis'
                AND lh.resource_id = ca.id::text
            )
            OR EXISTS (
              SELECT 1 FROM daily_call_context dcc
              WHERE dcc.senior_id = $1
                AND lh.resource_type = 'daily_call_context'
                AND lh.resource_id = dcc.id::text
            )
            OR EXISTS (
              SELECT 1 FROM notifications n
              WHERE n.senior_id = $1
                AND lh.resource_type = 'notification'
                AND lh.resource_id = n.id::text
            )
            OR EXISTS (
              SELECT 1 FROM senior_call_schedules scs
              WHERE scs.senior_id = $1
                AND lh.resource_type = 'senior_call_schedule'
                AND lh.resource_id = scs.id::text
            )
            OR EXISTS (
              SELECT 1 FROM call_queue cq
              WHERE cq.senior_id = $1
                AND lh.resource_type = 'call_queue'
                AND lh.resource_id = cq.id::text
            )
            OR EXISTS (
              SELECT 1 FROM call_attempts cat
              WHERE cat.senior_id = $1
                AND lh.resource_type = 'call_attempt'
                AND lh.resource_id = cat.id::text
            )
            OR EXISTS (
              SELECT 1 FROM post_call_jobs pcj
              WHERE (
                  pcj.senior_id = $1
                  OR pcj.conversation_id IN (
                    SELECT c.id FROM conversations c WHERE c.senior_id = $1
                  )
                )
                AND lh.resource_type = 'post_call_job'
                AND lh.resource_id = pcj.id::text
            )
            OR EXISTS (
              SELECT 1 FROM outbound_call_guards ocg
              WHERE ocg.senior_id = $1
                AND lh.resource_type = 'outbound_call_guard'
                AND lh.resource_id = ocg.id::text
            )
            OR EXISTS (
              SELECT 1 FROM scheduler_shadow_comparisons ssc
              WHERE ssc.senior_id = $1
                AND lh.resource_type = 'scheduler_shadow_comparison'
                AND lh.resource_id = ssc.id::text
            )
            OR EXISTS (
              SELECT 1 FROM caregiver_notes cn
              WHERE cn.senior_id = $1
                AND lh.resource_type = 'caregiver_note'
                AND lh.resource_id = cn.id::text
            )
          )
        """,
        senior_id,
    )
    if count and count > 0:
        raise RuntimeError("Data deletion is blocked by an active legal hold")


async def _assert_no_active_prospect_legal_hold(conn, prospect_id: str) -> None:
    count = await conn.fetchval(
        """SELECT COUNT(*)::int
           FROM legal_holds lh
           WHERE lh.released_at IS NULL
             AND (
               (lh.resource_type = 'prospect' AND lh.resource_id = $1)
               OR EXISTS (
                 SELECT 1 FROM memories m
                 WHERE m.prospect_id = $1
                   AND lh.resource_type = 'memory'
                   AND lh.resource_id = m.id::text
               )
               OR EXISTS (
                 SELECT 1 FROM conversations c
                 WHERE c.prospect_id = $1
                   AND lh.resource_type = 'conversation'
                   AND lh.resource_id = c.id::text
               )
             )""",
        prospect_id,
    )
    if count and count > 0:
        raise RuntimeError("Data deletion is blocked by an active legal hold")


async def hard_delete_senior(
    senior_id: str,
    deleted_by: str,
    reason: str = "user_request",
) -> dict:
    """Hard-delete a senior and ALL associated data in a single transaction.

    Deletes in dependency order to respect foreign key constraints.
    Returns dict with record counts per table.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _assert_no_active_senior_legal_hold(conn, senior_id)

            # 1. Count records per table for audit log
            counts = {}
            count_queries = [
                ("notification_preferences", """
                    SELECT COUNT(*) FROM notification_preferences
                    WHERE caregiver_id IN (SELECT id FROM caregivers WHERE senior_id = $1)
                """),
                # Count notifications via BOTH FK paths: senior_id and caregiver_id
                ("notifications", """
                    SELECT COUNT(*) FROM notifications
                    WHERE senior_id = $1
                       OR caregiver_id IN (SELECT id FROM caregivers WHERE senior_id = $1)
                """),
                ("caregiver_notes", "SELECT COUNT(*) FROM caregiver_notes WHERE senior_id = $1"),
                ("caregivers", "SELECT COUNT(*) FROM caregivers WHERE senior_id = $1"),
                ("reminder_deliveries", """
                    SELECT COUNT(*) FROM reminder_deliveries
                    WHERE reminder_id IN (SELECT id FROM reminders WHERE senior_id = $1)
                """),
                ("reminders", "SELECT COUNT(*) FROM reminders WHERE senior_id = $1"),
                ("daily_call_context", "SELECT COUNT(*) FROM daily_call_context WHERE senior_id = $1"),
                ("call_analyses", "SELECT COUNT(*) FROM call_analyses WHERE senior_id = $1"),
                ("call_metrics", "SELECT COUNT(*) FROM call_metrics WHERE senior_id = $1"),
                ("senior_call_schedules", "SELECT COUNT(*) FROM senior_call_schedules WHERE senior_id = $1"),
                ("call_queue", "SELECT COUNT(*) FROM call_queue WHERE senior_id = $1"),
                ("call_attempts", "SELECT COUNT(*) FROM call_attempts WHERE senior_id = $1"),
                ("post_call_jobs", """
                    SELECT COUNT(*) FROM post_call_jobs
                    WHERE senior_id = $1
                       OR conversation_id IN (SELECT id FROM conversations WHERE senior_id = $1)
                """),
                ("outbound_call_guards", "SELECT COUNT(*) FROM outbound_call_guards WHERE senior_id = $1"),
                ("scheduler_shadow_comparisons", "SELECT COUNT(*) FROM scheduler_shadow_comparisons WHERE senior_id = $1"),
                ("memories", "SELECT COUNT(*) FROM memories WHERE senior_id = $1"),
                ("conversations", "SELECT COUNT(*) FROM conversations WHERE senior_id = $1"),
            ]
            for table, sql in count_queries:
                row = await conn.fetchval(sql, senior_id)
                counts[table] = row or 0

            row = await conn.fetchval(
                """SELECT COUNT(*) FROM idempotency_keys
                   WHERE user_id = $1
                     AND created_at >= NOW() - INTERVAL '1 day'""",
                deleted_by,
            )
            counts["idempotency_keys"] = row or 0

            # 2. DELETE in dependency order (deepest children first)
            # notification_preferences → caregivers(id)
            await conn.execute(
                """DELETE FROM notification_preferences
                   WHERE caregiver_id IN (SELECT id FROM caregivers WHERE senior_id = $1)""",
                senior_id,
            )
            # notifications → caregiver_id AND senior_id (delete via BOTH FK paths)
            await conn.execute(
                """DELETE FROM notifications
                   WHERE senior_id = $1
                      OR caregiver_id IN (SELECT id FROM caregivers WHERE senior_id = $1)""",
                senior_id,
            )
            # caregiver_notes → senior_id AND caregiver_id
            await conn.execute(
                "DELETE FROM caregiver_notes WHERE senior_id = $1", senior_id
            )
            # caregivers → senior_id (safe now: notifications + notification_preferences gone)
            await conn.execute(
                "DELETE FROM caregivers WHERE senior_id = $1", senior_id
            )
            # reminder_deliveries → reminder_id → reminders.senior_id
            await conn.execute(
                """DELETE FROM reminder_deliveries
                   WHERE reminder_id IN (SELECT id FROM reminders WHERE senior_id = $1)""",
                senior_id,
            )
            await conn.execute(
                "DELETE FROM reminders WHERE senior_id = $1", senior_id
            )
            await conn.execute(
                "DELETE FROM daily_call_context WHERE senior_id = $1", senior_id
            )
            await conn.execute(
                "DELETE FROM call_analyses WHERE senior_id = $1", senior_id
            )
            # call_metrics → senior_id (from migration 004)
            await conn.execute(
                "DELETE FROM call_metrics WHERE senior_id = $1", senior_id
            )
            await conn.execute(
                """DELETE FROM post_call_jobs
                   WHERE senior_id = $1
                      OR conversation_id IN (SELECT id FROM conversations WHERE senior_id = $1)""",
                senior_id,
            )
            await conn.execute(
                "DELETE FROM scheduler_shadow_comparisons WHERE senior_id = $1",
                senior_id,
            )
            await conn.execute(
                "DELETE FROM outbound_call_guards WHERE senior_id = $1", senior_id
            )
            await conn.execute(
                "DELETE FROM call_attempts WHERE senior_id = $1", senior_id
            )
            await conn.execute(
                "DELETE FROM call_queue WHERE senior_id = $1", senior_id
            )
            await conn.execute(
                "DELETE FROM senior_call_schedules WHERE senior_id = $1", senior_id
            )
            await conn.execute(
                "DELETE FROM memories WHERE senior_id = $1", senior_id
            )
            await conn.execute(
                "DELETE FROM conversations WHERE senior_id = $1", senior_id
            )

            # 3. Unlink any prospects that converted to this senior
            await conn.execute(
                "UPDATE prospects SET converted_senior_id = NULL WHERE converted_senior_id = $1",
                senior_id,
            )

            # 4. Remove short-lived encrypted replay rows for the deleting user.
            await conn.execute(
                """DELETE FROM idempotency_keys
                   WHERE user_id = $1
                     AND created_at >= NOW() - INTERVAL '1 day'""",
                deleted_by,
            )

            # 5. Delete the senior row itself (all FKs cleared above)
            result = await conn.execute("DELETE FROM seniors WHERE id = $1", senior_id)
            counts["seniors"] = _parse_count(result)

            # 6. Insert audit log
            await conn.execute(
                """INSERT INTO data_deletion_logs
                   (entity_type, entity_id, deletion_type, reason, deleted_by, record_counts)
                   VALUES ($1, $2, $3, $4, $5, $6)""",
                "senior",
                senior_id,
                "hard_delete",
                reason,
                deleted_by,
                json.dumps(counts),
            )

    total = sum(counts.values())
    logger.info(
        "Hard-deleted senior {sid}: {total} records across {tables} tables",
        sid=str(senior_id)[:8],
        total=total,
        tables=len([v for v in counts.values() if v > 0]),
    )
    return counts


async def hard_delete_prospect(
    prospect_id: str,
    deleted_by: str,
    reason: str = "user_request",
) -> dict:
    """Hard-delete a prospect and all associated data."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _assert_no_active_prospect_legal_hold(conn, prospect_id)

            counts = {}

            row = await conn.fetchval(
                "SELECT COUNT(*) FROM memories WHERE prospect_id = $1", prospect_id
            )
            counts["memories"] = row or 0

            row = await conn.fetchval(
                "SELECT COUNT(*) FROM conversations WHERE prospect_id = $1", prospect_id
            )
            counts["conversations"] = row or 0

            row = await conn.fetchval(
                """SELECT COUNT(*) FROM idempotency_keys
                   WHERE user_id = $1
                     AND created_at >= NOW() - INTERVAL '1 day'""",
                deleted_by,
            )
            counts["idempotency_keys"] = row or 0

            await conn.execute(
                "DELETE FROM memories WHERE prospect_id = $1", prospect_id
            )
            await conn.execute(
                "DELETE FROM conversations WHERE prospect_id = $1", prospect_id
            )

            result = await conn.execute(
                "DELETE FROM prospects WHERE id = $1", prospect_id
            )
            counts["prospects"] = _parse_count(result)

            await conn.execute(
                """DELETE FROM idempotency_keys
                   WHERE user_id = $1
                     AND created_at >= NOW() - INTERVAL '1 day'""",
                deleted_by,
            )

            await conn.execute(
                """INSERT INTO data_deletion_logs
                   (entity_type, entity_id, deletion_type, reason, deleted_by, record_counts)
                   VALUES ($1, $2, $3, $4, $5, $6)""",
                "prospect",
                prospect_id,
                "hard_delete",
                reason,
                deleted_by,
                json.dumps(counts),
            )

    logger.info(
        "Hard-deleted prospect {pid}: {total} records",
        pid=str(prospect_id)[:8],
        total=sum(counts.values()),
    )
    return counts


def _parse_count(result: str) -> int:
    """Parse row count from asyncpg execute result like 'DELETE 1'."""
    try:
        return int(result.split()[-1])
    except (ValueError, IndexError):
        return 0
