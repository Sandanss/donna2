"""Tests for services/reminder_delivery.py — delivery CRUD + prompt formatting."""

import pytest
from datetime import datetime, timezone
from unittest.mock import patch, AsyncMock


class TestMarkDelivered:
    @pytest.mark.asyncio
    async def test_executes_update_query(self):
        with patch("services.reminder_delivery.execute", new_callable=AsyncMock) as mock_exec:
            from services.reminder_delivery import mark_delivered
            await mark_delivered("rem-001")
            mock_exec.assert_called_once()
            assert "UPDATE reminders" in mock_exec.call_args[0][0]
            assert mock_exec.call_args[0][1] == "rem-001"


class TestReminderDeliveryKey:
    def test_builds_id_only_key_at_minute_precision(self):
        from services.reminder_delivery import build_reminder_delivery_key

        key = build_reminder_delivery_key(
            "rem-001",
            datetime(2035, 3, 11, 13, 30, 45, 123456, tzinfo=timezone.utc),
        )

        assert key == "reminder_delivery:rem-001:2035-03-11T13:30"


class TestCreateOrUpdateDeliveryForCall:
    @pytest.mark.asyncio
    async def test_inserts_with_delivery_key_idempotency(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value={"id": "del-001"}) as mock_query:
            from services.reminder_delivery import create_or_update_delivery_for_call

            result = await create_or_update_delivery_for_call(
                reminder_id="rem-001",
                scheduled_for=datetime(2035, 3, 11, 13, 30),
                call_sid="call-001",
            )

            assert result == {"id": "del-001"}
            sql = mock_query.call_args[0][0]
            assert "delivery_key" in sql
            assert "ON CONFLICT (delivery_key)" in sql
            assert mock_query.call_args[0][4] == "reminder_delivery:rem-001:2035-03-11T13:30"

    @pytest.mark.asyncio
    async def test_existing_delivery_backfills_delivery_key(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value={"id": "del-001"}) as mock_query:
            from services.reminder_delivery import create_or_update_delivery_for_call

            await create_or_update_delivery_for_call(
                reminder_id="rem-001",
                scheduled_for=datetime(2035, 3, 11, 13, 30),
                call_sid="call-001",
                existing_delivery_id="del-001",
            )

            sql = mock_query.call_args[0][0]
            assert "delivery_key = COALESCE(delivery_key, $3)" in sql
            assert mock_query.call_args[0][3] == "reminder_delivery:rem-001:2035-03-11T13:30"


class TestMarkReminderAcknowledged:
    @pytest.mark.asyncio
    async def test_returns_none_for_empty_delivery_id(self):
        from services.reminder_delivery import mark_reminder_acknowledged
        assert await mark_reminder_acknowledged("", "acknowledged", "ok") is None

    @pytest.mark.asyncio
    async def test_returns_none_for_none_delivery_id(self):
        from services.reminder_delivery import mark_reminder_acknowledged
        assert await mark_reminder_acknowledged(None, "acknowledged", "ok") is None

    @pytest.mark.asyncio
    async def test_returns_none_for_invalid_status(self):
        from services.reminder_delivery import mark_reminder_acknowledged
        assert await mark_reminder_acknowledged("del-001", "invalid", "ok") is None

    @pytest.mark.asyncio
    async def test_accepts_acknowledged(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value={"id": "del-001", "status": "acknowledged"}):
            from services.reminder_delivery import mark_reminder_acknowledged
            result = await mark_reminder_acknowledged("del-001", "acknowledged", "I'll take it")
            assert result is not None

    @pytest.mark.asyncio
    async def test_accepts_confirmed(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value={"id": "del-001", "status": "confirmed"}):
            from services.reminder_delivery import mark_reminder_acknowledged
            result = await mark_reminder_acknowledged("del-001", "confirmed", "already took it")
            assert result is not None

    @pytest.mark.asyncio
    async def test_returns_none_on_db_error(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, side_effect=Exception("DB error")):
            from services.reminder_delivery import mark_reminder_acknowledged
            assert await mark_reminder_acknowledged("del-001", "acknowledged", "ok") is None


class TestMarkCallEndedWithoutAcknowledgment:
    @pytest.mark.asyncio
    async def test_noop_for_empty_id(self):
        from services.reminder_delivery import mark_call_ended_without_acknowledgment
        await mark_call_ended_without_acknowledgment("")

    @pytest.mark.asyncio
    async def test_noop_for_none_id(self):
        from services.reminder_delivery import mark_call_ended_without_acknowledgment
        await mark_call_ended_without_acknowledgment(None)

    @pytest.mark.asyncio
    async def test_skips_if_acknowledged(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value={"id": "d1", "status": "acknowledged", "attempt_count": 1}), \
             patch("services.reminder_delivery.execute", new_callable=AsyncMock) as mock_exec:
            from services.reminder_delivery import mark_call_ended_without_acknowledgment
            await mark_call_ended_without_acknowledgment("d1")
            mock_exec.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_if_confirmed(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value={"id": "d1", "status": "confirmed", "attempt_count": 1}), \
             patch("services.reminder_delivery.execute", new_callable=AsyncMock) as mock_exec:
            from services.reminder_delivery import mark_call_ended_without_acknowledgment
            await mark_call_ended_without_acknowledgment("d1")
            mock_exec.assert_not_called()

    @pytest.mark.asyncio
    async def test_retry_pending_if_attempts_lt_2(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value={"id": "d1", "status": "delivered", "attempt_count": 1}), \
             patch("services.reminder_delivery.execute", new_callable=AsyncMock) as mock_exec:
            from services.reminder_delivery import mark_call_ended_without_acknowledgment
            await mark_call_ended_without_acknowledgment("d1")
            assert mock_exec.call_args[0][1] == "retry_pending"

    @pytest.mark.asyncio
    async def test_max_attempts_if_attempts_gte_2(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value={"id": "d1", "status": "delivered", "attempt_count": 2}), \
             patch("services.reminder_delivery.execute", new_callable=AsyncMock) as mock_exec:
            from services.reminder_delivery import mark_call_ended_without_acknowledgment
            await mark_call_ended_without_acknowledgment("d1")
            assert mock_exec.call_args[0][1] == "max_attempts"

    @pytest.mark.asyncio
    async def test_delivery_not_found(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value=None), \
             patch("services.reminder_delivery.execute", new_callable=AsyncMock) as mock_exec:
            from services.reminder_delivery import mark_call_ended_without_acknowledgment
            await mark_call_ended_without_acknowledgment("d-999")
            mock_exec.assert_not_called()


class TestWaitForReminderByCallSid:
    @pytest.mark.asyncio
    async def test_returns_delayed_row(self):
        row = {"delivery_id": "d1", "reminder_id": "r1", "title": "Water plants"}
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, side_effect=[None, row]) as mock_query:
            from services.reminder_delivery import wait_for_reminder_by_call_sid

            result = await wait_for_reminder_by_call_sid(
                "CA-delayed",
                timeout_seconds=0.1,
                initial_delay_seconds=0,
                max_delay_seconds=0,
            )

            assert result == row
            assert mock_query.await_count == 2

    @pytest.mark.asyncio
    async def test_returns_none_when_timeout_expires(self):
        with patch("services.reminder_delivery.query_one", new_callable=AsyncMock, return_value=None) as mock_query:
            from services.reminder_delivery import wait_for_reminder_by_call_sid

            result = await wait_for_reminder_by_call_sid("CA-missing", timeout_seconds=0)

            assert result is None
            assert mock_query.await_count == 1


class TestCreateOrUpdateDeliveryIdempotency:
    """Category F: lifecycle idempotency on reminder_deliveries."""

    @pytest.mark.asyncio
    async def test_create_or_update_delivery_idempotent_on_duplicate_key(self):
        """Two writes with the same delivery_key: 2nd must UPDATE (not INSERT)
        and the row's attempt_count must increment correctly.

        The implementation uses a single INSERT...ON CONFLICT (delivery_key)
        DO UPDATE statement; a duplicate key triggers the UPDATE branch in
        the same statement, returning the existing row id with attempt_count
        incremented by 1.
        """
        from datetime import datetime
        from services.reminder_delivery import create_or_update_delivery_for_call

        scheduled = datetime(2035, 3, 11, 13, 30)

        # Simulate Postgres' ON CONFLICT path: first call inserts a fresh row
        # (attempt_count=1), second call hits the conflict and updates with
        # attempt_count incremented to 2.
        responses = [
            {"id": "del-001", "reminder_id": "rem-001", "status": "delivered", "attempt_count": 1},
            {"id": "del-001", "reminder_id": "rem-001", "status": "delivered", "attempt_count": 2},
        ]

        with patch(
            "services.reminder_delivery.query_one",
            new_callable=AsyncMock,
            side_effect=responses,
        ) as mock_query:
            first = await create_or_update_delivery_for_call(
                reminder_id="rem-001",
                scheduled_for=scheduled,
                call_sid="call-001",
            )
            second = await create_or_update_delivery_for_call(
                reminder_id="rem-001",
                scheduled_for=scheduled,
                call_sid="call-002",
            )

        # Both calls hit the same INSERT...ON CONFLICT statement.
        assert mock_query.await_count == 2
        for call in mock_query.await_args_list:
            sql_text = call.args[0]
            assert "INSERT INTO reminder_deliveries" in sql_text
            assert "ON CONFLICT (delivery_key)" in sql_text
            # The UPDATE branch must increment attempt_count using COALESCE.
            assert "attempt_count = COALESCE(reminder_deliveries.attempt_count, 0) + 1" in sql_text

        # delivery_key in both calls must be identical (same reminder + minute).
        first_key = mock_query.await_args_list[0].args[4]
        second_key = mock_query.await_args_list[1].args[4]
        assert first_key == second_key == "reminder_delivery:rem-001:2035-03-11T13:30"

        # The simulated DB returns the SAME row id (not a new insert) and
        # attempt_count climbs monotonically.
        assert first["id"] == second["id"] == "del-001"
        assert first["attempt_count"] == 1
        assert second["attempt_count"] == 2


class TestFormatReminderPrompt:
    def test_basic_reminder(self):
        from services.reminder_delivery import format_reminder_prompt
        result = format_reminder_prompt({"title": "Water the porch plants", "type": "generic"})
        assert "Water the porch plants" in result
        assert "IMPORTANT REMINDER" in result

    def test_household_type_uses_generic_prompt(self):
        from services.reminder_delivery import format_reminder_prompt
        result = format_reminder_prompt({"title": "Put out the recycling", "type": "household"})
        assert "Put out the recycling" in result
        assert "important reminder" in result.lower()

    def test_social_type_uses_generic_prompt(self):
        from services.reminder_delivery import format_reminder_prompt
        result = format_reminder_prompt({"title": "Bridge club", "type": "social"})
        assert "Bridge club" in result
        assert "important reminder" in result.lower()

    def test_includes_description(self):
        from services.reminder_delivery import format_reminder_prompt
        result = format_reminder_prompt({
            "title": "Bring club snack",
            "description": "for bridge club",
            "type": "social",
        })
        assert "for bridge club" in result

    def test_no_description(self):
        from services.reminder_delivery import format_reminder_prompt
        result = format_reminder_prompt({"title": "Call Maria"})
        assert "naturally" in result.lower()
