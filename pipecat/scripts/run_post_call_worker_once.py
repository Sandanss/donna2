#!/usr/bin/env python3
"""Run one Pipecat post-call worker tick with PHI-safe output."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from services.post_call_job_worker import run_post_call_worker_once
from services.post_call_jobs import JOB_TYPES


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lease and execute post_call_jobs rows using Pipecat handlers."
    )
    parser.add_argument("--confirm-db-writes", action="store_true")
    parser.add_argument("--worker-id", default=f"pipecat-post-call-{os.getpid()}")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--lease-seconds", type=int, default=120)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--job-types", default="")
    return parser.parse_args(argv)


async def _main(argv: list[str]) -> int:
    args = _parse_args(argv)
    if not args.confirm_db_writes:
        print(json.dumps({
            "ok": False,
            "error": "--confirm-db-writes is required because this command mutates post_call_jobs rows",
            "phi_policy": {"output_contains_raw_phi": False},
        }, indent=2))
        return 2
    if not os.getenv("DATABASE_URL"):
        print(json.dumps({
            "ok": False,
            "error": "DATABASE_URL is required",
            "phi_policy": {"output_contains_raw_phi": False},
        }, indent=2))
        return 2

    requested = [
        value.strip()
        for value in args.job_types.split(",")
        if value.strip()
    ]
    invalid = [value for value in requested if value not in JOB_TYPES.values()]
    if invalid:
        print(json.dumps({
            "ok": False,
            "error": f"unknown job types: {', '.join(invalid)}",
            "allowed_job_types": sorted(JOB_TYPES.values()),
            "phi_policy": {"output_contains_raw_phi": False},
        }, indent=2))
        return 2

    result = await run_post_call_worker_once(
        worker_id=args.worker_id,
        limit=args.limit,
        lease_seconds=args.lease_seconds,
        concurrency=args.concurrency,
        job_types=requested,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main(sys.argv[1:])))
