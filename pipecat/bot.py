"""Donna voice pipeline — core bot entry point.

Assembles the full Pipecat pipeline for a single call session:
  Telnyx WebSocket → preroll → Deepgram STT → Quick Observer →
  user Conversation Tracker → Conversation Director → LLM Context →
  Anthropic Claude + FlowManager → Guidance Stripper →
  assistant Conversation Tracker → metrics → TTS provider → Telnyx output

Called once per incoming WebSocket connection from Telnyx.
"""

from __future__ import annotations

import asyncio
import hmac
import time

from deepgram import LiveOptions
from loguru import logger
from starlette.websockets import WebSocket

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import EndFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat_flows import FlowManager

from config import get_settings, is_production_environment, settings
from flows.nodes import build_initial_node
from flows.tools import select_flows_tools
from lib.telnyx_audio import TelnyxAudioProfileError, resolve_telnyx_audio_profile
from processors.conversation_director import ConversationDirectorProcessor
from processors.conversation_tracker import ConversationState, ConversationTrackerProcessor
from processors.audio_preroll import InitialAudioPrerollProcessor
from processors.guidance_stripper import GuidanceStripperProcessor
from processors.metrics_logger import MetricsLoggerProcessor
from processors.quick_observer import QuickObserverProcessor
from services.post_call import run_post_call
from serializers.telnyx import DonnaTelnyxFrameSerializer

class WebSocketAuthError(Exception):
    """Raised when a telephony media WebSocket cannot be admitted."""


HANDSHAKE_TIMEOUT_SECONDS = settings.telephony_ws_handshake_timeout_seconds
WS_METADATA_LOOKUP_TIMEOUT_SECONDS = 2.0
WS_METADATA_LOOKUP_POLL_INTERVAL_SECONDS = 0.05


def _provider_call_id(call_data: dict, session_state: dict | None = None) -> str:
    """Return the canonical call identifier for the active telephony provider."""
    session_state = session_state or {}
    return (
        call_data.get("call_id")
        or call_data.get("call_control_id")
        or session_state.get("call_sid")
        or ""
    )


def _provider_ws_token(call_data: dict) -> str:
    """Extract the one-time WebSocket token from provider-specific metadata."""
    body = call_data.get("body") or {}
    query_params = call_data.get("query_params") or {}

    custom_token = ""
    custom_parameters = body.get("custom_parameters") or call_data.get("custom_parameters") or []
    if isinstance(custom_parameters, list):
        for param in custom_parameters:
            if not isinstance(param, dict):
                continue
            if str(param.get("name") or "") not in {"ws_token", "stream_auth_token"}:
                continue
            candidate = str(param.get("value") or "")
            if candidate:
                custom_token = candidate
                break

    body_token = body.get("ws_token") or body.get("stream_auth_token") or ""
    query_token = query_params.get("ws_token") or query_params.get("stream_auth_token") or ""
    return str(body_token or custom_token or query_token)


async def _wait_for_call_metadata(call_sid: str) -> dict | None:
    from api.routes.call_context import get_call_metadata

    deadline = time.monotonic() + WS_METADATA_LOOKUP_TIMEOUT_SECONDS
    attempts = 0

    while True:
        attempts += 1
        try:
            metadata = await get_call_metadata(call_sid)
        except Exception as exc:
            raise WebSocketAuthError("shared metadata unavailable") from exc
        if metadata:
            if attempts > 1:
                logger.info(
                    "[{cs}] WebSocket metadata became available after {attempts} checks",
                    cs=call_sid,
                    attempts=attempts,
                )
            return metadata

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None

        await asyncio.sleep(min(WS_METADATA_LOOKUP_POLL_INTERVAL_SECONDS, remaining))


async def authenticate_websocket_call(
    call_data: dict,
    session_state: dict,
    *,
    consume_token: bool = True,
) -> dict:
    """Authenticate the media WebSocket before any AI services start."""
    call_sid = _provider_call_id(call_data, session_state)
    if not call_sid:
        raise WebSocketAuthError("missing call_sid")

    metadata = await _wait_for_call_metadata(call_sid)
    if not metadata:
        raise WebSocketAuthError("unknown call_sid")

    provided_token = _provider_ws_token(call_data)
    if consume_token:
        from api.routes.call_context import WsTokenConsumeError, consume_ws_token

        try:
            return await consume_ws_token(call_sid, provided_token)
        except WsTokenConsumeError as exc:
            raise WebSocketAuthError(str(exc)) from exc

    expected_token = metadata.get("ws_token")
    if not expected_token:
        raise WebSocketAuthError("missing expected token")
    if metadata.get("ws_token_consumed"):
        raise WebSocketAuthError("token already consumed")
    if time.time() > float(metadata.get("ws_token_expires_at") or 0):
        raise WebSocketAuthError("token expired")
    if not provided_token or not hmac.compare_digest(str(expected_token), str(provided_token)):
        raise WebSocketAuthError("invalid token")

    return metadata


async def prepare_websocket_call(
    websocket: WebSocket,
    session_state: dict,
    *,
    consume_token: bool = True,
) -> dict:
    """Parse and authenticate the telephony start frame with a short timeout.

    This can run before active-call capacity is acquired so stalled or invalid
    WebSockets do not occupy an AI call slot.
    """
    try:
        transport_type, call_data = await asyncio.wait_for(
            parse_telephony_websocket(websocket),
            timeout=HANDSHAKE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise WebSocketAuthError("handshake timeout") from exc

    stream_sid = call_data.get("stream_id", "")
    call_data["query_params"] = dict(websocket.query_params)
    call_sid = _provider_call_id(call_data, session_state) or "unknown"
    session_state["call_sid"] = call_sid

    logger.info("[{cs}] Stream connected: {ss} (type={tt})", cs=call_sid, ss=stream_sid, tt=transport_type)

    metadata = await authenticate_websocket_call(
        call_data,
        session_state,
        consume_token=consume_token,
    )
    return {
        "transport_type": transport_type,
        "call_data": call_data,
        "metadata": metadata,
    }


SUPPORTED_CARTESIA_SAMPLE_RATES = {16000, 22050, 24000, 44100, 48000}
SUPPORTED_ELEVENLABS_SAMPLE_RATES = {16000, 22050, 24000, 44100}
TELNYX_WIDEBAND_CODEC = "L16"
class TelnyxAudioConfigError(Exception):
    """Raised when Telnyx starts a stream below Donna's required audio profile."""


def resolve_tts_provider(session_state: dict) -> str:
    """Resolve the active TTS provider after applying availability fallbacks."""
    cfg = get_settings()
    flags = session_state.get("_flags", {})
    requested_provider = cfg.tts_provider or flags.get("tts_provider", "elevenlabs")

    if requested_provider == "cartesia":
        if cfg.cartesia_api_key:
            return "cartesia"
        logger.warning("Cartesia requested but CARTESIA_API_KEY is missing; falling back to ElevenLabs")

    return "elevenlabs"


def get_audio_profile(session_state: dict) -> dict[str, int | str]:
    """Pick stable sample rates for the active telephony pipeline."""
    cfg = get_settings()
    provider = resolve_tts_provider(session_state)
    is_telnyx = session_state.get("_transport_type") == "telnyx"
    telnyx_profile = resolve_telnyx_audio_profile(cfg) if is_telnyx else None
    audio_in_sample_rate = cfg.telephony_internal_input_sample_rate
    if telnyx_profile and telnyx_profile.uses_l16_serializer:
        audio_in_sample_rate = telnyx_profile.sample_rate

    if is_telnyx and telnyx_profile and telnyx_profile.uses_l16_serializer:
        audio_out_sample_rate = telnyx_profile.sample_rate
    elif provider == "cartesia":
        audio_out_sample_rate = cfg.cartesia_output_sample_rate
        if audio_out_sample_rate not in SUPPORTED_CARTESIA_SAMPLE_RATES:
            logger.warning(
                "Unsupported Cartesia sample rate {rate}; using 48000",
                rate=audio_out_sample_rate,
            )
            audio_out_sample_rate = 48000
    else:
        audio_out_sample_rate = cfg.elevenlabs_output_sample_rate
        if audio_out_sample_rate not in SUPPORTED_ELEVENLABS_SAMPLE_RATES:
            logger.warning(
                "Unsupported ElevenLabs sample rate {rate}; using 44100",
                rate=audio_out_sample_rate,
            )
            audio_out_sample_rate = 44100

    return {
        "tts_provider": provider,
        "audio_in_sample_rate": audio_in_sample_rate,
        "audio_out_sample_rate": audio_out_sample_rate,
    }


def create_tts_service(session_state: dict):
    """Select TTS provider based on feature flag and language.

    Uses session_state["_flags"]["tts_provider"] to pick Cartesia or ElevenLabs.
    Falls back to ElevenLabs if Cartesia key is missing or flag is unset.
    When Donna's language is Spanish, uses a Spanish-capable voice.
    """
    cfg = get_settings()
    audio_profile = get_audio_profile(session_state)
    provider = str(audio_profile["tts_provider"])
    output_sample_rate = int(audio_profile["audio_out_sample_rate"])
    donna_lang = session_state.get("_donna_language", "en")

    if provider == "cartesia":
        is_telnyx = session_state.get("_transport_type") == "telnyx"
        # Cartesia Spanish voice (warm female) or default English
        voice_id = cfg.cartesia_voice_id or "1242fb95-7ddd-44ac-8a05-9e8a22a6137d"
        if donna_lang == "es" and cfg.cartesia_voice_id_es:
            voice_id = cfg.cartesia_voice_id_es
        logger.info("TTS provider: Cartesia Sonic 3 (lang={lang})", lang=donna_lang)
        return CartesiaTTSService(
            api_key=cfg.cartesia_api_key,
            voice_id=voice_id,
            model="sonic-3",
            sample_rate=output_sample_rate,
            # Keep linear PCM in-process; the telephony serializer owns the final
            # L16/16 kHz conversion at the provider edge.
            encoding="pcm_s16le",
            params=CartesiaTTSService.InputParams(
                generation_config=GenerationConfig(
                    speed=0.94 if is_telnyx else 1.05,
                    volume=0.9 if is_telnyx else 1.2,
                    emotion="enthusiastic",
                ),
                language=("es" if donna_lang == "es" else "en"),
            ),
        )

    # ElevenLabs: use Spanish voice ID if configured, otherwise default
    voice_id = cfg.elevenlabs_voice_id
    if donna_lang == "es" and cfg.elevenlabs_voice_id_es:
        voice_id = cfg.elevenlabs_voice_id_es
    logger.info("TTS provider: ElevenLabs {model} (lang={lang})", model=cfg.elevenlabs_model, lang=donna_lang)
    return ElevenLabsTTSService(
        api_key=cfg.elevenlabs_api_key,
        voice_id=voice_id,
        model=cfg.elevenlabs_model,
        sample_rate=output_sample_rate,
        params=ElevenLabsTTSService.InputParams(speed=0.85),
    )


def resolve_voice_backend(cfg, session_state: dict) -> str:
    """Resolve voice backend while keeping Gemini Live out of production."""
    voice_backend = (
        cfg.voice_backend
        or (session_state.get("_flags") or {}).get("voice_backend", "claude")
    )
    voice_backend = str(voice_backend or "claude").strip().lower()
    if voice_backend == "gemini_live" and is_production_environment():
        logger.error("Blocked voice_backend=gemini_live in production; using Claude pipeline")
        return "claude"
    return voice_backend


def resolve_vad_params(transport_type: str, call_type: str | None) -> dict[str, float]:
    """Return VAD settings tuned for senior speech unless caller is a new customer."""
    is_new_customer = call_type == "new_customer"
    return {
        "start_secs": 0.3,
        "stop_secs": 0.8 if is_new_customer else 1.2,
        "confidence": 0.68,
        "min_volume": 0.5,
    }


def _create_telephony_serializer(
    *,
    transport_type: str,
    call_data: dict,
    stream_sid: str,
    call_sid: str,
    cfg,
):
    """Create the provider serializer at the only lossy audio boundary."""
    if transport_type == "telnyx":
        try:
            profile = resolve_telnyx_audio_profile(cfg)
        except TelnyxAudioProfileError as exc:
            raise TelnyxAudioConfigError(str(exc)) from exc

        observed_encoding = (call_data.get("outbound_encoding") or "").upper()
        if observed_encoding and observed_encoding != profile.codec:
            raise TelnyxAudioConfigError(
                f"Telnyx stream started as {observed_encoding}; "
                f"Donna Telnyx is configured for {profile.label}"
            )

        logger.info(
            "[{cs}] Telnyx serializer codec_in={codec_in} codec_out={codec_out} wire_rate={rate}Hz",
            cs=call_sid,
            codec_in=profile.codec,
            codec_out=profile.codec,
            rate=profile.sample_rate,
        )
        return DonnaTelnyxFrameSerializer(
            stream_id=stream_sid,
            call_control_id=call_sid,
            outbound_encoding=profile.codec,
            inbound_encoding=profile.codec,
            api_key=cfg.telnyx_api_key,
            params=DonnaTelnyxFrameSerializer.InputParams(
                telnyx_sample_rate=profile.sample_rate,
                outbound_encoding=profile.codec,
                inbound_encoding=profile.codec,
                l16_input_byte_order=profile.l16_input_byte_order,
                l16_output_byte_order=profile.l16_output_byte_order,
            ),
        )

    raise TelnyxAudioConfigError(
        f"Unsupported telephony transport {transport_type}; Donna voice is configured for Telnyx"
    )


async def _safe_post_call(session_state: dict, conversation_tracker, elapsed: int, call_sid: str):
    """Run post-call in background with its own error boundary."""
    try:
        await run_post_call(session_state, conversation_tracker, elapsed)
    except Exception as e:
        logger.error("[{cs}] Background post-call failed: {err}", cs=call_sid, err=str(e))


def _start_post_call_once(
    session_state: dict,
    conversation_tracker,
    elapsed: int,
    call_sid: str,
    trigger: str,
) -> asyncio.Task:
    """Start post-call processing once, regardless of how the pipeline ended."""
    existing = session_state.get("_post_call_task")
    if existing is not None:
        return existing

    conversation_tracker.flush()
    logger.info("[{cs}] Scheduling post-call processing ({trigger})", cs=call_sid, trigger=trigger)
    task = asyncio.create_task(
        _safe_post_call(session_state, conversation_tracker, elapsed, call_sid)
    )
    session_state["_post_call_task"] = task
    return task


async def _load_call_metadata(call_sid: str, session_state: dict) -> dict:
    """Load call metadata from local state, then Redis for multi-instance routing."""
    call_meta = session_state.get("_call_metadata", {})
    metadata = call_meta.get(call_sid, {}) if isinstance(call_meta, dict) else {}
    if metadata:
        return metadata

    try:
        from lib.redis_client import get_shared_state

        state = get_shared_state()
        if not getattr(state, "is_shared", False):
            return {}

        from lib.shared_state_phi import decode_phi_payload

        metadata = decode_phi_payload(
            await state.get(f"call_metadata:{call_sid}"),
            label="call metadata",
        ) or {}
        if isinstance(metadata, dict) and metadata:
            if isinstance(call_meta, dict):
                call_meta[call_sid] = metadata
            logger.info("[{cs}] Loaded call metadata from shared state", cs=call_sid)
            return metadata
    except Exception as e:
        logger.warning("[{cs}] Shared call metadata lookup failed: {err}", cs=call_sid, err=str(e))

    return {}


async def run_bot(websocket: WebSocket, session_state: dict, prepared_call: dict | None = None) -> None:
    """Run the Donna voice pipeline for a single call.

    Args:
        websocket: Starlette WebSocket from Telnyx.
        session_state: Pre-populated dict with call context:
            - senior_id: str
            - senior: dict (profile)
            - memory_context: str | None
            - greeting: str | None
            - reminder_prompt: str | None
            - reminder_delivery: dict | None
            - reminders_delivered: set
            - conversation_id: str | None
            - call_sid: str | None
            - call_type: str ("schedule" | "new_customer" | "consent" | "discovery" | subscriber/default)
            - previous_calls_summary: str | None
            - todays_context: str | None
    """
    start_time = time.time()
    cfg = get_settings()

    # -------------------------------------------------------------------------
    # Parse telephony WebSocket handshake
    # -------------------------------------------------------------------------
    if prepared_call is None:
        try:
            prepared_call = await prepare_websocket_call(websocket, session_state)
        except WebSocketAuthError as exc:
            logger.warning("[unknown] WebSocket auth failed: {reason}", reason=str(exc))
            return

    transport_type = prepared_call["transport_type"]
    call_data = prepared_call["call_data"]
    metadata = prepared_call["metadata"]
    stream_sid = call_data.get("stream_id", "")
    call_sid = _provider_call_id(call_data, session_state) or "unknown"
    session_state["call_sid"] = call_sid
    session_state["_transport_type"] = transport_type

    # Populate session_state from call_metadata seeded by the Telnyx route.
    if metadata:
        # Use `or` assignment — setdefault won't overwrite pre-initialized None values
        session_state["senior"] = session_state.get("senior") or metadata.get("senior")
        session_state["senior_id"] = session_state.get("senior_id") or (metadata.get("senior") or {}).get("id")
        session_state["memory_context"] = session_state.get("memory_context") or metadata.get("memory_context")
        session_state["conversation_id"] = session_state.get("conversation_id") or metadata.get("conversation_id")
        session_state["reminder_prompt"] = session_state.get("reminder_prompt") or metadata.get("reminder_prompt")
        if metadata.get("queue_id"):
            session_state["queue_id"] = metadata["queue_id"]
        if metadata.get("reservation_id"):
            session_state["reservation_id"] = metadata["reservation_id"]
        # call_type is pre-initialized to "check-in" (truthy), so `or` won't overwrite.
        # Always take metadata's value when present.
        if metadata.get("call_type"):
            session_state["call_type"] = metadata["call_type"]
        reminder_ctx = metadata.get("reminder_context")
        if reminder_ctx:
            session_state["reminder_delivery"] = session_state.get("reminder_delivery") or reminder_ctx.get("delivery")
        greeting = metadata.get("pre_generated_greeting")
        if greeting:
            session_state["greeting"] = session_state.get("greeting") or greeting
        session_state["previous_calls_summary"] = session_state.get("previous_calls_summary") or metadata.get("previous_calls_summary")
        session_state["recent_turns"] = session_state.get("recent_turns") or metadata.get("recent_turns")
        session_state["todays_context"] = session_state.get("todays_context") or metadata.get("todays_context")
        session_state["news_context"] = session_state.get("news_context") or metadata.get("news_context")
        session_state["last_call_analysis"] = session_state.get("last_call_analysis") or metadata.get("last_call_analysis")
        if metadata.get("has_caregiver_notes"):
            session_state["_has_caregiver_notes"] = True
        # Store actual caregiver note content for system prompt injection
        if metadata.get("caregiver_notes_content"):
            session_state["_caregiver_notes_content"] = metadata["caregiver_notes_content"]
        if metadata.get("call_settings"):
            session_state["call_settings"] = metadata["call_settings"]
        # Carry Telnyx AMD classification through so post-call can persist it
        # on conversations.amd_result for misclassification analytics.
        amd_result = metadata.get("telnyx_amd_result")
        if amd_result:
            session_state["_amd_result"] = str(amd_result)
        if "is_outbound" in metadata:
            session_state["is_outbound"] = metadata["is_outbound"]
        # Populate prospect data for new customer calls
        if metadata.get("prospect"):
            session_state["prospect"] = metadata["prospect"]
            session_state["prospect_id"] = metadata.get("prospect_id")

        # Generate sentiment-aware greeting if none was pre-generated
        if not session_state.get("greeting") and session_state.get("senior"):
            try:
                from services.greetings import get_greeting
                analysis_data = session_state.get("last_call_analysis") or {}
                # Parse call_quality — may be JSON string or dict
                call_quality = analysis_data.get("call_quality")
                if isinstance(call_quality, str):
                    import json as _json
                    try:
                        call_quality = _json.loads(call_quality)
                    except Exception:
                        call_quality = {}
                senior_data = session_state["senior"]
                settings = session_state.get("call_settings") or {}
                greeting_result = get_greeting(
                    senior_name=senior_data.get("name", ""),
                    timezone=senior_data.get("timezone"),
                    interests=senior_data.get("interests"),
                    last_call_summary=session_state.get("previous_calls_summary") or analysis_data.get("summary"),
                    senior_id=senior_data.get("id"),
                    news_context=session_state.get("news_context"),
                    interest_scores=senior_data.get("interest_scores"),
                    last_call_sentiment=(call_quality or {}).get("rapport"),
                    last_call_engagement=analysis_data.get("engagement_score"),
                    followup_chance=settings.get("greeting_followup_chance", 0.6),
                )
                session_state["greeting"] = greeting_result.get("greeting", "")
            except Exception as e:
                logger.error("[{cs}] Error generating greeting: {err}", cs=call_sid, err=str(e))
        logger.info(
            "[{cs}] Populated session: senior_present={has_senior}, memory={mem_len}ch, greeting={gr}, reminder={rem}",
            cs=call_sid,
            has_senior=bool(session_state.get("senior")),
            mem_len=len(session_state.get("memory_context") or ""),
            gr=bool(session_state.get("greeting")),
            rem=bool(session_state.get("reminder_prompt")),
        )

    # Also merge custom parameters from the telephony WebSocket metadata.
    body = call_data.get("body", {})
    if body.get("senior_id") and not session_state.get("senior_id"):
        session_state["senior_id"] = body["senior_id"]
    if body.get("conversation_id") and not session_state.get("conversation_id"):
        session_state["conversation_id"] = body["conversation_id"]
    if body.get("call_type") and session_state.get("call_type") == "check-in":
        session_state["call_type"] = body["call_type"]

    # Resolve feature flags for this call
    try:
        from lib.growthbook import resolve_flags
        senior = session_state.get("senior") or {}
        session_state["_flags"] = await resolve_flags(
            senior_id=session_state.get("senior_id"),
            timezone=senior.get("timezone"),
            call_type=session_state.get("call_type", "check-in"),
        )
    except Exception as e:
        logger.warning("[{cs}] Flag resolution failed — using defaults: {err}", cs=call_sid, err=str(e))

    audio_profile = get_audio_profile(session_state)
    audio_in_sample_rate = int(audio_profile["audio_in_sample_rate"])
    audio_out_sample_rate = int(audio_profile["audio_out_sample_rate"])

    logger.info("[{cs}] Starting pipeline senior_id={sid}", cs=call_sid, sid=str(session_state.get("senior_id") or "")[:8])
    logger.info(
        "[{cs}] Audio profile provider={provider} in={audio_in}Hz out={audio_out}Hz",
        cs=call_sid,
        provider=audio_profile["tts_provider"],
        audio_in=audio_in_sample_rate,
        audio_out=audio_out_sample_rate,
    )

    # -------------------------------------------------------------------------
    # Transport (Telnyx ↔ FastAPI WebSocket)
    # -------------------------------------------------------------------------
    # Onboarding callers are adult caregivers (typical speech pace) — shorter pause.
    # Senior calls keep longer pause tolerance for elderly speech patterns.
    vad_profile = resolve_vad_params(transport_type, session_state.get("call_type"))
    vad_stop_secs = vad_profile["stop_secs"]
    vad_start_secs = vad_profile["start_secs"]
    vad_confidence = vad_profile["confidence"]
    vad_min_volume = vad_profile["min_volume"]
    logger.info(
        "[{cs}] VAD profile provider={provider} confidence={confidence} start_secs={start_secs} stop_secs={stop_secs} min_volume={min_volume}",
        cs=call_sid,
        provider=transport_type,
        confidence=vad_confidence,
        start_secs=vad_start_secs,
        stop_secs=vad_stop_secs,
        min_volume=vad_min_volume,
    )

    try:
        serializer = _create_telephony_serializer(
            transport_type=transport_type,
            call_data=call_data,
            stream_sid=stream_sid,
            call_sid=call_sid,
            cfg=cfg,
        )
    except TelnyxAudioConfigError as exc:
        logger.error("[{cs}] {err}", cs=call_sid, err=str(exc))
        return

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_out_10ms_chunks=2 if transport_type == "telnyx" else 4,
            add_wav_header=False,
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(
                    confidence=vad_confidence,
                    start_secs=vad_start_secs,
                    stop_secs=vad_stop_secs,
                    min_volume=vad_min_volume,
                ),
            ),
            serializer=serializer,
        ),
    )

    # -------------------------------------------------------------------------
    # Route to Gemini Live pipeline if flag is set
    # Env var VOICE_BACKEND=gemini_live overrides GrowthBook flag
    # -------------------------------------------------------------------------
    voice_backend = resolve_voice_backend(cfg, session_state)
    if voice_backend == "gemini_live":
        logger.info("[{cs}] voice_backend=gemini_live — delegating to Gemini pipeline", cs=call_sid)
        from bot_gemini import run_gemini_pipeline
        return await run_gemini_pipeline(session_state, transport, start_time)

    # -------------------------------------------------------------------------
    # STT / LLM / TTS — swap for mocks in load test mode
    # -------------------------------------------------------------------------
    load_test = cfg.load_test_mode

    if load_test:
        logger.warning("LOAD_TEST_MODE enabled — using mock STT/LLM/TTS")
        from tests.mocks.mock_stt import MockSTTProcessor
        from tests.mocks.mock_llm import MockLLMProcessor
        from tests.mocks.mock_tts import MockTTSProcessor

        stt = MockSTTProcessor()
        mock_llm = MockLLMProcessor(
            default_response="That's wonderful! I'm glad to hear you're doing well today.",
        )
        tts = MockTTSProcessor()
        # Real LLM needed for create_context_aggregator(); mock replaces it in pipeline
        llm = AnthropicLLMService(
            api_key=cfg.anthropic_api_key or "fake-key-load-test",
            model=cfg.anthropic_model,
        )
    else:
        # Resolve Donna's conversation language from senior's familyInfo
        _senior = session_state.get("senior") or {}
        _family_info = _senior.get("family_info") or _senior.get("familyInfo") or {}
        if isinstance(_family_info, str):
            import json as _json
            try:
                _family_info = _json.loads(_family_info)
            except Exception:
                _family_info = {}
        _donna_lang = _family_info.get("donnaLanguage", "en")
        _stt_language = "es" if _donna_lang == "es" else "en"
        # Store resolved language for TTS selection
        session_state["_donna_language"] = _donna_lang

        stt = DeepgramSTTService(
            api_key=cfg.deepgram_api_key,
            live_options=LiveOptions(
                model="nova-3-general",
                language=_stt_language,
                sample_rate=audio_in_sample_rate,
                encoding="linear16",
                channels=1,
                interim_results=True,
                smart_format=True,
                punctuate=True,
            ),
        )

        llm = AnthropicLLMService(
            api_key=cfg.anthropic_api_key,
            model=cfg.anthropic_model,
            params=AnthropicLLMService.InputParams(
                enable_prompt_caching=True,
                # Hard cap on response length. The system prompt says "Keep
                # responses 1-2 sentences max" but the mock-call harness
                # showed Claude regularly running 300+ tokens (~50+ words).
                # 220 tokens ≈ 165 words ≈ 3 long sentences — enough headroom
                # for compound responses (filler + answer + follow-up
                # question) while making "the senior monologue" physically
                # impossible. Override per-environment with the existing
                # ANTHROPIC_MAX_TOKENS env var if needed.
                max_tokens=cfg.anthropic_max_tokens,
            ),
        )

        tts = create_tts_service(session_state)

    # -------------------------------------------------------------------------
    # Custom processors
    # -------------------------------------------------------------------------
    quick_observer = QuickObserverProcessor(session_state=session_state)
    conversation_director = ConversationDirectorProcessor(session_state=session_state)
    conversation_state = ConversationState()
    user_conversation_tracker = ConversationTrackerProcessor(
        session_state=session_state,
        state=conversation_state,
        track_assistant=False,
    )
    conversation_tracker = ConversationTrackerProcessor(
        session_state=session_state,
        state=conversation_state,
        track_user=False,
    )
    guidance_stripper = GuidanceStripperProcessor()
    audio_preroll = InitialAudioPrerollProcessor(
        preroll_ms=120 if transport_type == "telnyx" else 0
    )
    metrics_logger = MetricsLoggerProcessor(session_state=session_state)

    # Record call start time for Director's phase timing
    session_state["_call_start_time"] = time.time()

    # Store conversation tracker in session_state for Flow nodes to reference
    session_state["_conversation_tracker"] = conversation_tracker

    # -------------------------------------------------------------------------
    # Context aggregators (user ↔ assistant message pairing)
    # -------------------------------------------------------------------------
    context = OpenAILLMContext()
    context_aggregator = llm.create_context_aggregator(context)

    # Expose context for Director's ephemeral message stripping
    session_state["_llm_context"] = context

    # -------------------------------------------------------------------------
    # Pipeline assembly
    # -------------------------------------------------------------------------
    # In load test mode, swap the real LLM for the mock in the pipeline
    pipeline_llm = mock_llm if load_test else llm

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            quick_observer,
            user_conversation_tracker,
            conversation_director,
            context_aggregator.user(),
            pipeline_llm,
            guidance_stripper,
            conversation_tracker,
            tts,
            audio_preroll,
            transport.output(),
            context_aggregator.assistant(),
            metrics_logger,
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
            audio_in_sample_rate=audio_in_sample_rate,
            audio_out_sample_rate=audio_out_sample_rate,
        ),
    )

    # Give processors references to the task so they can force-end calls
    # Quick Observer: instant goodbye detection (regex, 3.5s delay)
    # Director: time-based call ending + phase-based fallbacks
    quick_observer.set_pipeline_task(task)
    conversation_director.set_pipeline_task(task)

    # -------------------------------------------------------------------------
    # Flow Manager (call phase management)
    # -------------------------------------------------------------------------
    # Per-call-type tool factory dispatch lives in flows.tools.select_flows_tools
    # so bot.py and the live-sim pipeline (tests/simulation/pipeline.py) stay
    # in lockstep. Register new call types in _CALL_TYPE_TOOL_FACTORIES there.
    flows_tools = select_flows_tools(session_state)
    # Stash for Quick Observer's programmatic transition path. When QO detects
    # a strong goodbye, it builds the winding_down node directly and asks
    # flow_manager to switch — bypassing the LLM tool call that's unreliable.
    session_state["_flow_tools"] = flows_tools
    initial_node = build_initial_node(session_state, flows_tools)

    flow_manager = FlowManager(
        task=task,
        llm=llm,
        context_aggregator=context_aggregator,
        transport=transport,
    )

    # Store flow_manager in session state for processors that need it
    session_state["_flow_manager"] = flow_manager

    # -------------------------------------------------------------------------
    # Event handlers
    # -------------------------------------------------------------------------
    @transport.event_handler("on_client_connected")
    async def on_connected(transport_ref, websocket_ref):
        logger.info("[{cs}] Client connected, initializing flow", cs=call_sid)
        # Warm up Groq TCP+TLS immediately before greeting plays.
        from services.director_llm import warmup_fast_providers
        asyncio.create_task(warmup_fast_providers())
        await flow_manager.initialize(initial_node)

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport_ref, websocket_ref):
        elapsed = round(time.time() - start_time)
        logger.info("[{cs}] Client disconnected after {s}s", cs=call_sid, s=elapsed)
        # Set end_reason if not already set by Quick Observer or Director
        session_state.setdefault("_end_reason", "user_hangup")
        # End pipeline first so runner.run() unblocks, then run post-call in background.
        # Previously run_post_call was awaited before EndFrame, so if Gemini/OpenAI
        # hung during analysis the pipeline would never terminate.
        await task.queue_frame(EndFrame())
        _start_post_call_once(
            session_state,
            conversation_tracker,
            elapsed,
            call_sid,
            "client_disconnected",
        )

    # -------------------------------------------------------------------------
    # Run pipeline
    # -------------------------------------------------------------------------
    runner = PipelineRunner(handle_sigint=False)

    logger.info("[{cs}] Pipeline ready, running...", cs=call_sid)
    await runner.run(task)

    logger.info("[{cs}] Pipeline ended", cs=call_sid)

    elapsed = round(time.time() - start_time)
    session_state.setdefault("_end_reason", "pipeline_ended")
    post_call_task = _start_post_call_once(
        session_state,
        conversation_tracker,
        elapsed,
        call_sid,
        "pipeline_ended",
    )
    await post_call_task
