"""Unit coverage for the advanced stress-pack runner.

These tests intentionally avoid live LLM calls. The opt-in live coverage lives
in ``test_live_stress_simulation.py`` and is guarded by env vars.
"""

from __future__ import annotations

import argparse
import asyncio
import json

import pytest

from scripts import run_simulated_stress_pack as stress_cli
from tests.simulation import STRESS_SCENARIO_FACTORIES


def _args(**overrides) -> argparse.Namespace:
    defaults = {
        "mode": "stress-pack",
        "scenario": "multiple_reminders",
        "count": 20,
        "repetitions": 1,
        "max_concurrent": 5,
        "timeout_per_call": 300.0,
        "no_post_call": True,
        "json": False,
        "dry_run": False,
    }
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def test_build_specs_supports_all_advanced_stress_modes():
    stress_specs = stress_cli.build_specs(_args(mode="stress-pack", repetitions=2))
    reminder_specs = stress_cli.build_specs(_args(mode="reminder-stampede", count=7))
    post_call_specs = stress_cli.build_specs(_args(mode="post-call-stampede", count=6))
    flake_specs = stress_cli.build_specs(
        _args(mode="flake", scenario="multiple_reminders", count=4)
    )

    assert len(stress_specs) == len(STRESS_SCENARIO_FACTORIES) * 2
    assert len({spec.label for spec in stress_specs}) == len(stress_specs)
    assert [spec.label for spec in reminder_specs] == [
        f"reminder-stampede-{index:04d}" for index in range(1, 8)
    ]
    assert [spec.label for spec in post_call_specs] == [
        f"post-call-stampede-{index:04d}" for index in range(1, 7)
    ]
    assert [spec.scenario.name for spec in flake_specs] == [
        "multiple_reminders",
        "multiple_reminders",
        "multiple_reminders",
        "multiple_reminders",
    ]


def test_dry_run_plan_is_phi_free_and_describes_expected_tools():
    args = _args(mode="reminder-stampede", count=3, max_concurrent=2)
    specs = stress_cli.build_specs(args)
    plan = stress_cli.specs_to_plan_dict(args, specs)

    assert plan["planned_calls"] == 3
    assert plan["max_concurrent"] == 2
    assert plan["run_post_call_processing"] is False
    assert plan["specs"][0] == {
        "label": "reminder-stampede-0001",
        "scenario": "multiple_reminders",
        "call_type": "reminder",
        "max_turns": specs[0].scenario.max_turns,
        "expected_tool_calls": ["mark_reminder_acknowledged"],
    }
    assert "senior" not in json.dumps(plan).lower()
    assert "phone" not in json.dumps(plan).lower()


def test_scale_2000_plan_mode_does_not_require_live_env(monkeypatch, capsys):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(
        stress_cli,
        "parse_args",
        lambda: _args(mode="scale-2000-plan", json=True),
    )

    asyncio.run(stress_cli.main())

    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "scale-2000-plan"
    assert payload["plan"]["target_concurrent_users"] == 2000
    assert payload["plan"]["primary_track"] == "locust_websocket_load"


def test_live_modes_require_vendor_and_database_env(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(SystemExit) as exc:
        stress_cli.require_live_env()

    assert exc.value.code == 2
