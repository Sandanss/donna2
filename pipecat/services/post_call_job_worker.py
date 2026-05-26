"""Post-call job worker for Pipecat-owned heavy processing.

The shared ``post_call_jobs`` table is intentionally PHI-light: rows carry
operational IDs, job type, dependencies, and status. This worker resolves the
PHI it needs from encrypted runtime tables inside Pipecat and never returns or
prints transcripts, summaries, names, or reminder text.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from loguru import logger

from db import get_pool, query_one
from lib.encryption import decrypt_json
from services.post_call_jobs import JOB_TYPES


STATUSES = {
    "QUEUED": "queued",
    "LEASED": "leased",
    "RUNNING": "running",
    "COMPLETED": "completed",
    "FAILED": "failed",
    "DEAD_LETTER": "dead_letter",
}

BACKOFF_SECONDS = {
    JOB_TYPES["ANALYSIS"]: [60, 300, 1800, 7200],
    JOB_TYPES["MEMORY_EXTRACTION"]: [60, 300, 1800, 7200],
    JOB_TYPES["CAREGIVER_NOTIFICATIONS"]: [15, 60],
    JOB_TYPES["REMINDER_RECOVERY"]: [10, 30],
    JOB_TYPES["METRICS_FINALIZE"]: [60, 300, 1800],
    "default": [30, 120, 480, 1920],
}


class PendingPostCallArtifact(RuntimeError):
    """Raised when a dependency artifact is not ready yet."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class WorkerResult:
    job_type: str
    status: str
    error_code: str | None = None


def _transcript_has_content(transcript: Any) -> bool:
    if isinstance(transcript, list):
        return any(isinstance(t, dict) and t.get("content") for t in transcript)
    if isinstance(transcript, str):
        return bool(transcript.strip())
    return bool(transcript)


def _sanitize_code(value: Any, fallback: str = "unknown_error") -> str:
    raw = str(value or fallback).lower()
    cleaned = "".join(ch if ch.isalnum() or ch in "_.:-" else "_" for ch in raw)
    return (cleaned or fallback)[:120]


async def recover_expired_post_call_leases(limit: int = 100) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH candidates AS (
              SELECT id
              FROM post_call_jobs
              WHERE status = 'leased'
                AND lease_expires_at <= NOW()
              ORDER BY lease_expires_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT $1
            )
            UPDATE post_call_jobs job
            SET status = 'queued',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
            FROM candidates
            WHERE job.id = candidates.id
            RETURNING job.id
            """,
            max(1, min(int(limit or 100), 5000)),
        )
    return len(rows)


async def dead_letter_blocked_dependents(limit: int = 500) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH blocked AS (
              SELECT child.id
              FROM post_call_jobs child
              WHERE child.status IN ('queued', 'failed', 'leased')
                AND EXISTS (
                  SELECT 1
                  FROM unnest(child.depends_on) AS dep(job_id)
                  JOIN post_call_jobs parent ON parent.id = dep.job_id
                  WHERE parent.status = 'dead_letter'
                )
              ORDER BY child.created_at ASC
              LIMIT $1
            )
            UPDATE post_call_jobs child
            SET status = 'dead_letter',
                lease_owner = NULL,
                lease_expires_at = NULL,
                dead_letter_reason = 'dependency_dead_lettered',
                dead_lettered_at = NOW(),
                updated_at = NOW()
            FROM blocked
            WHERE child.id = blocked.id
            RETURNING child.id
            """,
            max(1, min(int(limit or 500), 5000)),
        )
    return len(rows)


async def lease_ready_post_call_jobs(
    *,
    worker_id: str,
    limit: int = 10,
    lease_seconds: int = 120,
    job_types: list[str] | None = None,
) -> list[dict]:
    clean_types = [jt for jt in (job_types or []) if jt in JOB_TYPES.values()]
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH ready AS (
              SELECT job.id
              FROM post_call_jobs job
              WHERE job.status IN ('queued', 'failed')
                AND job.run_after <= NOW()
                AND job.attempt_count < job.max_attempts
                AND (cardinality($4::text[]) = 0 OR job.job_type = ANY($4::text[]))
                AND NOT EXISTS (
                  SELECT 1
                  FROM unnest(job.depends_on) AS dep(job_id)
                  LEFT JOIN post_call_jobs parent ON parent.id = dep.job_id
                  WHERE parent.id IS NULL OR parent.status <> 'completed'
                )
              ORDER BY job.priority DESC, job.run_after ASC, job.created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT $3
            )
            UPDATE post_call_jobs job
            SET status = 'leased',
                lease_owner = $1,
                lease_expires_at = NOW() + ($2::int * INTERVAL '1 second'),
                attempt_count = job.attempt_count + 1,
                updated_at = NOW()
            FROM ready
            WHERE job.id = ready.id
            RETURNING job.*
            """,
            worker_id,
            max(30, min(int(lease_seconds or 120), 3600)),
            max(1, min(int(limit or 10), 500)),
            clean_types,
        )
    return [dict(row) for row in rows]


async def _mark_running(job_id: str, worker_id: str) -> dict | None:
    return await query_one(
        """
        UPDATE post_call_jobs
        SET status = 'running',
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
          AND lease_owner = $2
          AND status = 'leased'
          AND lease_expires_at > NOW()
        RETURNING *
        """,
        job_id,
        worker_id,
    )


async def _complete_job(job_id: str, worker_id: str) -> dict | None:
    return await query_one(
        """
        UPDATE post_call_jobs
        SET status = 'completed',
            completed_at = NOW(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND lease_owner = $2
          AND status IN ('leased', 'running')
        RETURNING *
        """,
        job_id,
        worker_id,
    )


async def _fail_job(job: dict, worker_id: str, error_code: str) -> dict | None:
    attempt_count = int(job.get("attempt_count") or 0)
    max_attempts = int(job.get("max_attempts") or 5)
    job_type = str(job.get("job_type") or "")
    clean_error = _sanitize_code(error_code)
    if attempt_count >= max_attempts:
        return await query_one(
            """
            UPDATE post_call_jobs
            SET status = 'dead_letter',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error_code = $3,
                last_error_at = NOW(),
                dead_letter_reason = $3,
                dead_lettered_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
              AND lease_owner = $2
              AND status IN ('leased', 'running')
            RETURNING *
            """,
            job["id"],
            worker_id,
            clean_error,
        )

    backoffs = BACKOFF_SECONDS.get(job_type) or BACKOFF_SECONDS["default"]
    backoff_seconds = backoffs[min(max(attempt_count - 1, 0), len(backoffs) - 1)]
    return await query_one(
        """
        UPDATE post_call_jobs
        SET status = 'failed',
            run_after = NOW() + ($4::int * INTERVAL '1 second'),
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = $3,
            last_error_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND lease_owner = $2
          AND status IN ('leased', 'running')
        RETURNING *
        """,
        job["id"],
        worker_id,
        clean_error,
        backoff_seconds,
    )


async def _count(query: str, *args) -> int:
    row = await query_one(query, *args)
    return int((row or {}).get("count") or 0)


async def _load_context(job: dict) -> dict:
    call_sid = str(job.get("call_sid") or "")
    from services.conversations import get_by_call_sid, get_transcript_by_call_sid, format_transcript_text
    from services.seniors import get_by_id

    conversation = await get_by_call_sid(call_sid)
    senior_id = str(job.get("senior_id") or (conversation or {}).get("senior_id") or "")
    senior = await get_by_id(senior_id) if senior_id else None
    transcript = await get_transcript_by_call_sid(call_sid)
    formatted_transcript = format_transcript_text(transcript)

    return {
        "call_sid": call_sid,
        "conversation": conversation,
        "conversation_id": str(job.get("conversation_id") or (conversation or {}).get("id") or ""),
        "senior_id": senior_id,
        "senior": senior,
        "transcript": transcript,
        "formatted_transcript": formatted_transcript,
        "call_started_at": (conversation or {}).get("started_at"),
        "duration_seconds": int((conversation or {}).get("duration_seconds") or 0),
    }


async def _analysis_for_conversation(conversation_id: str) -> dict | None:
    if not conversation_id:
        return None
    row = await query_one(
        """
        SELECT analysis_encrypted, summary, engagement_score, call_quality
        FROM call_analyses
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        """,
        conversation_id,
    )
    if not row:
        return None
    if row.get("analysis_encrypted"):
        analysis = decrypt_json(row["analysis_encrypted"])
        if isinstance(analysis, dict):
            return analysis
    return row


async def _require_conversation_completed(job: dict) -> None:
    count = await _count(
        """
        SELECT COUNT(*)::int AS count
        FROM conversations
        WHERE call_sid = $1
          AND status = 'completed'
          AND ended_at IS NOT NULL
        """,
        job["call_sid"],
    )
    if count < 1:
        raise PendingPostCallArtifact("conversation_completion_pending")


async def _handle_metrics_finalize(job: dict) -> None:
    await _require_conversation_completed(job)
    count = await _count(
        "SELECT COUNT(*)::int AS count FROM call_metrics WHERE call_sid = $1",
        job["call_sid"],
    )
    if count < 1:
        raise PendingPostCallArtifact("metrics_finalize_pending")


async def _handle_reminder_recovery(job: dict) -> None:
    await _require_conversation_completed(job)
    delivered = await _count(
        """
        SELECT COUNT(*)::int AS count
        FROM reminder_deliveries
        WHERE call_sid = $1
          AND status = 'delivered'
        """,
        job["call_sid"],
    )
    if delivered > 0:
        raise PendingPostCallArtifact("reminder_recovery_pending")


async def _handle_analysis(job: dict) -> None:
    await _require_conversation_completed(job)
    ctx = await _load_context(job)
    if not (ctx["senior_id"] and ctx["senior"] and _transcript_has_content(ctx["transcript"])):
        return
    if await _analysis_for_conversation(ctx["conversation_id"]):
        return

    from services.call_analysis import analyze_completed_call, save_call_analysis
    from services.conversations import update_sentiment, update_summary

    analysis = await analyze_completed_call(
        ctx["transcript"],
        ctx["senior"],
        call_started_at=ctx["call_started_at"],
    )
    saved = await save_call_analysis(ctx["conversation_id"], ctx["senior_id"], analysis)
    if not saved:
        raise RuntimeError("analysis_save_failed")
    summary = analysis.get("summary") if analysis else None
    sentiment = analysis.get("sentiment") if analysis else None
    if summary and summary != "Analysis unavailable":
        await update_summary(ctx["call_sid"], summary, sentiment)
    elif sentiment:
        await update_sentiment(ctx["call_sid"], sentiment)


async def _handle_memory_extraction(job: dict) -> None:
    await _require_conversation_completed(job)
    ctx = await _load_context(job)
    if not (ctx["senior_id"] and ctx["formatted_transcript"]):
        return
    existing = await _count(
        """
        SELECT COUNT(*)::int AS count
        FROM memories
        WHERE senior_id = $1
          AND source = $2
        """,
        ctx["senior_id"],
        ctx["conversation_id"],
    )
    if existing > 0:
        return

    from services.memory import extract_from_conversation

    await extract_from_conversation(
        ctx["senior_id"],
        ctx["formatted_transcript"],
        ctx["conversation_id"] or "unknown",
        call_started_at=ctx["call_started_at"],
        timezone_name=(ctx["senior"] or {}).get("timezone", "America/New_York"),
    )


async def _handle_daily_context(job: dict) -> None:
    await _require_conversation_completed(job)
    ctx = await _load_context(job)
    if not ctx["senior_id"]:
        return
    existing = await _count(
        "SELECT COUNT(*)::int AS count FROM daily_call_context WHERE call_sid = $1",
        ctx["call_sid"],
    )
    if existing > 0:
        return

    analysis = await _analysis_for_conversation(ctx["conversation_id"]) or {}
    from services.daily_context import save_call_context

    await save_call_context(
        senior_id=ctx["senior_id"],
        call_sid=ctx["call_sid"],
        data={
            "topics_discussed": analysis.get("topics_discussed") or analysis.get("topics") or [],
            "advice_given": [],
            "reminders_delivered": analysis.get("reminders_delivered") or [],
            "timezone": (ctx["senior"] or {}).get("timezone", "America/New_York"),
            "summary": analysis.get("summary"),
        },
    )


async def _handle_caregiver_notifications(job: dict) -> None:
    await _require_conversation_completed(job)
    ctx = await _load_context(job)
    analysis = await _analysis_for_conversation(ctx["conversation_id"])
    if not (ctx["senior_id"] and analysis):
        return

    from services.post_call import _trigger_caregiver_notification

    await _trigger_caregiver_notification(
        ctx["senior_id"],
        ctx["call_sid"],
        analysis,
        ctx["duration_seconds"],
    )


async def _handle_interest_discovery(job: dict) -> None:
    await _require_conversation_completed(job)
    ctx = await _load_context(job)
    senior = ctx["senior"] or {}
    analysis = await _analysis_for_conversation(ctx["conversation_id"])
    if not (ctx["senior_id"] and senior and analysis):
        return

    from services.interest_discovery import (
        add_interests_to_senior,
        compute_interest_scores,
        discover_new_interests,
        update_interest_scores,
    )

    existing_interests = senior.get("interests") or []
    new_interests = discover_new_interests(existing_interests, analysis, [])
    if new_interests:
        senior["interests"] = await add_interests_to_senior(
            ctx["senior_id"],
            new_interests,
            existing_interests,
        )

    interests = senior.get("interests") or []
    if interests:
        scores = await compute_interest_scores(ctx["senior_id"], interests)
        await update_interest_scores(ctx["senior_id"], scores)


async def _handle_snapshot_rebuild(job: dict) -> None:
    await _require_conversation_completed(job)
    ctx = await _load_context(job)
    if not ctx["senior_id"]:
        return
    analysis = await _analysis_for_conversation(ctx["conversation_id"])
    tz = (ctx["senior"] or {}).get("timezone", "America/New_York")

    from services.call_snapshot import build_snapshot, save_snapshot

    snapshot = await build_snapshot(
        ctx["senior_id"],
        tz,
        analysis,
        last_call_started_at=ctx["call_started_at"],
    )
    await save_snapshot(ctx["senior_id"], snapshot)


HANDLERS: dict[str, Callable[[dict], Awaitable[None]]] = {
    JOB_TYPES["METRICS_FINALIZE"]: _handle_metrics_finalize,
    JOB_TYPES["REMINDER_RECOVERY"]: _handle_reminder_recovery,
    JOB_TYPES["ANALYSIS"]: _handle_analysis,
    JOB_TYPES["MEMORY_EXTRACTION"]: _handle_memory_extraction,
    JOB_TYPES["DAILY_CONTEXT"]: _handle_daily_context,
    JOB_TYPES["CAREGIVER_NOTIFICATIONS"]: _handle_caregiver_notifications,
    JOB_TYPES["INTEREST_DISCOVERY"]: _handle_interest_discovery,
    JOB_TYPES["SNAPSHOT_REBUILD"]: _handle_snapshot_rebuild,
}


async def execute_post_call_job(job: dict, *, worker_id: str) -> WorkerResult:
    running = await _mark_running(str(job["id"]), worker_id)
    if not running:
        return WorkerResult(job_type=str(job.get("job_type")), status="skipped")

    job_type = str(running.get("job_type") or "")
    handler = HANDLERS.get(job_type)
    if not handler:
        failed = await _fail_job(running, worker_id, "handler_missing")
        return WorkerResult(
            job_type=job_type,
            status=str((failed or {}).get("status") or STATUSES["FAILED"]),
            error_code="handler_missing",
        )

    try:
        await handler(running)
        completed = await _complete_job(str(running["id"]), worker_id)
        return WorkerResult(
            job_type=job_type,
            status=str((completed or {}).get("status") or STATUSES["COMPLETED"]),
        )
    except PendingPostCallArtifact as exc:
        failed = await _fail_job(running, worker_id, exc.code)
        return WorkerResult(
            job_type=job_type,
            status=str((failed or {}).get("status") or STATUSES["FAILED"]),
            error_code=exc.code,
        )
    except Exception as exc:
        error_code = _sanitize_code(getattr(exc, "code", None) or str(exc) or "handler_failed")
        failed = await _fail_job(running, worker_id, error_code)
        logger.warning(
            "Post-call job failed type={job_type} status={status} code={code}",
            job_type=job_type,
            status=str((failed or {}).get("status") or STATUSES["FAILED"]),
            code=error_code,
        )
        return WorkerResult(
            job_type=job_type,
            status=str((failed or {}).get("status") or STATUSES["FAILED"]),
            error_code=error_code,
        )


async def run_post_call_worker_once(
    *,
    worker_id: str,
    limit: int = 10,
    lease_seconds: int = 120,
    job_types: list[str] | None = None,
    concurrency: int = 2,
) -> dict:
    recovered = await recover_expired_post_call_leases()
    blocked = await dead_letter_blocked_dependents()
    jobs = await lease_ready_post_call_jobs(
        worker_id=worker_id,
        limit=limit,
        lease_seconds=lease_seconds,
        job_types=job_types,
    )
    semaphore = asyncio.Semaphore(max(1, min(int(concurrency or 2), 20)))

    async def _run(job: dict) -> WorkerResult:
        async with semaphore:
            return await execute_post_call_job(job, worker_id=worker_id)

    results = await asyncio.gather(*[_run(job) for job in jobs])
    counts: dict[str, int] = {}
    by_job_type: dict[str, int] = {}
    for result in results:
        counts[result.status] = counts.get(result.status, 0) + 1
        key = f"{result.job_type}:{result.status}"
        by_job_type[key] = by_job_type.get(key, 0) + 1

    dead_lettered = counts.get(STATUSES["DEAD_LETTER"], 0)
    return {
        "ok": dead_lettered == 0 and blocked == 0,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "worker_id": worker_id,
        "leased": len(jobs),
        "recovered_leases": recovered,
        "blocked_dead_lettered": blocked,
        "counts": counts,
        "by_job_type": by_job_type,
        "phi_policy": {
            "output_contains_raw_phi": False,
            "notes": "Aggregate job counts only; no transcripts, summaries, names, phones, prompts, or job IDs.",
        },
    }
