import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from api.routes.telnyx import TelnyxOutboundCallRequest


FIXTURE_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "telnyx-outbound"


def load_fixture(name: str) -> dict:
    with (FIXTURE_DIR / f"{name}.json").open() as fixture_file:
        return json.load(fixture_file)


@pytest.mark.parametrize("fixture_name", ["check-in", "reminder-prewarmed"])
def test_node_outbound_call_contract_payloads_parse_in_pipecat(fixture_name: str):
    payload = load_fixture(fixture_name)

    request = TelnyxOutboundCallRequest.model_validate(payload)
    serialized = request.model_dump(by_alias=True, mode="json", exclude_none=True)

    assert request.senior_id == payload["seniorId"]
    assert request.call_type == payload["callType"]
    assert serialized["seniorId"] == payload["seniorId"]
    assert serialized["callType"] == payload["callType"]

    if "prewarmedContext" in payload:
        prewarmed = request.prewarmed_context
        assert prewarmed is not None
        assert prewarmed.senior_id == payload["prewarmedContext"]["seniorId"]
        assert prewarmed.call_type == payload["prewarmedContext"]["callType"]
        assert prewarmed.hydrated_context.memory_context == "Enjoys daily walks."
        assert serialized["prewarmedContext"]["hydratedContext"]["memoryContext"] == "Enjoys daily walks."


def test_node_outbound_call_contract_rejects_missing_senior_id():
    payload = load_fixture("check-in")
    payload.pop("seniorId")

    with pytest.raises(ValidationError):
        TelnyxOutboundCallRequest.model_validate(payload)


def test_node_outbound_call_contract_accepts_queue_reservation_fields():
    payload = load_fixture("check-in")
    payload["queueId"] = "queue-1"
    payload["reservationId"] = "reservation-1"

    request = TelnyxOutboundCallRequest.model_validate(payload)
    serialized = request.model_dump(by_alias=True, mode="json", exclude_none=True)

    assert request.queue_id == "queue-1"
    assert request.reservation_id == "reservation-1"
    assert serialized["queueId"] == "queue-1"
    assert serialized["reservationId"] == "reservation-1"
