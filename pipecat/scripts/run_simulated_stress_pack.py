"""Run advanced LLM-vs-LLM simulated stress calls.

This is the operator-facing runner for the stress scenarios documented in
docs/guides/MOCK_CALL_TESTING.md. It runs the same real Donna pipeline as
run_simulated_demo.py, but executes scenario batches concurrently and prints
PHI-free aggregate results.

Typical Railway dev run:
    railway run --environment dev --service donna-pipecat -- \
      uv run python scripts/run_simulated_stress_pack.py \
        --mode stress-pack --max-concurrent 5 --no-post-call
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PKG_ROOT))

import warnings
warnings.filterwarnings("ignore", category=DeprecationWarning, module="pipecat.audio.utils")

from tests.simulation import (  # noqa: E402
    ConcurrentCallSpec,
    build_cohort_report,
    build_parallel_flake_specs,
    build_post_call_stampede_specs,
    build_reminder_stampede_specs,
    build_stress_pack_specs,
    run_simulated_calls_concurrent,
    scale_2000_load_test_plan,
)
from scripts.run_simulated_demo import SCENARIOS  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run advanced Donna mock-call stress scenarios",
    )
    parser.add_argument(
        "--mode",
        choices=[
            "stress-pack",
            "reminder-stampede",
            "post-call-stampede",
            "flake",
            "scale-2000-plan",
        ],
        default="stress-pack",
        help="Stress run shape",
    )
    parser.add_argument(
        "--scenario",
        choices=sorted(SCENARIOS),
        default="multiple_reminders",
        help="Scenario to repeat for --mode flake",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=20,
        help="Number of calls for stampede/flake modes",
    )
    parser.add_argument(
        "--repetitions",
        type=int,
        default=1,
        help="How many times to repeat the full stress-pack catalog",
    )
    parser.add_argument(
        "--max-concurrent",
        type=int,
        default=5,
        help="Maximum in-flight simulated calls",
    )
    parser.add_argument(
        "--timeout-per-call",
        type=float,
        default=300.0,
        help="Per-call timeout in seconds",
    )
    parser.add_argument(
        "--no-post-call",
        action="store_true",
        help="Skip post-call processing for each simulated call",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON report",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the planned PHI-free scenario list without running calls",
    )
    return parser.parse_args()


def build_specs(args: argparse.Namespace) -> list[ConcurrentCallSpec]:
    if args.mode == "stress-pack":
        return build_stress_pack_specs(repetitions=args.repetitions)
    if args.mode == "reminder-stampede":
        return build_reminder_stampede_specs(args.count)
    if args.mode == "post-call-stampede":
        return build_post_call_stampede_specs(args.count)
    if args.mode == "flake":
        return build_parallel_flake_specs(
            SCENARIOS[args.scenario],
            repetitions=args.count,
        )
    if args.mode == "scale-2000-plan":
        return []
    raise ValueError(f"Unsupported mode: {args.mode}")


def specs_to_plan_dict(
    args: argparse.Namespace,
    specs: list[ConcurrentCallSpec],
) -> dict:
    """Build a PHI-free execution plan for dry runs and docs checks."""
    return {
        "mode": args.mode,
        "planned_calls": len(specs),
        "max_concurrent": args.max_concurrent,
        "run_post_call_processing": not args.no_post_call,
        "specs": [
            {
                "label": spec.label,
                "scenario": spec.scenario.name,
                "call_type": spec.scenario.call_type,
                "max_turns": spec.scenario.max_turns,
                "expected_tool_calls": list(spec.scenario.expect_tool_calls),
            }
            for spec in specs
        ],
    }


def require_live_env() -> None:
    missing = [
        name
        for name in ("ANTHROPIC_API_KEY", "DATABASE_URL")
        if not os.getenv(name)
    ]
    if missing:
        print(
            "ERROR: missing required env vars: " + ", ".join(missing),
            file=sys.stderr,
        )
        sys.exit(2)


def summary_to_dict(args: argparse.Namespace, summary, report) -> dict:
    failures = [
        {
            "label": outcome.label,
            "scenario": outcome.scenario_name,
            "error": outcome.error,
        }
        for outcome in summary.outcomes
        if outcome.error
    ]
    return {
        "mode": args.mode,
        "started": summary.started,
        "completed": summary.completed,
        "failed": summary.failed,
        "duration_seconds": round(summary.duration_seconds, 3),
        "max_concurrent": args.max_concurrent,
        "run_post_call_processing": not args.no_post_call,
        "report": report.to_dict(),
        "failures": failures,
    }


def print_human_report(payload: dict) -> None:
    report = payload["report"]
    print("\nSimulated Stress Run")
    print("--------------------")
    print(f"mode                 : {payload['mode']}")
    print(f"started/completed    : {payload['started']}/{payload['completed']}")
    print(f"failed               : {payload['failed']}")
    print(f"duration             : {payload['duration_seconds']}s")
    print(f"max concurrent       : {payload['max_concurrent']}")
    print(f"post-call processing : {payload['run_post_call_processing']}")
    print(f"setup success rate   : {report['setup_success_rate']:.3f}")
    print(f"first response p95   : {report['first_response_p95_ms']}")
    print(f"avg turns            : {report['avg_turns']:.2f}")
    print(f"tool calls           : {report['tool_call_distribution']}")
    print(f"end reasons          : {report['end_reason_distribution']}")
    print(f"scenarios            : {report['scenario_distribution']}")
    if payload["failures"]:
        print(f"failures             : {payload['failures']}")


def print_plan(payload: dict) -> None:
    print("\nPlanned Simulated Stress Calls")
    print("------------------------------")
    print(f"mode                 : {payload['mode']}")
    print(f"planned calls        : {payload['planned_calls']}")
    print(f"max concurrent       : {payload['max_concurrent']}")
    print(f"post-call processing : {payload['run_post_call_processing']}")
    for spec in payload["specs"]:
        tools = ", ".join(spec["expected_tool_calls"]) or "(none)"
        print(
            f"- {spec['label']}: {spec['scenario']} "
            f"({spec['call_type']}, max_turns={spec['max_turns']}, tools={tools})"
        )


async def main() -> None:
    args = parse_args()

    if args.mode == "scale-2000-plan":
        payload = {
            "mode": args.mode,
            "plan": scale_2000_load_test_plan(),
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return

    specs = build_specs(args)
    if args.dry_run:
        payload = specs_to_plan_dict(args, specs)
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print_plan(payload)
        return

    require_live_env()
    print(
        f"Running {len(specs)} simulated calls "
        f"(mode={args.mode}, max_concurrent={args.max_concurrent})",
        file=sys.stderr if args.json else sys.stdout,
    )
    summary = await run_simulated_calls_concurrent(
        specs,
        max_concurrent=args.max_concurrent,
        timeout_per_call=args.timeout_per_call,
        run_post_call_processing=not args.no_post_call,
    )
    report = build_cohort_report(args.mode, summary.outcomes)
    payload = summary_to_dict(args, summary, report)

    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print_human_report(payload)

    if summary.failed:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
