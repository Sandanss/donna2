"""Telnyx Call Control routes.

This path keeps Donna's core voice pipeline in high-quality linear PCM and only
uses Telnyx-specific codecs at the WebSocket edge.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import aiohttp
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field

from api.middleware.auth import require_service_api_key
from api.routes.call_context import (
    _cleanup_metadata,
    _hydrate_senior_call_context,
    _metadata_lock,
    _persist_metadata,
    _senior_is_inactive,
    call_metadata,
)
from config import get_pipecat_public_url, get_settings, is_production_environment
from lib.sanitize import mask_phone
from lib.telnyx_audio import DEFAULT_TELNYX_AUDIO_PROFILE, resolve_telnyx_audio_profile

router = APIRouter()

TELNYX_DEFAULT_STREAM_CODEC = DEFAULT_TELNYX_AUDIO_PROFILE.codec
TELNYX_DEFAULT_STREAM_SAMPLE_RATE = DEFAULT_TELNYX_AUDIO_PROFILE.sample_rate
TELNYX_EVENT_DEDUPE_TTL_SECONDS = 600
TELNYX_PREWARM_TTL_SECONDS = 600
TELNYX_PREWARM_SCHEDULE_TOLERANCE_SECONDS = 60

_TERMINAL_EVENTS = {
    "call.hangup",
    "call.completed",
    "call.failed",
    "call.no_answer",
    "call.busy",
}
_AMD_EVENTS = {
    "call.machine.detection.ended",
    "call.machine.greeting.ended",
    "call.machine.premium.detection.ended",
    "call.machine.premium.greeting.ended",
}
_AMD_ALLOWED_MODES = {"premium", "detect", "detect_beep", "detect_words", "greeting_end"}
_AMD_DISABLED_VALUES = {"", "0", "false", "no", "off", "none", "disabled", "disable"}
_AMD_HUMAN_RESULTS = {"human", "human_residence", "human_business", "not_sure", "silence"}
_AMD_MACHINE_RESULTS = {"machine", "beep_detected", "ended", "no_beep_detected"}
_AMD_HANGUP_RESULTS = {"fax_detected"}
_recent_telnyx_event_ids: dict[str, float] = {}
_telnyx_event_lock = asyncio.Lock()


class TelnyxOutboundCallRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    senior_id: str = Field(alias="seniorId")
    call_type: str = Field(default="check-in", alias="callType")
    reminder_id: str | None = Field(default=None, alias="reminderId")
    reminder_ids: list[str] | None = Field(default=None, alias="reminderIds")
    context_notes: str | None = Field(default=None, alias="contextNotes")
    scheduled_for: datetime | None = Field(default=None, alias="scheduledFor")
    existing_delivery_id: str | None = Field(default=None, alias="existingDeliveryId")
    prewarmed_context: "TelnyxPrewarmedOutboundContext | None" = Field(
        default=None,
        alias="prewarmedContext",
    )


class TelnyxPrewarmedHydratedContext(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    memory_context: str | None = Field(default=None, alias="memoryContext")
    pre_generated_greeting: str | None = Field(default=None, alias="preGeneratedGreeting")
    news_context: str | None = Field(default=None, alias="newsContext")
    recent_turns: str | None = Field(default=None, alias="recentTurns")
    previous_calls_summary: str | None = Field(default=None, alias="previousCallsSummary")
    todays_context: str | None = Field(default=None, alias="todaysContext")
    last_call_analysis: Any = Field(default=None, alias="lastCallAnalysis")
    call_settings: dict[str, Any] | None = Field(default=None, alias="callSettings")
    caregiver_notes_content: list[Any] | None = Field(default=None, alias="caregiverNotesContent")


class TelnyxPrewarmedOutboundContext(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    version: int = 1
    senior_id: str = Field(alias="seniorId")
    call_type: str = Field(alias="callType")
    reminder_id: str | None = Field(default=None, alias="reminderId")
    scheduled_for: datetime | None = Field(default=None, alias="scheduledFor")
    warmed_at: datetime = Field(alias="warmedAt")
    expires_at: datetime = Field(alias="expiresAt")
    context_seed_source: str = Field(alias="contextSeedSource")
    hydrated_context: TelnyxPrewarmedHydratedContext = Field(alias="hydratedContext")


TelnyxOutboundCallRequest.model_rebuild()


def _format_phone_for_call(phone: str) -> str:
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    if not digits:
        return ""
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if str(phone or "").startswith("+"):
        return str(phone)
    return f"+{digits}"


def _telnyx_headers() -> dict[str, str]:
    cfg = get_settings()
    if not cfg.telnyx_api_key:
        raise HTTPException(status_code=500, detail="Telnyx API key is not configured")
    return {
        "Authorization": f"Bearer {cfg.telnyx_api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _public_base_url() -> str:
    base_url = get_pipecat_public_url()
    if not base_url:
        raise HTTPException(status_code=500, detail="PIPECAT_PUBLIC_URL is not configured")
    return base_url.rstrip("/")


def _telnyx_event_url() -> str:
    return f"{_public_base_url()}/telnyx/events"


def _telnyx_stream_url(ws_token: str) -> str:
    ws_base = _public_base_url().replace("https://", "wss://").replace("http://", "ws://")
    return f"{ws_base}/ws?{urlencode({'ws_token': ws_token})}"


def _telnyx_stream_options(ws_token: str) -> dict[str, Any]:
    profile = resolve_telnyx_audio_profile(get_settings())
    return {
        "stream_url": _telnyx_stream_url(ws_token),
        "stream_auth_token": ws_token,
        "stream_track": profile.stream_track,
        "stream_codec": profile.codec,
        "stream_bidirectional_mode": profile.bidirectional_mode,
        "stream_bidirectional_codec": profile.codec,
        "stream_bidirectional_sampling_rate": profile.sample_rate,
        "stream_bidirectional_target_legs": profile.bidirectional_target_legs,
    }


def _telnyx_amd_mode() -> str:
    mode = str(get_settings().telnyx_answering_machine_detection or "").strip().lower()
    if mode in _AMD_DISABLED_VALUES:
        return ""
    if mode not in _AMD_ALLOWED_MODES:
        logger.warning("Ignoring invalid Telnyx AMD mode mode={mode}", mode=mode)
        return ""
    return mode


def _telnyx_amd_dial_fields() -> dict[str, Any]:
    cfg = get_settings()
    mode = _telnyx_amd_mode()
    if not mode:
        return {}

    fields: dict[str, Any] = {"answering_machine_detection": mode}
    amd_config: dict[str, int] = {}
    if cfg.telnyx_amd_total_analysis_time_millis > 0:
        amd_config["total_analysis_time_millis"] = cfg.telnyx_amd_total_analysis_time_millis
    if cfg.telnyx_amd_greeting_total_analysis_time_millis > 0:
        amd_config["greeting_total_analysis_time_millis"] = cfg.telnyx_amd_greeting_total_analysis_time_millis
    if amd_config:
        fields["answering_machine_detection_config"] = amd_config
    return fields


def _json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _call_settings_from_senior(senior: dict) -> dict[str, Any]:
    from services.seniors import DEFAULT_CALL_SETTINGS

    return {
        **DEFAULT_CALL_SETTINGS,
        **_json_dict(senior.get("call_settings") or {}),
    }


def _cached_senior_context_seed(senior: dict) -> tuple[dict[str, Any], bool]:
    try:
        from services.context_cache import get_cache

        cached = get_cache(str(senior["id"]))
    except Exception:
        return {}, False

    if not cached:
        return {}, False

    return {
        "memory_context": cached.get("memory_context"),
        "pre_generated_greeting": cached.get("greeting"),
        "previous_calls_summary": cached.get("summaries"),
        "recent_turns": cached.get("recent_turns"),
        "news_context": cached.get("news_context"),
    }, True


def _context_seed_from_hydrated_context(hydrated: dict[str, Any]) -> dict[str, Any]:
    return {
        "memory_context": hydrated.get("memory_context"),
        "pre_generated_greeting": hydrated.get("pre_generated_greeting"),
        "previous_calls_summary": hydrated.get("previous_calls_summary"),
        "recent_turns": hydrated.get("recent_turns"),
        "news_context": hydrated.get("news_context"),
    }


def _normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _scheduled_for_matches(a: datetime | None, b: datetime | None) -> bool:
    left = _normalize_datetime(a)
    right = _normalize_datetime(b)
    if left is None or right is None:
        return left is right
    return abs((left - right).total_seconds()) <= TELNYX_PREWARM_SCHEDULE_TOLERANCE_SECONDS


def _coerce_prewarmed_hydrated_context(
    prewarmed_context: TelnyxPrewarmedOutboundContext,
    *,
    senior: dict,
) -> dict[str, Any]:
    hydrated = prewarmed_context.hydrated_context
    caregiver_notes_content = list(hydrated.caregiver_notes_content or [])
    return {
        "memory_context": hydrated.memory_context,
        "pre_generated_greeting": hydrated.pre_generated_greeting,
        "news_context": hydrated.news_context,
        "recent_turns": hydrated.recent_turns,
        "previous_calls_summary": hydrated.previous_calls_summary,
        "todays_context": hydrated.todays_context,
        "last_call_analysis": hydrated.last_call_analysis,
        "call_settings": hydrated.call_settings or _call_settings_from_senior(senior),
        "has_caregiver_notes": bool(caregiver_notes_content),
        "caregiver_notes_content": caregiver_notes_content,
    }


def _validated_prewarmed_context(
    body: TelnyxOutboundCallRequest,
) -> TelnyxPrewarmedOutboundContext | None:
    prewarmed_context = body.prewarmed_context
    if not prewarmed_context:
        return None

    now = datetime.now(timezone.utc)
    expires_at = _normalize_datetime(prewarmed_context.expires_at)
    if not expires_at or expires_at <= now:
        logger.info(
            "Discarding Telnyx prewarmed context senior_id={sid} reason=expired",
            sid=body.senior_id,
        )
        return None

    if prewarmed_context.senior_id != body.senior_id or prewarmed_context.call_type != body.call_type:
        logger.info(
            "Discarding Telnyx prewarmed context senior_id={sid} reason=identity_mismatch",
            sid=body.senior_id,
        )
        return None

    if body.call_type == "reminder":
        if prewarmed_context.reminder_id != body.reminder_id:
            logger.info(
                "Discarding Telnyx prewarmed context senior_id={sid} reason=reminder_mismatch",
                sid=body.senior_id,
            )
            return None
        if not _scheduled_for_matches(prewarmed_context.scheduled_for, body.scheduled_for):
            logger.info(
                "Discarding Telnyx prewarmed context senior_id={sid} reason=scheduled_for_mismatch",
                sid=body.senior_id,
            )
            return None

    if not prewarmed_context.hydrated_context:
        return None

    return prewarmed_context


def _telnyx_command_id(call_control_id: str, action: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"telnyx:{call_control_id}:{action}"))


def _summarize_telnyx_error(body_text: str) -> dict[str, Any]:
    try:
        payload = json.loads(body_text)
    except json.JSONDecodeError:
        return {
            "error_code": "unknown",
            "error_title": "Non-JSON error response",
        }

    errors = payload.get("errors")
    if isinstance(errors, list) and errors:
        first = errors[0] if isinstance(errors[0], dict) else {}
        return {
            "error_code": str(first.get("code") or "unknown"),
            "error_title": str(first.get("title") or "Unknown Telnyx error"),
            "error_detail_present": bool(first.get("detail")),
        }

    return {
        "error_code": "unknown",
        "error_title": "Unstructured Telnyx error",
    }


def _verify_telnyx_signature(raw_body: bytes, request: Request) -> None:
    cfg = get_settings()
    if (
        not is_production_environment()
        and os.getenv("ALLOW_UNSIGNED_TELNYX_WEBHOOKS", "").lower() == "true"
    ):
        return

    public_key = cfg.telnyx_public_key
    signature = request.headers.get("telnyx-signature-ed25519", "")
    timestamp = request.headers.get("telnyx-timestamp", "")
    if not public_key or not signature or not timestamp:
        raise HTTPException(status_code=403, detail="Missing Telnyx signature")

    try:
        now = int(time.time())
        ts = int(timestamp)
        if abs(now - ts) > cfg.telnyx_webhook_tolerance_seconds:
            raise HTTPException(status_code=403, detail="Stale Telnyx signature")

        verifier = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key))
        verifier.verify(
            base64.b64decode(signature),
            timestamp.encode("utf-8") + b"|" + raw_body,
        )
    except HTTPException:
        raise
    except (ValueError, binascii.Error, InvalidSignature) as exc:
        raise HTTPException(status_code=403, detail="Invalid Telnyx signature") from exc


async def _telnyx_post(endpoint: str, payload: dict[str, Any] | None = None) -> dict:
    async with aiohttp.ClientSession() as session:
        async with session.post(endpoint, headers=_telnyx_headers(), json=payload or {}) as response:
            body_text = await response.text()
            if response.status < 200 or response.status >= 300:
                summary = _summarize_telnyx_error(body_text)
                logger.error(
                    "Telnyx API request failed status={status} code={code} title={title} detail_present={detail_present}",
                    status=response.status,
                    code=summary.get("error_code"),
                    title=summary.get("error_title"),
                    detail_present=summary.get("error_detail_present", False),
                )
                raise HTTPException(status_code=502, detail="Telnyx API request failed")
            if not body_text:
                return {}
            return json.loads(body_text)


async def _mark_telnyx_event_seen(event_id: str) -> bool:
    if not event_id:
        return False

    now = time.monotonic()
    async with _telnyx_event_lock:
        expired = [
            existing_id
            for existing_id, seen_at in _recent_telnyx_event_ids.items()
            if now - seen_at > TELNYX_EVENT_DEDUPE_TTL_SECONDS
        ]
        for existing_id in expired:
            _recent_telnyx_event_ids.pop(existing_id, None)

        if event_id in _recent_telnyx_event_ids:
            return True

        _recent_telnyx_event_ids[event_id] = now
        return False


async def _upsert_call_metadata(call_control_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    async with _metadata_lock:
        current = dict(call_metadata.get(call_control_id) or {})
        current.update(updates)
        call_metadata[call_control_id] = current
    await _persist_metadata(call_control_id, current)
    return current


async def _seed_outbound_call_metadata(
    *,
    call_control_id: str,
    senior: dict,
    call_type: str,
    target_phone: str,
    ws_token: str,
    context_seed: dict[str, Any],
    context_seed_source: str,
) -> dict[str, Any]:
    profile = resolve_telnyx_audio_profile(get_settings())
    amd_mode = _telnyx_amd_mode()
    seeded_at = time.time()
    metadata = {
        "senior": senior,
        "prospect": None,
        "prospect_id": None,
        "memory_context": context_seed.get("memory_context"),
        "conversation_id": None,
        "reminder_prompt": None,
        "reminder_context": None,
        "pre_generated_greeting": context_seed.get("pre_generated_greeting"),
        "previous_calls_summary": context_seed.get("previous_calls_summary"),
        "recent_turns": context_seed.get("recent_turns"),
        "todays_context": None,
        "news_context": context_seed.get("news_context"),
        "is_outbound": True,
        "call_type": call_type,
        "target_phone": target_phone,
        "last_call_analysis": None,
        "has_caregiver_notes": False,
        "caregiver_notes_content": [],
        "call_settings": _call_settings_from_senior(senior),
        "ws_token": ws_token,
        "ws_token_expires_at": seeded_at + 300,
        "ws_token_consumed": False,
        "telephony_provider": "telnyx",
        "telnyx_start_stream_after_answer": True,
        "telnyx_stream_codec": profile.codec,
        "telnyx_stream_sample_rate": profile.sample_rate,
        "telnyx_answered": False,
        "telnyx_context_ready": False,
        "telnyx_context_seed_source": context_seed_source,
        "telnyx_outbound_seeded_at": seeded_at,
        "telnyx_amd_enabled": bool(amd_mode),
        "telnyx_amd_mode": amd_mode or "disabled",
        "telnyx_amd_status": "pending" if amd_mode else "disabled",
        "telnyx_voicemail_detected": False,
        "telnyx_voicemail_message_started": False,
    }
    seeded = await _upsert_call_metadata(call_control_id, metadata)
    logger.info(
        "[{cid}] Seeded Telnyx outbound metadata source={source} greeting={greeting} memory={memory} reminder={reminder}",
        cid=call_control_id,
        source=context_seed_source,
        greeting=bool(metadata.get("pre_generated_greeting")),
        memory=bool(metadata.get("memory_context")),
        reminder=call_type == "reminder",
    )
    return seeded


async def _store_senior_metadata(
    *,
    call_control_id: str,
    senior: dict,
    is_outbound: bool,
    call_type: str,
    target_phone: str,
    ws_token: str,
    start_stream_after_answer: bool,
    reminder_prompt: str | None = None,
    reminder_context: dict | None = None,
    context_seed: dict[str, Any] | None = None,
    prewarmed_hydrated_context: dict[str, Any] | None = None,
) -> dict:
    profile = resolve_telnyx_audio_profile(get_settings())
    if prewarmed_hydrated_context is not None:
        hydrated = prewarmed_hydrated_context
    else:
        seed = context_seed or {}
        hydrated = await _hydrate_senior_call_context(
            senior=senior,
            call_sid=call_control_id,
            is_outbound=is_outbound,
            memory_context=seed.get("memory_context"),
            pre_generated_greeting=seed.get("pre_generated_greeting"),
            news_context=seed.get("news_context"),
            recent_turns=seed.get("recent_turns"),
            previous_calls_summary=seed.get("previous_calls_summary"),
        )

    conversation_id = None
    try:
        from services.conversations import create

        conv = await create(senior["id"], call_control_id, direction="outbound" if is_outbound else "inbound")
        conversation_id = str(conv["id"]) if conv else None
    except Exception as exc:
        logger.error("[{cid}] Error creating Telnyx conversation: {err}", cid=call_control_id, err=str(exc))

    current_metadata = call_metadata.get(call_control_id) or {}
    should_start_stream = bool(
        start_stream_after_answer
        and current_metadata.get("telnyx_start_stream_after_answer", start_stream_after_answer)
    )
    metadata = {
        "senior": senior,
        "prospect": None,
        "prospect_id": None,
        "memory_context": hydrated["memory_context"],
        "conversation_id": conversation_id,
        "reminder_prompt": reminder_prompt,
        "reminder_context": reminder_context,
        "pre_generated_greeting": hydrated["pre_generated_greeting"],
        "previous_calls_summary": hydrated["previous_calls_summary"],
        "recent_turns": hydrated["recent_turns"],
        "todays_context": hydrated["todays_context"],
        "news_context": hydrated["news_context"],
        "is_outbound": is_outbound,
        "call_type": call_type,
        "target_phone": target_phone,
        "last_call_analysis": hydrated["last_call_analysis"],
        "has_caregiver_notes": hydrated["has_caregiver_notes"],
        "caregiver_notes_content": hydrated["caregiver_notes_content"],
        "call_settings": hydrated["call_settings"] or current_metadata.get("call_settings"),
        "ws_token": ws_token,
        "ws_token_expires_at": current_metadata.get("ws_token_expires_at") or time.time() + 300,
        "ws_token_consumed": current_metadata.get("ws_token_consumed", False),
        "telephony_provider": "telnyx",
        "telnyx_start_stream_after_answer": should_start_stream,
        "telnyx_stream_codec": profile.codec,
        "telnyx_stream_sample_rate": profile.sample_rate,
        "telnyx_context_ready": True,
        "telnyx_context_ready_at": time.time(),
    }
    metadata = await _upsert_call_metadata(call_control_id, metadata)

    seeded_at = current_metadata.get("telnyx_outbound_seeded_at")
    if seeded_at:
        logger.info(
            "[{cid}] Telnyx outbound context ready after_ms={elapsed_ms} reminder={reminder}",
            cid=call_control_id,
            elapsed_ms=round((time.time() - float(seeded_at)) * 1000),
            reminder=bool(reminder_prompt),
        )

    try:
        from services.audit import fire_and_forget_audit

        fire_and_forget_audit(
            user_id="system",
            user_role="system",
            action="read",
            resource_type="senior",
            resource_id=str(senior["id"]),
            metadata={
                "trigger": "telnyx_call",
                "call_sid": call_control_id,
                "call_type": call_type,
            },
        )
    except Exception:
        pass

    await _maybe_start_telnyx_stream(call_control_id, reason="context_ready", log_if_pending=False)
    return metadata


async def _store_prospect_metadata(
    *,
    call_control_id: str,
    target_phone: str,
    ws_token: str,
    start_stream_after_answer: bool,
) -> None:
    profile = resolve_telnyx_audio_profile(get_settings())
    prospect = None
    prospect_id = None
    memory_context = None
    try:
        from services.prospects import create as create_prospect
        from services.prospects import find_by_phone as find_prospect

        prospect = await find_prospect(target_phone)
        if not prospect:
            prospect = await create_prospect(target_phone)
        prospect_id = str(prospect["id"]) if prospect else None
    except Exception as exc:
        logger.error("[{cid}] Error in Telnyx prospect lookup/create: {err}", cid=call_control_id, err=str(exc))

    conversation_id = None
    try:
        from services.conversations import create

        conv = await create(None, call_control_id, prospect_id=prospect_id, direction="inbound")
        conversation_id = str(conv["id"]) if conv else None
    except Exception as exc:
        logger.error("[{cid}] Error creating Telnyx onboarding conversation: {err}", cid=call_control_id, err=str(exc))

    metadata = {
        "senior": None,
        "prospect": prospect,
        "prospect_id": prospect_id,
        "memory_context": memory_context,
        "conversation_id": conversation_id,
        "is_outbound": False,
        "call_type": "onboarding",
        "target_phone": target_phone,
        "ws_token": ws_token,
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
        "telephony_provider": "telnyx",
        "telnyx_start_stream_after_answer": start_stream_after_answer,
        "telnyx_stream_codec": profile.codec,
        "telnyx_stream_sample_rate": profile.sample_rate,
        "telnyx_context_ready": True,
        "telnyx_context_ready_at": time.time(),
    }
    await _upsert_call_metadata(call_control_id, metadata)


async def _answer_telnyx_call(call_control_id: str) -> None:
    endpoint = f"https://api.telnyx.com/v2/calls/{call_control_id}/actions/answer"
    await _telnyx_post(endpoint, {"command_id": _telnyx_command_id(call_control_id, "answer")})
    logger.info("[{cid}] Telnyx inbound call answered; starting stream after call.answered", cid=call_control_id)


async def _start_telnyx_stream(call_control_id: str, ws_token: str) -> None:
    profile = resolve_telnyx_audio_profile(get_settings())
    endpoint = f"https://api.telnyx.com/v2/calls/{call_control_id}/actions/streaming_start"
    payload = {
        **_telnyx_stream_options(ws_token),
        "command_id": _telnyx_command_id(call_control_id, "streaming_start"),
    }
    await _telnyx_post(endpoint, payload)
    logger.info(
        "[{cid}] Telnyx media stream started codec={codec} sample_rate={rate}Hz track={track} target={target}",
        cid=call_control_id,
        codec=profile.codec,
        rate=profile.sample_rate,
        track=profile.stream_track,
        target=profile.bidirectional_target_legs,
    )


async def _hangup_telnyx_call(call_control_id: str) -> None:
    endpoint = f"https://api.telnyx.com/v2/calls/{call_control_id}/actions/hangup"
    await _telnyx_post(endpoint, {"command_id": _telnyx_command_id(call_control_id, "hangup")})


async def _speak_telnyx_voicemail(call_control_id: str) -> None:
    cfg = get_settings()
    message = (cfg.telnyx_voicemail_message or "").strip()[:3000]
    if not message:
        logger.warning("[{cid}] Telnyx voicemail message is empty; hanging up", cid=call_control_id)
        await _hangup_telnyx_call(call_control_id)
        return

    payload: dict[str, Any] = {
        "payload": message,
        "voice": (cfg.telnyx_voicemail_voice or "female").strip() or "female",
        "payload_type": "text",
        "target_legs": "self",
        "command_id": _telnyx_command_id(call_control_id, "voicemail_speak"),
    }
    if cfg.telnyx_voicemail_service_level:
        payload["service_level"] = cfg.telnyx_voicemail_service_level
    if cfg.telnyx_voicemail_language:
        payload["language"] = cfg.telnyx_voicemail_language

    endpoint = f"https://api.telnyx.com/v2/calls/{call_control_id}/actions/speak"
    await _telnyx_post(endpoint, payload)
    logger.info("[{cid}] Started short Telnyx voicemail message", cid=call_control_id)


async def _leave_telnyx_voicemail_message(call_control_id: str, *, reason: str) -> bool:
    async with _metadata_lock:
        metadata = call_metadata.get(call_control_id)
        if not metadata:
            return False
        if metadata.get("telnyx_voicemail_message_started"):
            return False
        metadata.update(
            {
                "telnyx_start_stream_after_answer": False,
                "telnyx_voicemail_message_started": True,
                "telnyx_voicemail_message_started_at": time.time(),
                "telnyx_voicemail_message_reason": reason,
            }
        )
        snapshot = dict(metadata)

    await _persist_metadata(call_control_id, snapshot)

    try:
        await _speak_telnyx_voicemail(call_control_id)
    except Exception as exc:
        logger.error("[{cid}] Telnyx voicemail speak failed: {err}", cid=call_control_id, err=str(exc))
        await _upsert_call_metadata(
            call_control_id,
            {
                "telnyx_voicemail_message_failed_at": time.time(),
                "telnyx_voicemail_message_error": type(exc).__name__,
            },
        )
        try:
            await _hangup_telnyx_call(call_control_id)
        except Exception as hangup_exc:
            logger.error(
                "[{cid}] Telnyx voicemail cleanup hangup failed: {err}",
                cid=call_control_id,
                err=str(hangup_exc),
            )
        return False

    return True


async def _fallback_leave_telnyx_voicemail(call_control_id: str, *, reason: str) -> None:
    delay = max(0.0, float(get_settings().telnyx_voicemail_fallback_delay_seconds))
    if delay > 0:
        await asyncio.sleep(delay)

    metadata = call_metadata.get(call_control_id) or {}
    if not metadata.get("telnyx_voicemail_detected") or metadata.get("telnyx_voicemail_message_started"):
        return
    await _leave_telnyx_voicemail_message(call_control_id, reason=reason)


async def _handle_machine_detection_event(
    call_control_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    result = str(payload.get("result") or "").strip().lower()
    is_greeting_event = event_type in {
        "call.machine.greeting.ended",
        "call.machine.premium.greeting.ended",
    }
    detected_at = time.time()

    if is_greeting_event or result in _AMD_MACHINE_RESULTS:
        await _upsert_call_metadata(
            call_control_id,
            {
                "telnyx_start_stream_after_answer": False,
                "telnyx_amd_status": "machine",
                "telnyx_amd_result": result or "machine",
                "telnyx_amd_event": event_type,
                "telnyx_amd_resolved_at": detected_at,
                "telnyx_voicemail_detected": True,
                "telnyx_voicemail_detected_at": detected_at,
            },
        )
        logger.info(
            "[{cid}] Telnyx AMD detected voicemail event={event} result={result}",
            cid=call_control_id,
            event=event_type,
            result=result or "unknown",
        )
        if is_greeting_event:
            await _leave_telnyx_voicemail_message(call_control_id, reason=event_type)
        else:
            await _fallback_leave_telnyx_voicemail(call_control_id, reason="machine_detection_fallback")
        return

    if result in _AMD_HANGUP_RESULTS:
        await _upsert_call_metadata(
            call_control_id,
            {
                "telnyx_start_stream_after_answer": False,
                "telnyx_amd_status": result,
                "telnyx_amd_result": result,
                "telnyx_amd_event": event_type,
                "telnyx_amd_resolved_at": detected_at,
            },
        )
        logger.info(
            "[{cid}] Telnyx AMD detected non-human answer event={event} result={result}; hanging up",
            cid=call_control_id,
            event=event_type,
            result=result,
        )
        await _hangup_telnyx_call(call_control_id)
        return

    status = "human" if result in _AMD_HUMAN_RESULTS else "unknown_as_human"
    metadata = await _upsert_call_metadata(
        call_control_id,
        {
            "telnyx_amd_status": status,
            "telnyx_amd_result": result or "unknown",
            "telnyx_amd_event": event_type,
            "telnyx_amd_resolved_at": detected_at,
        },
    )
    logger.info(
        "[{cid}] Telnyx AMD continuing live call event={event} result={result} context_ready={ready}",
        cid=call_control_id,
        event=event_type,
        result=result or "unknown",
        ready=bool(metadata.get("telnyx_context_ready")),
    )
    await _maybe_start_telnyx_stream(call_control_id, reason="amd_human")


async def _handle_speak_ended(call_control_id: str, _payload: dict[str, Any]) -> None:
    metadata = call_metadata.get(call_control_id) or {}
    if not metadata.get("telnyx_voicemail_message_started"):
        return

    await _upsert_call_metadata(
        call_control_id,
        {
            "telnyx_voicemail_message_ended_at": time.time(),
            "telnyx_voicemail_hangup_started": True,
        },
    )
    logger.info("[{cid}] Telnyx voicemail message ended; hanging up", cid=call_control_id)
    try:
        await _hangup_telnyx_call(call_control_id)
    except Exception as exc:
        logger.error("[{cid}] Telnyx voicemail hangup failed: {err}", cid=call_control_id, err=str(exc))


async def _maybe_start_telnyx_stream(
    call_control_id: str,
    *,
    reason: str,
    log_if_pending: bool = True,
) -> bool:
    async with _metadata_lock:
        metadata = call_metadata.get(call_control_id)
        if not metadata or not metadata.get("telnyx_start_stream_after_answer"):
            return False
        if metadata.get("telnyx_stream_started"):
            return False
        if metadata.get("telnyx_voicemail_detected"):
            return False
        if metadata.get("telnyx_amd_enabled") and metadata.get("telnyx_amd_status") == "pending":
            if log_if_pending:
                logger.info("[{cid}] Waiting to start Telnyx media stream: AMD pending", cid=call_control_id)
            return False
        if not metadata.get("telnyx_answered"):
            if log_if_pending:
                logger.info("[{cid}] Waiting to start Telnyx media stream: call not answered yet", cid=call_control_id)
            return False
        if not metadata.get("telnyx_context_ready"):
            if log_if_pending:
                logger.info("[{cid}] Waiting to start Telnyx media stream: context not ready yet", cid=call_control_id)
            return False
        ws_token = metadata.get("ws_token")
        if not ws_token:
            logger.error("[{cid}] Cannot start Telnyx media stream: missing ws_token", cid=call_control_id)
            return False
        metadata["telnyx_stream_started"] = True
        metadata["telnyx_stream_start_reason"] = reason

    try:
        await _start_telnyx_stream(call_control_id, ws_token)
    except Exception:
        await _upsert_call_metadata(
            call_control_id,
            {
                "telnyx_stream_started": False,
                "telnyx_stream_start_reason": None,
            },
        )
        raise

    await _upsert_call_metadata(
        call_control_id,
        {
            "telnyx_stream_started_at": time.time(),
            "telnyx_stream_start_reason": reason,
        },
    )
    return True


async def _handle_call_initiated(payload: dict[str, Any]) -> None:
    call_control_id = payload.get("call_control_id", "")
    if not call_control_id:
        return

    cfg = get_settings()
    from_number = payload.get("from", "")
    to_number = payload.get("to", "")
    is_outbound = _format_phone_for_call(from_number) == _format_phone_for_call(cfg.telnyx_phone_number)
    target_phone = to_number if is_outbound else from_number

    if is_outbound:
        logger.info("[{cid}] Telnyx outbound initiated", cid=call_control_id)
        return

    try:
        from main import _call_semaphore

        if _call_semaphore.locked():
            logger.warning("[{cid}] At capacity; hanging up Telnyx inbound call", cid=call_control_id)
            await _hangup_telnyx_call(call_control_id)
            return
    except Exception:
        pass

    logger.info(
        "[{cid}] Telnyx inbound call target={phone}",
        cid=call_control_id,
        phone=mask_phone(target_phone),
    )

    ws_token = secrets.token_urlsafe(32)
    from services.seniors import find_any_by_phone, find_by_phone

    senior = await find_by_phone(target_phone)
    if senior:
        await _store_senior_metadata(
            call_control_id=call_control_id,
            senior=senior,
            is_outbound=False,
            call_type="check-in",
            target_phone=target_phone,
            ws_token=ws_token,
            start_stream_after_answer=True,
        )
        await _answer_telnyx_call(call_control_id)
        return

    inactive_match = await find_any_by_phone(target_phone)
    if _senior_is_inactive(inactive_match):
        logger.warning("[{cid}] Inactive Telnyx caller matched; hanging up", cid=call_control_id)
        await _hangup_telnyx_call(call_control_id)
        return

    await _store_prospect_metadata(
        call_control_id=call_control_id,
        target_phone=target_phone,
        ws_token=ws_token,
        start_stream_after_answer=True,
    )
    await _answer_telnyx_call(call_control_id)


async def _handle_call_answered(call_control_id: str) -> None:
    async with _metadata_lock:
        metadata = call_metadata.get(call_control_id)
        if not metadata:
            logger.warning("[{cid}] Telnyx call answered before metadata was available", cid=call_control_id)
            return

    metadata = await _upsert_call_metadata(
        call_control_id,
        {
            "telnyx_answered": True,
            "telnyx_answered_at": time.time(),
        },
    )
    logger.info(
        "[{cid}] Telnyx call answered context_ready={ready} stream_started={started}",
        cid=call_control_id,
        ready=bool(metadata.get("telnyx_context_ready")),
        started=bool(metadata.get("telnyx_stream_started")),
    )
    await _maybe_start_telnyx_stream(call_control_id, reason="call_answered")


async def _record_streaming_event(call_control_id: str, event_type: str, payload: dict[str, Any]) -> None:
    metadata = call_metadata.get(call_control_id)
    updates = {
        "telnyx_last_stream_event": event_type,
        "telnyx_last_stream_event_at": time.time(),
    }
    stream_id = payload.get("stream_id")
    if stream_id:
        updates["telnyx_stream_id"] = stream_id
    if metadata:
        if event_type == "streaming.started":
            updates["telnyx_stream_confirmed_at"] = time.time()
        elif event_type == "streaming.failed":
            updates["telnyx_stream_started"] = False
            updates["telnyx_stream_failed_at"] = time.time()
        elif event_type == "streaming.stopped":
            updates["telnyx_stream_stopped_at"] = time.time()
        await _upsert_call_metadata(call_control_id, updates)

    log_fn = logger.warning if event_type == "streaming.failed" else logger.info
    log_fn(
        "[{cid}] Telnyx stream event event={event} stream_id={stream_id}",
        cid=call_control_id,
        event=event_type,
        stream_id=stream_id or "unknown",
    )


@router.post("/telnyx/events")
async def telnyx_events(request: Request, background_tasks: BackgroundTasks):
    raw_body = await request.body()
    _verify_telnyx_signature(raw_body, request)

    try:
        event = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON") from exc

    data = event.get("data") or {}
    event_id = str(data.get("id") or "")
    event_type = data.get("event_type", "")
    payload = data.get("payload") or {}
    call_control_id = payload.get("call_control_id", "")

    if event_id and await _mark_telnyx_event_seen(event_id):
        logger.info(
            "[{cid}] Ignoring duplicate Telnyx webhook event={event} event_id={event_id}",
            cid=call_control_id or "unknown",
            event=event_type or "unknown",
            event_id=event_id,
        )
        return {"received": True, "duplicate": True}

    if event_type == "call.initiated":
        background_tasks.add_task(_handle_call_initiated, payload)
    elif event_type == "call.answered" and call_control_id:
        background_tasks.add_task(_handle_call_answered, call_control_id)
    elif event_type in _AMD_EVENTS and call_control_id:
        background_tasks.add_task(_handle_machine_detection_event, call_control_id, event_type, payload)
    elif event_type == "call.speak.ended" and call_control_id:
        background_tasks.add_task(_handle_speak_ended, call_control_id, payload)
    elif event_type in {"streaming.started", "streaming.failed", "streaming.stopped"} and call_control_id:
        background_tasks.add_task(_record_streaming_event, call_control_id, event_type, payload)
    elif event_type in _TERMINAL_EVENTS and call_control_id:
        metadata = call_metadata.get(call_control_id) or {}
        if metadata.get("telnyx_voicemail_detected") and metadata.get("conversation_id"):
            try:
                from services.conversations import complete
                duration = round(time.time() - float(metadata.get("telnyx_outbound_seeded_at", time.time())))
                await complete(call_control_id, {
                    "duration_seconds": duration,
                    "status": "completed",
                    "transcript": None,
                })
                logger.info("[{cid}] Completed voicemail conversation dur={dur}s", cid=call_control_id, dur=duration)
                # Persist voicemail flag separately — survives race with run_post_call's complete()
                try:
                    from db import execute
                    await execute(
                        "UPDATE conversations SET voicemail_detected = TRUE WHERE id = $1",
                        metadata["conversation_id"],
                    )
                except Exception as vm_exc:
                    logger.error("[{cid}] Failed to set voicemail_detected: {err}", cid=call_control_id, err=str(vm_exc))
            except Exception as exc:
                logger.error("[{cid}] Failed to complete voicemail conversation: {err}", cid=call_control_id, err=str(exc))
        await _cleanup_metadata(call_control_id)
        logger.info("[{cid}] Cleaned up Telnyx metadata event={event}", cid=call_control_id, event=event_type)

    return {"received": True}


async def prewarm_telnyx_outbound_context(body: TelnyxOutboundCallRequest) -> dict[str, Any]:
    from services.seniors import get_by_id

    senior = await get_by_id(body.senior_id)
    if not senior:
        raise HTTPException(status_code=404, detail="Senior not found")
    if _senior_is_inactive(senior):
        raise HTTPException(status_code=400, detail="Senior is not active")

    target_phone = _format_phone_for_call(senior.get("phone", ""))
    if not target_phone:
        raise HTTPException(status_code=400, detail="Senior phone is not callable")

    context_seed, cache_hit = _cached_senior_context_seed(senior)
    hydrated_context = await _hydrate_senior_call_context(
        senior=senior,
        call_sid=f"prewarm:{body.senior_id}",
        is_outbound=True,
        memory_context=context_seed.get("memory_context"),
        pre_generated_greeting=context_seed.get("pre_generated_greeting"),
        news_context=context_seed.get("news_context"),
        recent_turns=context_seed.get("recent_turns"),
        previous_calls_summary=context_seed.get("previous_calls_summary"),
    )

    now = datetime.now(timezone.utc)
    prewarmed = TelnyxPrewarmedOutboundContext(
        seniorId=body.senior_id,
        callType=body.call_type,
        reminderId=body.reminder_id,
        scheduledFor=body.scheduled_for,
        warmedAt=now,
        expiresAt=now + timedelta(seconds=TELNYX_PREWARM_TTL_SECONDS),
        contextSeedSource="context_cache" if cache_hit else "live_hydration",
        hydratedContext=TelnyxPrewarmedHydratedContext(
            memoryContext=hydrated_context.get("memory_context"),
            preGeneratedGreeting=hydrated_context.get("pre_generated_greeting"),
            newsContext=hydrated_context.get("news_context"),
            recentTurns=hydrated_context.get("recent_turns"),
            previousCallsSummary=hydrated_context.get("previous_calls_summary"),
            todaysContext=hydrated_context.get("todays_context"),
            lastCallAnalysis=hydrated_context.get("last_call_analysis"),
            callSettings=hydrated_context.get("call_settings"),
            caregiverNotesContent=hydrated_context.get("caregiver_notes_content"),
        ),
    )
    logger.info(
        "Prewarmed Telnyx outbound context senior_id={sid} call_type={call_type} cache_hit={cache_hit}",
        sid=body.senior_id,
        call_type=body.call_type,
        cache_hit=cache_hit,
    )
    return prewarmed.model_dump(mode="json", by_alias=True)


async def _prepare_reminder_context(
    body: TelnyxOutboundCallRequest,
    call_control_id: str,
) -> tuple[str | None, dict | None]:
    if body.call_type != "reminder" or not body.reminder_id:
        return None, None

    from services.reminder_delivery import (
        create_or_update_delivery_for_call,
        format_reminder_prompt,
        get_reminder_by_id,
    )

    reminder = await get_reminder_by_id(body.reminder_id)
    if not reminder:
        raise HTTPException(status_code=404, detail="Reminder not found")

    scheduled_for = body.scheduled_for or datetime.now(timezone.utc)
    # DB column is TIMESTAMP (naive) — strip tzinfo to avoid asyncpg error
    if scheduled_for.tzinfo is not None:
        scheduled_for = scheduled_for.replace(tzinfo=None)
    delivery = await create_or_update_delivery_for_call(
        reminder_id=body.reminder_id,
        scheduled_for=scheduled_for,
        call_sid=call_control_id,
        existing_delivery_id=body.existing_delivery_id,
    )
    normalized_reminder = {
        "title": reminder.get("title"),
        "description": reminder.get("description"),
        "type": reminder.get("reminder_type") or reminder.get("type"),
    }
    reminder_context = {
        "reminder": normalized_reminder,
        "delivery": {
            "id": delivery.get("id"),
            "reminder_id": delivery.get("reminder_id"),
            "status": delivery.get("status"),
            "attempt_count": delivery.get("attempt_count"),
        },
        "scheduled_for": scheduled_for,
    }
    return format_reminder_prompt(normalized_reminder), reminder_context


def _format_reminder_event_time(reminder: dict, senior_timezone: str | None = None) -> str | None:
    """Format the reminder's event date/time into a human-readable string in the senior's timezone."""
    from datetime import datetime as dt, timezone as tz
    import zoneinfo

    is_recurring = reminder.get("is_recurring", False)
    scheduled_time = reminder.get("scheduled_time")
    cron_expression = reminder.get("cron_expression")

    if is_recurring and cron_expression:
        # Parse cron "M H * * *" — these are already in the senior's local time
        parts = str(cron_expression).strip().split()
        if len(parts) == 5:
            try:
                minute = int(parts[0])
                hour = int(parts[1])
                period = "AM" if hour < 12 else "PM"
                display_hour = hour if 1 <= hour <= 12 else (hour - 12 if hour > 12 else 12)
                return f"every day at {display_hour}:{minute:02d} {period}"
            except (ValueError, IndexError):
                pass
        return "recurring (daily)"

    if scheduled_time:
        try:
            if isinstance(scheduled_time, str):
                event_dt = dt.fromisoformat(scheduled_time.replace("Z", "+00:00"))
            else:
                event_dt = scheduled_time

            # Convert from UTC to senior's local timezone
            if senior_timezone:
                try:
                    tz_info = zoneinfo.ZoneInfo(senior_timezone)
                    # If naive datetime, assume UTC
                    if event_dt.tzinfo is None:
                        event_dt = event_dt.replace(tzinfo=tz.utc)
                    event_dt = event_dt.astimezone(tz_info)
                except Exception:
                    pass  # Fall through to UTC formatting

            # Format as readable: "Wednesday, April 23 at 5:20 PM"
            return event_dt.strftime("%A, %B %d at %-I:%M %p")
        except Exception:
            return str(scheduled_time)

    return None


async def _prepare_schedule_context(
    body: TelnyxOutboundCallRequest,
    senior: dict | None = None,
) -> tuple[str | None, dict | None]:
    """Prepare context for a scheduled call with pending reminders."""
    if body.call_type != "schedule":
        return None, None

    from services.reminder_delivery import get_reminder_by_id

    senior_timezone = (senior or {}).get("timezone")

    pending_reminders = []
    if body.reminder_ids:
        for rid in body.reminder_ids:
            reminder = await get_reminder_by_id(rid)
            if reminder:
                event_time = _format_reminder_event_time(reminder, senior_timezone)
                pending_reminders.append({
                    "id": rid,
                    "title": reminder.get("title", ""),
                    "description": reminder.get("description", ""),
                    "type": reminder.get("reminder_type") or reminder.get("type", ""),
                    "event_time": event_time,
                    "is_recurring": reminder.get("is_recurring", False),
                })

    if not pending_reminders and not body.context_notes:
        return None, None

    # Build a prompt for Donna to naturally mention reminders during the call
    lines = []
    if pending_reminders:
        lines.append("\nREMINDERS TO MENTION DURING THIS CALL:")
        lines.append(
            "Bring these up naturally during the conversation — "
            "don't list them all at once. Make sure to mention WHEN each event happens."
        )
        for r in pending_reminders:
            detail = f"- {r['title']}"
            if r.get("description"):
                detail += f" — {r['description']}"
            if r.get("event_time"):
                detail += f" (Event happens: {r['event_time']})"
            elif r.get("is_recurring"):
                detail += " (recurring daily)"
            lines.append(detail)

    if body.context_notes:
        lines.append(f"\nAdditional context from caregiver: {body.context_notes}")

    reminder_prompt = "\n".join(lines) if lines else None
    schedule_context = {
        "pending_reminders": pending_reminders,
        "context_notes": body.context_notes,
    }
    return reminder_prompt, schedule_context


async def create_telnyx_outbound_call(body: TelnyxOutboundCallRequest) -> dict:
    """Create an outbound Telnyx call and seed Pipecat call metadata."""
    cfg = get_settings()
    if not cfg.telnyx_connection_id or not cfg.telnyx_phone_number:
        raise HTTPException(status_code=500, detail="Telnyx connection is not configured")

    from services.seniors import get_by_id

    senior = await get_by_id(body.senior_id)
    if not senior:
        raise HTTPException(status_code=404, detail="Senior not found")
    if _senior_is_inactive(senior):
        raise HTTPException(status_code=400, detail="Senior is not active")

    target_phone = _format_phone_for_call(senior.get("phone", ""))
    if not target_phone:
        raise HTTPException(status_code=400, detail="Senior phone is not callable")

    prewarmed_context = _validated_prewarmed_context(body)
    prewarmed_hydrated_context = None
    if prewarmed_context:
        prewarmed_hydrated_context = _coerce_prewarmed_hydrated_context(
            prewarmed_context,
            senior=senior,
        )
        context_seed = _context_seed_from_hydrated_context(prewarmed_hydrated_context)
        context_seed_source = f"prewarmed:{prewarmed_context.context_seed_source}"
        warmed_at = _normalize_datetime(prewarmed_context.warmed_at) or datetime.now(timezone.utc)
        logger.info(
            "Using Telnyx prewarmed outbound context senior_id={sid} age_ms={age_ms}",
            sid=body.senior_id,
            age_ms=round((datetime.now(timezone.utc) - warmed_at).total_seconds() * 1000),
        )
    else:
        context_seed, cache_hit = _cached_senior_context_seed(senior)
        context_seed_source = "context_cache" if cache_hit else "live_hydration"

    ws_token = secrets.token_urlsafe(32)
    payload = {
        "connection_id": cfg.telnyx_connection_id,
        "to": target_phone,
        "from": cfg.telnyx_phone_number,
        "webhook_url": _telnyx_event_url(),
        "webhook_url_method": "POST",
        "command_id": str(uuid.uuid4()),
    }
    payload.update(_telnyx_amd_dial_fields())

    response = await _telnyx_post("https://api.telnyx.com/v2/calls", payload)
    call_data = response.get("data") or {}
    call_control_id = call_data.get("call_control_id")
    if not call_control_id:
        raise HTTPException(status_code=502, detail="Telnyx did not return a call_control_id")

    await _seed_outbound_call_metadata(
        call_control_id=call_control_id,
        senior=senior,
        call_type=body.call_type,
        target_phone=target_phone,
        ws_token=ws_token,
        context_seed=context_seed,
        context_seed_source=context_seed_source,
    )

    try:
        # Prepare context based on call type
        if body.call_type == "schedule":
            reminder_prompt, reminder_context = await _prepare_schedule_context(body, senior)
        else:
            reminder_prompt, reminder_context = await _prepare_reminder_context(body, call_control_id)
        await _store_senior_metadata(
            call_control_id=call_control_id,
            senior=senior,
            is_outbound=True,
            call_type=body.call_type,
            target_phone=target_phone,
            ws_token=ws_token,
            start_stream_after_answer=True,
            reminder_prompt=reminder_prompt,
            reminder_context=reminder_context,
            context_seed=context_seed,
            prewarmed_hydrated_context=prewarmed_hydrated_context,
        )
    except Exception as exc:
        logger.error("[{cid}] Telnyx outbound context setup failed: {err}", cid=call_control_id, err=str(exc))
        try:
            await _hangup_telnyx_call(call_control_id)
        except Exception as hangup_exc:
            logger.error("[{cid}] Telnyx cleanup hangup failed: {err}", cid=call_control_id, err=str(hangup_exc))
        await _cleanup_metadata(call_control_id)
        raise

    logger.info(
        "[{cid}] Initiated Telnyx outbound call for senior {sid} type={call_type}",
        cid=call_control_id,
        sid=str(senior["id"])[:8],
        call_type=body.call_type,
    )
    return {
        "success": True,
        "provider": "telnyx",
        "callSid": call_control_id,
        "callControlId": call_control_id,
        "seniorId": senior["id"],
    }


async def end_telnyx_call(call_control_id: str) -> dict:
    await _hangup_telnyx_call(call_control_id)
    await _cleanup_metadata(call_control_id)
    return {"success": True, "provider": "telnyx", "callSid": call_control_id}


@router.post("/telnyx/prewarm")
async def telnyx_prewarm_call(
    body: TelnyxOutboundCallRequest,
    _service_label: str = Depends(require_service_api_key),
):
    return {
        "success": True,
        "prewarmedContext": await prewarm_telnyx_outbound_context(body),
    }


@router.post("/telnyx/outbound")
async def telnyx_outbound_call(
    body: TelnyxOutboundCallRequest,
    _service_label: str = Depends(require_service_api_key),
):
    return await create_telnyx_outbound_call(body)


@router.post("/telnyx/calls/{call_control_id}/end")
async def telnyx_end_call(
    call_control_id: str,
    _service_label: str = Depends(require_service_api_key),
):
    return await end_telnyx_call(call_control_id)
