"""Post-call job graph enqueue helpers.

This module mirrors the Node Phase 6 job graph in ``services/post-call-jobs.js``.
It stores operational IDs and encrypted payload references only. When
POST_CALL_QUEUE_ENABLED is enabled, ``services.post_call`` completes the
conversation and seeds this graph, then the Pipecat post-call worker executes
the heavy analysis, memory, daily-context, notification, interest, and snapshot
jobs outside the call teardown path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from loguru import logger

from config import get_settings
from db.client import query_one


JOB_TYPES = {
    "METRICS_FINALIZE": "metrics_finalize",
    "REMINDER_RECOVERY": "reminder_recovery",
    "ANALYSIS": "analysis",
    "MEMORY_EXTRACTION": "memory_extraction",
    "DAILY_CONTEXT": "daily_context",
    "CAREGIVER_NOTIFICATIONS": "caregiver_notifications",
    "INTEREST_DISCOVERY": "interest_discovery",
    "SNAPSHOT_REBUILD": "snapshot_rebuild",
}

JOB_ORDER = (
    JOB_TYPES["METRICS_FINALIZE"],
    JOB_TYPES["REMINDER_RECOVERY"],
    JOB_TYPES["ANALYSIS"],
    JOB_TYPES["MEMORY_EXTRACTION"],
    JOB_TYPES["DAILY_CONTEXT"],
    JOB_TYPES["CAREGIVER_NOTIFICATIONS"],
    JOB_TYPES["INTEREST_DISCOVERY"],
    JOB_TYPES["SNAPSHOT_REBUILD"],
)

JOB_GRAPH = {
    JOB_TYPES["METRICS_FINALIZE"]: (),
    JOB_TYPES["REMINDER_RECOVERY"]: (),
    JOB_TYPES["ANALYSIS"]: (),
    JOB_TYPES["MEMORY_EXTRACTION"]: (),
    JOB_TYPES["DAILY_CONTEXT"]: (),
    JOB_TYPES["CAREGIVER_NOTIFICATIONS"]: (JOB_TYPES["ANALYSIS"],),
    JOB_TYPES["INTEREST_DISCOVERY"]: (JOB_TYPES["MEMORY_EXTRACTION"],),
    JOB_TYPES["SNAPSHOT_REBUILD"]: (
        JOB_TYPES["MEMORY_EXTRACTION"],
        JOB_TYPES["DAILY_CONTEXT"],
    ),
}

JOB_PRIORITIES = {
    JOB_TYPES["REMINDER_RECOVERY"]: 100,
    JOB_TYPES["METRICS_FINALIZE"]: 90,
    JOB_TYPES["ANALYSIS"]: 60,
    JOB_TYPES["MEMORY_EXTRACTION"]: 60,
    JOB_TYPES["DAILY_CONTEXT"]: 50,
    JOB_TYPES["CAREGIVER_NOTIFICATIONS"]: 40,
    JOB_TYPES["INTEREST_DISCOVERY"]: 30,
    JOB_TYPES["SNAPSHOT_REBUILD"]: 20,
}

MAX_ATTEMPTS = {
    JOB_TYPES["CAREGIVER_NOTIFICATIONS"]: 3,
    JOB_TYPES["REMINDER_RECOVERY"]: 3,
    JOB_TYPES["METRICS_FINALIZE"]: 4,
}


@dataclass(frozen=True)
class PostCallJobSpec:
    conversation_id: str | None
    call_sid: str
    senior_id: str | None
    job_type: str
    priority: int
    dedupe_key: str
    depends_on_types: tuple[str, ...]
    max_attempts: int


def post_call_queue_enabled() -> bool:
    return bool(get_settings().post_call_queue_enabled)


def build_post_call_dedupe_key(call_sid: str, job_type: str) -> str:
    call_sid = str(call_sid or "").strip()
    job_type = str(job_type or "").strip()
    if not call_sid:
        raise ValueError("call_sid is required")
    if job_type not in JOB_GRAPH:
        raise ValueError(f"unknown post-call job type: {job_type}")
    return f"post-call:{call_sid}:{job_type}"


def build_post_call_job_specs(
    *,
    conversation_id: str | None,
    call_sid: str,
    senior_id: str | None,
    job_types: tuple[str, ...] = JOB_ORDER,
) -> list[PostCallJobSpec]:
    selected = tuple(job_type for job_type in JOB_ORDER if job_type in set(job_types))
    specs: list[PostCallJobSpec] = []
    for job_type in selected:
        specs.append(
            PostCallJobSpec(
                conversation_id=conversation_id,
                call_sid=call_sid,
                senior_id=senior_id,
                job_type=job_type,
                priority=JOB_PRIORITIES.get(job_type, 0),
                dedupe_key=build_post_call_dedupe_key(call_sid, job_type),
                depends_on_types=tuple(dep for dep in JOB_GRAPH[job_type] if dep in selected),
                max_attempts=MAX_ATTEMPTS.get(job_type, 5),
            )
        )
    return specs


async def _upsert_post_call_job(
    spec: PostCallJobSpec,
    *,
    depends_on_ids: list[str],
) -> dict[str, Any]:
    row = await query_one(
        """
        INSERT INTO post_call_jobs (
            conversation_id,
            call_sid,
            senior_id,
            job_type,
            status,
            priority,
            dedupe_key,
            payload_encrypted,
            depends_on,
            attempt_count,
            max_attempts,
            run_after,
            created_at,
            updated_at
        )
        VALUES (
            $1, $2, $3, $4, 'queued', $5, $6, NULL, $7::uuid[],
            0, $8, NOW(), NOW(), NOW()
        )
        ON CONFLICT (dedupe_key) DO UPDATE SET
            conversation_id = COALESCE(post_call_jobs.conversation_id, EXCLUDED.conversation_id),
            senior_id = COALESCE(post_call_jobs.senior_id, EXCLUDED.senior_id),
            depends_on = EXCLUDED.depends_on,
            max_attempts = EXCLUDED.max_attempts,
            updated_at = EXCLUDED.updated_at
        RETURNING id, job_type, depends_on
        """,
        spec.conversation_id,
        spec.call_sid,
        spec.senior_id,
        spec.job_type,
        spec.priority,
        spec.dedupe_key,
        depends_on_ids,
        spec.max_attempts,
    )
    return row or {}


async def enqueue_post_call_job_graph(
    *,
    conversation_id: str | None,
    call_sid: str,
    senior_id: str | None,
    job_types: tuple[str, ...] = JOB_ORDER,
) -> list[dict[str, Any]]:
    specs = build_post_call_job_specs(
        conversation_id=conversation_id,
        call_sid=call_sid,
        senior_id=senior_id,
        job_types=job_types,
    )
    by_type: dict[str, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []
    for spec in specs:
        depends_on_ids = [
            str(by_type[dep]["id"])
            for dep in spec.depends_on_types
            if by_type.get(dep, {}).get("id")
        ]
        row = await _upsert_post_call_job(spec, depends_on_ids=depends_on_ids)
        by_type[spec.job_type] = row
        rows.append(row)
    return rows


async def maybe_enqueue_post_call_job_graph(
    *,
    conversation_id: str | None,
    call_sid: str,
    senior_id: str | None,
) -> list[dict[str, Any]]:
    if not post_call_queue_enabled():
        return []
    if not call_sid or call_sid == "unknown":
        return []
    rows = await enqueue_post_call_job_graph(
        conversation_id=conversation_id,
        call_sid=call_sid,
        senior_id=senior_id,
    )
    logger.info(
        "[{cs}] Enqueued post-call job graph",
        cs=call_sid,
        jobs=len(rows),
    )
    return rows
