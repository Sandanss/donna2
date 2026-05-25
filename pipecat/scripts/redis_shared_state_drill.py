#!/usr/bin/env python3
"""PHI-free Redis/shared-state readiness drill for scaled Pipecat mode."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from loguru import logger

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _configure_quiet_logs() -> None:
    logger.remove()
    logger.add(sys.stderr, level="ERROR")


def _safe_health(label: str, health: dict) -> dict:
    return {
        "label": label,
        "ok": bool(health.get("ok")),
        "required": bool(health.get("required")),
        "configured": bool(health.get("configured")),
        "backend": health.get("backend"),
        "shared": bool(health.get("shared")),
        "available": bool(health.get("available")),
        "degraded": bool(health.get("degraded")),
        "error": health.get("error"),
    }


async def _check(label: str) -> dict:
    from lib.redis_client import check_shared_state_health, reset_shared_state_for_tests

    reset_shared_state_for_tests()
    return _safe_health(label, await check_shared_state_health())


async def run_drill(simulate_outage: bool = False) -> dict:
    actual = await _check("actual")
    checks = [actual]
    simulated_fail_closed = None

    if simulate_outage:
        previous = {key: os.environ.get(key) for key in [
            "REDIS_URL",
            "UPSTASH_REDIS_REST_URL",
            "UPSTASH_REDIS_REST_TOKEN",
            "PIPECAT_REQUIRE_REDIS",
        ]}
        try:
            os.environ.pop("REDIS_URL", None)
            os.environ["UPSTASH_REDIS_REST_URL"] = "https://127.0.0.1:1"
            os.environ["UPSTASH_REDIS_REST_TOKEN"] = "drill-token"
            os.environ["PIPECAT_REQUIRE_REDIS"] = "true"
            simulated = await _check("simulated_outage")
            checks.append(simulated)
            simulated_fail_closed = (
                simulated["required"]
                and simulated["configured"]
                and simulated["shared"]
                and not simulated["available"]
                and not simulated["ok"]
                and simulated["error"] in {"shared_state_unreachable", "shared_state_not_available"}
            )
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    actual_ready = (
        bool(actual["ok"])
        and (not simulate_outage or (bool(actual["shared"]) and bool(actual["available"])))
    )
    return {
        "ok": actual_ready and (simulated_fail_closed is not False),
        "checkedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "actualSharedRequired": bool(simulate_outage),
        "simulatedFailClosed": simulated_fail_closed,
        "phiPolicy": {
            "outputContainsRawPhi": False,
            "notes": "Only backend readiness booleans and coarse error codes are printed.",
        },
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a PHI-free Redis/shared-state readiness drill.")
    parser.add_argument(
        "--simulate-outage",
        action="store_true",
        help="Also verify scaled mode fails closed when shared state is unreachable.",
    )
    args = parser.parse_args()

    _configure_quiet_logs()
    result = asyncio.run(run_drill(simulate_outage=args.simulate_outage))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
