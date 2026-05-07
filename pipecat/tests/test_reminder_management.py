"""Tests for voice-driven reminder + schedule item creation."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.reminder_management import (
    _build_schedule_item,
    create_reminder,
)


class TestScheduleItemShape:
    def test_weekly_item_uses_recurring_frequency_and_int_days(self):
        item = _build_schedule_item(
            reminder_id="rem-123",
            title="Yoga",
            scheduled_time=datetime(2026, 5, 11, 12, 0, tzinfo=timezone.utc),
            timezone_name="America/New_York",
            frequency="weekly",
            recurring_days=[1, 3, 5],
        )
        assert item["frequency"] == "recurring"
        assert item["recurringDays"] == [1, 3, 5]
        assert item["title"] == "Yoga"
        assert item["reminderIds"] == ["rem-123"]
        assert item["createdVia"] == "voice"
        # 12:00 UTC == 08:00 in America/New_York (EDT in May)
        assert item["time"] == "08:00"
        assert "date" not in item

    def test_daily_item_drops_days_and_date(self):
        item = _build_schedule_item(
            reminder_id="rem-1",
            title="Pills",
            scheduled_time=datetime(2026, 5, 12, 14, 30, tzinfo=timezone.utc),
            timezone_name="America/New_York",
            frequency="daily",
            recurring_days=[],
        )
        assert item["frequency"] == "daily"
        assert "recurringDays" not in item
        assert "date" not in item
        assert item["time"] == "10:30"

    def test_one_time_item_includes_iso_date(self):
        item = _build_schedule_item(
            reminder_id="rem-2",
            title="Doctor",
            scheduled_time=datetime(2026, 5, 12, 14, 30, tzinfo=timezone.utc),
            timezone_name="America/New_York",
            frequency="one-time",
            recurring_days=[],
        )
        assert item["frequency"] == "one-time"
        assert item["date"] == "2026-05-12"
        assert "recurringDays" not in item


class TestCreateReminderTransaction:
    @pytest.mark.asyncio
    async def test_writes_reminder_and_appends_schedule_item(self, monkeypatch):
        """Single transaction: INSERT reminder + UPDATE seniors.preferred_call_times."""
        reminder_row = {
            "id": "rem-new",
            "senior_id": "s-1",
            "type": "appointment",
            "title": None,
            "title_encrypted": "enc:fake",
            "description": None,
            "description_encrypted": None,
            "scheduled_time": datetime(2026, 5, 12, 14, 0, tzinfo=timezone.utc),
            "is_recurring": False,
            "cron_expression": None,
            "created_via": "voice",
        }
        senior_row = {
            "preferred_call_times": {"schedule": [{"id": "old", "title": "Existing", "frequency": "daily", "time": "09:00"}], "topicsToAvoid": []},
            "preferred_call_times_encrypted": None,
        }

        executed_updates: list = []

        conn = MagicMock()
        conn.fetchrow = AsyncMock(side_effect=[reminder_row, senior_row])
        conn.execute = AsyncMock(side_effect=lambda sql, *args: executed_updates.append((sql, args)) or "UPDATE 1")

        # asyncpg's transaction context manager.
        tx_ctx = MagicMock()
        tx_ctx.__aenter__ = AsyncMock(return_value=None)
        tx_ctx.__aexit__ = AsyncMock(return_value=None)
        conn.transaction = MagicMock(return_value=tx_ctx)

        pool_ctx = MagicMock()
        pool_ctx.__aenter__ = AsyncMock(return_value=conn)
        pool_ctx.__aexit__ = AsyncMock(return_value=None)
        pool = MagicMock()
        pool.acquire = MagicMock(return_value=pool_ctx)

        async def _get_pool():
            return pool

        monkeypatch.setattr("services.reminder_management.get_pool", _get_pool)
        monkeypatch.setattr("services.reminder_management.encrypt", lambda v: f"enc:{v}" if v else None)
        monkeypatch.setattr(
            "services.reminder_management.encrypt_json",
            lambda v: f"enc-json:{len(v.get('schedule', []))}",
        )

        result = await create_reminder(
            senior_id="s-1",
            reminder_type="appointment",
            title="Doctor",
            description=None,
            scheduled_time=datetime(2026, 5, 12, 14, 0, tzinfo=timezone.utc),
            frequency="one-time",
            recurring_days=None,
            timezone_name="America/New_York",
        )

        assert result["reminder"]["id"] == "rem-new"
        assert result["schedule_item_id"]
        assert len(executed_updates) == 1
        sql, args = executed_updates[0]
        assert "preferred_call_times_encrypted" in sql
        # encrypt_json was called with a dict whose schedule has 2 items
        # (existing + new voice item).
        assert args[0] == "enc-json:2"
        assert args[1] == "s-1"
