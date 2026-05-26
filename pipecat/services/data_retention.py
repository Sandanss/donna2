"""Data retention service -- scheduled purge of expired PHI data.

HIPAA requires defined retention periods for protected health information.
This service runs daily as a background asyncio loop and deletes data older
than the configured retention period for each table.

Retention periods are configurable via environment variables (see config.py).
Purges use batched deletes via CTEs to avoid long-running transactions
and excessive lock contention on production.
"""

from __future__ import annotations

import asyncio

from loguru import logger

from config import settings
from db.client import query_one

# ---------------------------------------------------------------------------
# Table configuration
# ---------------------------------------------------------------------------
# Each entry maps a table name to the date column used for age comparison.
# Only tables listed here (and in ALLOWED_TABLES) will be purged.

TABLE_DATE_COLUMNS: dict[str, str] = {
    "conversations": "started_at",
    "memories": "created_at",
    "prospect_memories": "created_at",
    "call_analyses": "created_at",
    "daily_call_context": "call_date",
    "call_metrics": "created_at",
    "reminder_deliveries": "created_at",
    "notifications": "sent_at",
    "caregiver_notes": "created_at",
    "prospects": "updated_at",
    "call_queue": "created_at",
    "call_attempts": "created_at",
    "post_call_jobs": "created_at",
    "outbound_call_guards": "created_at",
    "scheduler_shadow_comparisons": "created_at",
    "canary_cohort_membership": "removed_at",
    "waitlist": "created_at",
    "audit_logs": "created_at",
}

ALLOWED_TABLES = frozenset(TABLE_DATE_COLUMNS.keys())

BATCH_SIZE = 5000

LEGAL_HOLD_RESOURCE_TYPES: dict[str, str] = {
    "conversations": "conversation",
    "memories": "memory",
    "prospect_memories": "memory",
    "call_analyses": "call_analysis",
    "daily_call_context": "daily_call_context",
    "call_metrics": "call_metric",
    "reminder_deliveries": "reminder_delivery",
    "notifications": "notification",
    "caregiver_notes": "caregiver_note",
    "prospects": "prospect",
    "call_queue": "call_queue",
    "call_attempts": "call_attempt",
    "post_call_jobs": "post_call_job",
    "outbound_call_guards": "outbound_call_guard",
    "scheduler_shadow_comparisons": "scheduler_shadow_comparison",
    "canary_cohort_membership": "canary_cohort_membership",
    "waitlist": "waitlist",
    "audit_logs": "audit_log",
}


def _legal_hold_exclusion(alias: str, table: str) -> str:
    resource_type = LEGAL_HOLD_RESOURCE_TYPES.get(table)
    if not resource_type:
        return "TRUE"
    return (
        "NOT EXISTS ("
        " SELECT 1 FROM legal_holds lh"
        " WHERE lh.released_at IS NULL"
        f" AND lh.resource_type = '{resource_type}'"
        f" AND lh.resource_id = {alias}.id::text"
        ")"
    )


def _dependency_exclusion(alias: str, table: str) -> str:
    if table != "call_queue":
        return "TRUE"
    return (
        "NOT EXISTS (SELECT 1 FROM call_attempts ca WHERE ca.queue_id = target.id)"
        " AND NOT EXISTS (SELECT 1 FROM outbound_call_guards ocg WHERE ocg.queue_id = target.id)"
        " AND NOT EXISTS (SELECT 1 FROM scheduler_shadow_comparisons ssc WHERE ssc.queue_id = target.id)"
    ).replace("target.", f"{alias}.")


# ---------------------------------------------------------------------------
# Core purge logic
# ---------------------------------------------------------------------------

async def _purge_table(table: str, date_column: str, retention_days: int) -> int:
    """Delete rows from *table* older than *retention_days* in batches.

    Returns the total number of rows deleted across all batches.
    """
    assert table in ALLOWED_TABLES, f"Table {table!r} is not in ALLOWED_TABLES"

    total_deleted = 0

    while True:
        # Use a CTE so we can count the deleted rows in one round-trip.
        # The table and column names come from our own hardcoded config, not
        # user input, so the f-string is safe here.
        result = await query_one(
            f"WITH batch AS ("
            f"  SELECT target.ctid"
            f"  FROM {table} AS target"
            f"  WHERE target.{date_column} < NOW() - make_interval(days => $1)"
            f"    AND {_legal_hold_exclusion('target', table)}"
            f"    AND {_dependency_exclusion('target', table)}"
            f"  ORDER BY target.{date_column}"
            f"  LIMIT {BATCH_SIZE}"
            f"), deleted AS ("
            f"  DELETE FROM {table} AS target"
            f"  USING batch"
            f"  WHERE target.ctid = batch.ctid"
            f"  RETURNING 1"
            f") SELECT count(*) AS count FROM deleted",
            retention_days,
        )
        batch_count = result["count"] if result else 0
        total_deleted += batch_count

        # If we deleted fewer than the batch size, we're done.
        if batch_count < BATCH_SIZE:
            break

        # Yield to the event loop between batches so we don't starve callers.
        await asyncio.sleep(0.1)

    return total_deleted


async def _redact_conversation_phi(retention_days: int) -> int:
    """Null old conversation transcripts/summaries while retaining metadata."""
    total_redacted = 0

    while True:
        result = await query_one(
            f"WITH batch AS ("
            f"  SELECT target.ctid"
            f"  FROM conversations AS target"
            f"  WHERE target.started_at < NOW() - make_interval(days => $1)"
            f"    AND ("
            f"      target.summary IS NOT NULL"
            f"      OR target.summary_encrypted IS NOT NULL"
            f"      OR target.transcript IS NOT NULL"
            f"      OR target.transcript_encrypted IS NOT NULL"
            f"      OR target.transcript_text_encrypted IS NOT NULL"
            f"      OR target.concerns IS NOT NULL"
            f"    )"
            f"    AND {_legal_hold_exclusion('target', 'conversations')}"
            f"  ORDER BY target.started_at"
            f"  LIMIT {BATCH_SIZE}"
            f"), redacted AS ("
            f"  UPDATE conversations AS target"
            f"  SET summary = NULL,"
            f"      summary_encrypted = NULL,"
            f"      transcript = NULL,"
            f"      transcript_encrypted = NULL,"
            f"      transcript_text_encrypted = NULL,"
            f"      concerns = NULL"
            f"  FROM batch"
            f"  WHERE target.ctid = batch.ctid"
            f"  RETURNING 1"
            f") SELECT count(*) AS count FROM redacted",
            retention_days,
        )
        batch_count = result["count"] if result else 0
        total_redacted += batch_count
        if batch_count < BATCH_SIZE:
            break
        await asyncio.sleep(0.1)

    return total_redacted


async def _purge_inactive_reminders(retention_days: int) -> int:
    """Delete inactive reminder definitions after their retention window."""
    total_deleted = 0

    while True:
        result = await query_one(
            f"WITH batch AS ("
            f"  SELECT r.id"
            f"  FROM reminders r"
            f"  WHERE r.is_active = false"
            f"    AND COALESCE(r.deactivated_at, r.last_delivered_at, r.created_at) < NOW() - make_interval(days => $1)"
            f"    AND NOT EXISTS ("
            f"      SELECT 1 FROM legal_holds lh"
            f"      WHERE lh.released_at IS NULL"
            f"        AND lh.resource_type = 'reminder'"
            f"        AND lh.resource_id = r.id::text"
            f"    )"
            f"    AND NOT EXISTS ("
            f"      SELECT 1"
            f"      FROM reminder_deliveries rd"
            f"      JOIN legal_holds lh"
            f"        ON lh.released_at IS NULL"
            f"       AND lh.resource_type = 'reminder_delivery'"
            f"       AND lh.resource_id = rd.id::text"
            f"      WHERE rd.reminder_id = r.id"
            f"    )"
            f"  ORDER BY COALESCE(r.deactivated_at, r.last_delivered_at, r.created_at)"
            f"  LIMIT {BATCH_SIZE}"
            f"), deleted_deliveries AS ("
            f"  DELETE FROM reminder_deliveries rd"
            f"  USING batch"
            f"  WHERE rd.reminder_id = batch.id"
            f"  RETURNING 1"
            f"), deleted_reminders AS ("
            f"  DELETE FROM reminders r"
            f"  USING batch"
            f"  WHERE r.id = batch.id"
            f"  RETURNING 1"
            f") SELECT count(*) AS count FROM deleted_reminders",
            retention_days,
        )
        batch_count = result["count"] if result else 0
        total_deleted += batch_count
        if batch_count < BATCH_SIZE:
            break
        await asyncio.sleep(0.1)

    return total_deleted


async def _count_senior_profile_review_candidates(retention_days: int) -> int:
    """Count inactive senior profiles ready for manual review, without deleting."""
    result = await query_one(
        "SELECT COUNT(*) AS count"
        " FROM seniors s"
        " WHERE s.is_active = false"
        "   AND COALESCE("
        "     (SELECT MAX(c.started_at) FROM conversations c WHERE c.senior_id = s.id),"
        "     s.updated_at,"
        "     s.created_at"
        "   ) < NOW() - make_interval(days => $1)"
        "   AND NOT EXISTS ("
        "     SELECT 1 FROM legal_holds lh"
        "     WHERE lh.released_at IS NULL"
        "       AND lh.resource_type = 'senior'"
        "       AND lh.resource_id = s.id::text"
        "   )",
        retention_days,
    )
    return result["count"] if result else 0


async def purge_expired_data() -> dict[str, int]:
    """Delete rows older than their retention period from all PHI tables.

    Returns a dict mapping table name -> number of rows deleted.
    Skips tables whose retention period is set to 0 (disabled).
    """
    retention_days = {
        "conversation_phi": settings.retention_conversations_days,
        "conversations": settings.retention_conversation_metadata_days,
        "memories": settings.retention_memories_days,
        "prospect_memories": settings.retention_memories_days,
        "call_analyses": settings.retention_call_analyses_days,
        "daily_call_context": settings.retention_daily_context_days,
        "call_metrics": settings.retention_call_metrics_days,
        "inactive_reminders": settings.retention_inactive_reminders_days,
        "reminder_deliveries": settings.retention_reminder_deliveries_days,
        "notifications": settings.retention_notifications_days,
        "caregiver_notes": settings.retention_caregiver_notes_days,
        "prospects": settings.retention_prospects_days,
        "senior_profile_review": settings.retention_inactive_senior_review_days,
        "call_attempts": settings.retention_call_attempts_days,
        "post_call_jobs": settings.retention_post_call_jobs_days,
        "outbound_call_guards": settings.retention_outbound_call_guards_days,
        "scheduler_shadow_comparisons": settings.retention_scheduler_shadow_comparisons_days,
        "call_queue": settings.retention_call_queue_days,
        "canary_cohort_membership": settings.retention_canary_cohort_membership_days,
        "waitlist": settings.retention_waitlist_days,
        "audit_logs": settings.retention_audit_logs_days,
    }

    results: dict[str, int] = {}

    for table, days in retention_days.items():
        if days <= 0:
            # 0 means retention is disabled for this table -- skip.
            continue

        try:
            if table == "conversation_phi":
                results[table] = await _redact_conversation_phi(days)
                continue

            if table == "inactive_reminders":
                results[table] = await _purge_inactive_reminders(days)
                continue

            if table == "senior_profile_review":
                results["senior_profile_review_candidates"] = await _count_senior_profile_review_candidates(days)
                continue

            date_col = TABLE_DATE_COLUMNS.get(table)
            if not date_col:
                continue

            deleted = await _purge_table(table, date_col, days)
            results[table] = deleted
        except Exception as exc:
            # Log the error but continue with the remaining tables so a
            # single missing table (e.g. audit_logs not yet created) doesn't
            # block the whole purge cycle.
            logger.warning(
                "Data retention: failed to purge {table}: {err}",
                table=table,
                err=str(exc),
            )
            results[table] = -1

    return results


# ---------------------------------------------------------------------------
# Background loop
# ---------------------------------------------------------------------------

PURGE_INTERVAL_SECONDS = 24 * 60 * 60  # 24 hours


async def start_retention_loop() -> None:
    """Run the data retention purge once every 24 hours.

    Call once at startup via ``asyncio.create_task(start_retention_loop())``.
    The first purge runs 60 seconds after startup to let the DB pool warm up.
    """
    # Wait briefly so the server can finish starting up.
    await asyncio.sleep(60)

    while True:
        try:
            results = await purge_expired_data()
            total = sum(v for v in results.values() if v > 0)
            if total > 0:
                logger.info(
                    "Data retention purge complete: {results} (total={total})",
                    results=results,
                    total=total,
                )
            else:
                logger.debug("Data retention purge: nothing to delete")
        except Exception as exc:
            logger.error("Data retention purge failed: {err}", err=str(exc))

        await asyncio.sleep(PURGE_INTERVAL_SECONDS)
