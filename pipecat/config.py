"""Centralized configuration — all environment variables in one place.

Import `settings` from this module instead of calling os.getenv() directly.
Lazy-loaded on first access; reads from environment at that time.

Usage:
    from config import settings
    print(settings.anthropic_api_key)
    print(settings.telnyx_phone_number)
"""

import os
import base64
from dataclasses import dataclass, field
from functools import lru_cache


DEFAULT_JWT_SECRET = "donna-admin-secret-change-me"


@dataclass(frozen=True)
class Settings:
    """All environment variables used by the Donna Pipecat service."""

    # ---- Server ----
    port: int = 7860
    environment: str = ""
    log_level: str = ""
    base_url: str = ""
    pipecat_public_url: str = ""
    admin_url: str = ""
    railway_public_domain: str = ""

    # ---- Database ----
    database_url: str = ""  # Required in production
    db_pool_min: int = 5
    db_pool_max: int = 50

    # ---- Archived Twilio voice settings ----
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_phone_number: str = ""

    # ---- Telephony Provider ----
    telephony_provider: str = "telnyx"

    # ---- Telnyx ----
    telnyx_api_key: str = ""
    telnyx_public_key: str = ""
    telnyx_phone_number: str = ""
    telnyx_connection_id: str = ""
    telnyx_stream_codec: str = "L16"
    telnyx_stream_sample_rate: int = 16000
    telnyx_stream_track: str = "inbound_track"
    telnyx_bidirectional_target_legs: str = "both"
    telnyx_l16_input_byte_order: str = "little"
    telnyx_l16_output_byte_order: str = "little"
    telnyx_webhook_tolerance_seconds: int = 300
    telnyx_answering_machine_detection: str = "premium"
    telnyx_amd_total_analysis_time_millis: int = 0
    telnyx_amd_greeting_total_analysis_time_millis: int = 0
    telnyx_voicemail_message: str = "Hi, it's Donna. I was calling to check in. I'll try again later. Take care."
    telnyx_voicemail_voice: str = "female"
    telnyx_voicemail_service_level: str = "basic"
    telnyx_voicemail_language: str = "en-US"
    telnyx_voicemail_fallback_delay_seconds: float = 8.0

    # ---- AI Services ----
    anthropic_api_key: str = ""
    deepgram_api_key: str = ""
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "jixzNFANovqRhzplvmwR"
    elevenlabs_voice_id_es: str = ""
    elevenlabs_model: str = "eleven_flash_v2_5"
    cartesia_api_key: str = ""
    cartesia_voice_id: str = "f786b574-daa5-4673-aa0c-cbe3e8534c02"
    cartesia_voice_id_es: str = ""
    google_api_key: str = ""
    openai_api_key: str = ""
    tavily_api_key: str = ""
    cerebras_api_key: str = ""
    groq_api_key: str = ""

    # ---- Audio ----
    telephony_internal_input_sample_rate: int = 16000
    elevenlabs_output_sample_rate: int = 44100
    cartesia_output_sample_rate: int = 48000
    gemini_internal_output_sample_rate: int = 24000

    # ---- Model Selection ----
    fast_observer_model: str = "gemini-3-flash-preview"
    cerebras_director_model: str = "gpt-oss-120b"
    groq_director_model: str = "openai/gpt-oss-20b"
    call_analysis_model: str = "gemini-3-flash-preview"
    anthropic_model: str = "claude-haiku-4-5-20251001"

    # ---- Auth ----
    jwt_secret: str = "donna-admin-secret-change-me"
    jwt_secret_previous: str = ""  # Old JWT secret during credential rotation
    donna_api_key: str = ""
    donna_api_keys: str = ""
    cofounder_api_key_1: str = ""
    cofounder_api_key_2: str = ""
    clerk_secret_key: str = ""
    clerk_publishable_key: str = ""
    clerk_jwks_url: str = ""  # Auto-derived from publishable key if not set

    # ---- Monitoring ----
    sentry_dsn: str = ""

    # ---- Scalability ----
    max_concurrent_calls: int = 50
    load_test_mode: bool = False
    redis_url: str = ""  # Optional — enables multi-instance shared state
    pipecat_require_redis: bool = False
    pipecat_draining: bool = False
    instance_id: str = ""

    # ---- Replica Readiness Gate (Phase 3 exit criteria) ----
    # A new replica only advertises itself as available capacity after these
    # checks pass. Each check can be disabled in dev where its cost is wasted
    # (e.g. a vendor session against a stub backend).
    readiness_min_pool_connections: int = 3
    readiness_check_timeout_seconds: float = 30.0
    readiness_require_prompt_cache_primer: bool = True
    readiness_require_deepgram_session: bool = True
    readiness_require_tts_session: bool = True
    readiness_require_growthbook_loaded: bool = True
    readiness_require_db_pool_warm: bool = True
    readiness_require_breakers_closed: bool = True

    # ---- GrowthBook ----
    growthbook_api_host: str = ""
    growthbook_client_key: str = ""

    # ---- Encryption ----
    field_encryption_key: str = ""  # 32-byte base64url key for PHI encryption

    # ---- Feature Flags ----
    scheduler_enabled: bool = False
    pipecat_retention_enabled: bool = False
    post_call_queue_enabled: bool = False
    post_call_worker_enabled: bool = False
    voice_backend: str = ""
    tts_provider: str = ""
    telephony_ws_handshake_timeout_seconds: float = 5.0

    # ---- Data Retention (HIPAA) ----
    retention_conversations_days: int = 365
    retention_conversation_metadata_days: int = 1095
    retention_memories_days: int = 730
    retention_call_analyses_days: int = 365
    retention_daily_context_days: int = 90
    retention_call_metrics_days: int = 180
    retention_inactive_reminders_days: int = 365
    retention_reminder_deliveries_days: int = 90
    retention_notifications_days: int = 180
    retention_caregiver_notes_days: int = 365
    retention_prospects_days: int = 90
    retention_inactive_senior_review_days: int = 365
    retention_call_queue_days: int = 90
    retention_call_attempts_days: int = 180
    retention_post_call_jobs_days: int = 180
    retention_outbound_call_guards_days: int = 30
    retention_scheduler_shadow_comparisons_days: int = 30
    retention_waitlist_days: int = 365
    retention_audit_logs_days: int = 2190

    @property
    def is_production(self) -> bool:
        return self.environment == "production" or bool(self.railway_public_domain)


def _truthy(value: str | None) -> bool:
    return str(value or "").lower() in {"1", "true", "yes", "on"}


def is_production_environment() -> bool:
    return os.getenv("ENVIRONMENT") == "production" or bool(os.getenv("RAILWAY_PUBLIC_DOMAIN"))


def _decode_field_encryption_key(raw: str) -> bytes | None:
    if not raw:
        return None
    try:
        padded = raw + "=" * (-len(raw) % 4)
        return base64.urlsafe_b64decode(padded)
    except Exception:
        return None


def is_valid_field_encryption_key(raw: str) -> bool:
    decoded = _decode_field_encryption_key(raw)
    return decoded is not None and len(decoded) == 32


def parse_service_api_keys(raw: str | None = None) -> dict[str, str]:
    value = os.getenv("DONNA_API_KEYS", "") if raw is None else raw
    keys: dict[str, str] = {}
    for entry in value.split(","):
        item = entry.strip()
        if not item or ":" not in item:
            continue
        label, key = item.split(":", 1)
        label = label.strip()
        key = key.strip()
        if label and key:
            keys[label] = key
    if not is_production_environment() and os.getenv("DONNA_API_KEY"):
        keys["legacy"] = os.getenv("DONNA_API_KEY", "")
    return keys


def get_service_api_key(label: str) -> str | None:
    return parse_service_api_keys().get(label)


def get_pipecat_public_url() -> str:
    public_url = os.getenv("PIPECAT_PUBLIC_URL", "")
    if public_url:
        return public_url.rstrip("/")
    base_url = os.getenv("BASE_URL", "")
    if not is_production_environment() and base_url:
        return base_url.rstrip("/")
    return ""


def validate_production_config() -> list[str]:
    if not is_production_environment():
        return []

    errors: list[str] = []
    jwt_secret = os.getenv("JWT_SECRET", DEFAULT_JWT_SECRET)
    field_key = os.getenv("FIELD_ENCRYPTION_KEY", "")
    public_url = os.getenv("PIPECAT_PUBLIC_URL", "")

    if not jwt_secret or jwt_secret == DEFAULT_JWT_SECRET:
        errors.append("JWT_SECRET must be set to a non-default value")
    if not parse_service_api_keys():
        errors.append("DONNA_API_KEYS must contain at least one labeled key")
    if not is_valid_field_encryption_key(field_key):
        errors.append("FIELD_ENCRYPTION_KEY must decode to 32 bytes")
    telephony_provider = os.getenv("TELEPHONY_PROVIDER", "telnyx").lower()
    if telephony_provider != "telnyx":
        errors.append("TELEPHONY_PROVIDER must be telnyx for voice calls")
    if os.getenv("TELNYX_STREAM_CODEC", "L16").upper() != "L16":
        errors.append("TELNYX_STREAM_CODEC must be L16")
    try:
        telnyx_sample_rate = int(os.getenv("TELNYX_STREAM_SAMPLE_RATE", "16000"))
    except ValueError:
        telnyx_sample_rate = 0
    if telnyx_sample_rate != 16000:
        errors.append("TELNYX_STREAM_SAMPLE_RATE must be 16000")
    if not os.getenv("TELNYX_API_KEY", ""):
        errors.append("TELNYX_API_KEY is required")
    if not os.getenv("TELNYX_PUBLIC_KEY", ""):
        errors.append("TELNYX_PUBLIC_KEY is required")
    if not os.getenv("TELNYX_PHONE_NUMBER", ""):
        errors.append("TELNYX_PHONE_NUMBER is required")
    if not os.getenv("TELNYX_CONNECTION_ID", ""):
        errors.append("TELNYX_CONNECTION_ID is required")
    if not public_url or not public_url.startswith("https://"):
        errors.append("PIPECAT_PUBLIC_URL must be an https:// URL")
    if not os.getenv("ANTHROPIC_API_KEY", ""):
        errors.append("ANTHROPIC_API_KEY is required")
    if not os.getenv("DEEPGRAM_API_KEY", ""):
        errors.append("DEEPGRAM_API_KEY is required")

    tts_provider = os.getenv("TTS_PROVIDER", "elevenlabs").strip().lower() or "elevenlabs"
    if tts_provider == "cartesia":
        if not os.getenv("CARTESIA_API_KEY", ""):
            errors.append("CARTESIA_API_KEY is required when TTS_PROVIDER=cartesia")
    elif tts_provider == "elevenlabs":
        if not os.getenv("ELEVENLABS_API_KEY", ""):
            errors.append("ELEVENLABS_API_KEY is required")
    else:
        errors.append("TTS_PROVIDER must be elevenlabs or cartesia when set")

    if (
        "gemini" in os.getenv("FAST_OBSERVER_MODEL", "gemini-3-flash-preview").lower()
        or "gemini" in os.getenv("CALL_ANALYSIS_MODEL", "gemini-3-flash-preview").lower()
    ) and not os.getenv("GOOGLE_API_KEY", ""):
        errors.append("GOOGLE_API_KEY is required for Gemini observer or analysis models")
    has_shared_state = bool(
        os.getenv("REDIS_URL", "")
        or (
            os.getenv("UPSTASH_REDIS_REST_URL", "")
            and os.getenv("UPSTASH_REDIS_REST_TOKEN", "")
        )
    )
    if _truthy(os.getenv("PIPECAT_REQUIRE_REDIS")) and not has_shared_state:
        errors.append("REDIS_URL or UPSTASH_REDIS_REST_URL/TOKEN is required when PIPECAT_REQUIRE_REDIS=true")
    if _truthy(os.getenv("REDIS_RATE_LIMITS_ENABLED")) and not os.getenv("REDIS_URL", ""):
        errors.append("REDIS_URL is required when REDIS_RATE_LIMITS_ENABLED=true")
    if os.getenv("VOICE_BACKEND", "").strip().lower() == "gemini_live":
        errors.append("VOICE_BACKEND=gemini_live is not allowed in production")

    return errors


def assert_production_config() -> None:
    errors = validate_production_config()
    if errors:
        raise RuntimeError(
            "Production security configuration invalid: " + "; ".join(errors)
        )


@lru_cache(maxsize=1)
def _load_settings() -> Settings:
    """Load settings from environment. Cached after first call."""

    def _env(key: str, default: str = "") -> str:
        return os.environ.get(key, default)

    def _env_int(key: str, default: int) -> int:
        try:
            return int(_env(key, str(default)))
        except ValueError:
            return default

    def _env_float(key: str, default: float) -> float:
        try:
            return float(_env(key, str(default)))
        except ValueError:
            return default

    return Settings(
        # Server
        port=int(_env("PORT", "7860")),
        environment=_env("ENVIRONMENT"),
        log_level=_env("LOG_LEVEL", "INFO" if is_production_environment() else "DEBUG"),
        base_url=_env("BASE_URL"),
        pipecat_public_url=_env("PIPECAT_PUBLIC_URL"),
        admin_url=_env("ADMIN_URL"),
        railway_public_domain=_env("RAILWAY_PUBLIC_DOMAIN"),
        # Database
        database_url=_env("DATABASE_URL"),
        db_pool_min=int(_env("DB_POOL_MIN", "5")),
        db_pool_max=int(_env("DB_POOL_MAX", "50")),
        # Archived Twilio voice settings
        twilio_account_sid=_env("TWILIO_ACCOUNT_SID"),
        twilio_auth_token=_env("TWILIO_AUTH_TOKEN"),
        twilio_phone_number=_env("TWILIO_PHONE_NUMBER"),
        # Telephony Provider
        telephony_provider=_env("TELEPHONY_PROVIDER", "telnyx").lower(),
        # Telnyx
        telnyx_api_key=_env("TELNYX_API_KEY"),
        telnyx_public_key=_env("TELNYX_PUBLIC_KEY"),
        telnyx_phone_number=_env("TELNYX_PHONE_NUMBER"),
        telnyx_connection_id=_env("TELNYX_CONNECTION_ID"),
        telnyx_stream_codec=_env("TELNYX_STREAM_CODEC", "L16").upper(),
        telnyx_stream_sample_rate=_env_int("TELNYX_STREAM_SAMPLE_RATE", 16000),
        telnyx_stream_track=_env("TELNYX_STREAM_TRACK", "inbound_track"),
        telnyx_bidirectional_target_legs=_env("TELNYX_BIDIRECTIONAL_TARGET_LEGS", "both"),
        telnyx_l16_input_byte_order=_env("TELNYX_L16_INPUT_BYTE_ORDER", "little").lower(),
        telnyx_l16_output_byte_order=_env("TELNYX_L16_OUTPUT_BYTE_ORDER", "little").lower(),
        telnyx_webhook_tolerance_seconds=_env_int("TELNYX_WEBHOOK_TOLERANCE_SECONDS", 300),
        telnyx_answering_machine_detection=(
            _env("TELNYX_ANSWERING_MACHINE_DETECTION", _env("TELNYX_AMD_MODE", "premium")).strip().lower()
        ),
        telnyx_amd_total_analysis_time_millis=_env_int("TELNYX_AMD_TOTAL_ANALYSIS_TIME_MILLIS", 0),
        telnyx_amd_greeting_total_analysis_time_millis=_env_int(
            "TELNYX_AMD_GREETING_TOTAL_ANALYSIS_TIME_MILLIS",
            0,
        ),
        telnyx_voicemail_message=_env(
            "TELNYX_VOICEMAIL_MESSAGE",
            "Hi, it's Donna. I was calling to check in. I'll try again later. Take care.",
        ),
        telnyx_voicemail_voice=_env("TELNYX_VOICEMAIL_VOICE", "female"),
        telnyx_voicemail_service_level=_env("TELNYX_VOICEMAIL_SERVICE_LEVEL", "basic").lower(),
        telnyx_voicemail_language=_env("TELNYX_VOICEMAIL_LANGUAGE", "en-US"),
        telnyx_voicemail_fallback_delay_seconds=_env_float("TELNYX_VOICEMAIL_FALLBACK_DELAY_SECONDS", 8.0),
        # AI Services
        anthropic_api_key=_env("ANTHROPIC_API_KEY"),
        deepgram_api_key=_env("DEEPGRAM_API_KEY"),
        elevenlabs_api_key=_env("ELEVENLABS_API_KEY"),
        elevenlabs_voice_id=_env("ELEVENLABS_VOICE_ID", "jixzNFANovqRhzplvmwR"),
        elevenlabs_voice_id_es=_env("ELEVENLABS_VOICE_ID_ES"),
        elevenlabs_model=_env("ELEVENLABS_MODEL") or "eleven_flash_v2_5",
        cartesia_api_key=_env("CARTESIA_API_KEY"),
        cartesia_voice_id=_env("CARTESIA_VOICE_ID", "f786b574-daa5-4673-aa0c-cbe3e8534c02"),
        cartesia_voice_id_es=_env("CARTESIA_VOICE_ID_ES"),
        google_api_key=_env("GOOGLE_API_KEY"),
        openai_api_key=_env("OPENAI_API_KEY"),
        tavily_api_key=_env("TAVILY_API_KEY"),
        cerebras_api_key=_env("CEREBRAS_API_KEY"),
        groq_api_key=_env("GROQ_API_KEY"),
        # Audio
        telephony_internal_input_sample_rate=_env_int("TELEPHONY_INTERNAL_INPUT_SAMPLE_RATE", 16000),
        elevenlabs_output_sample_rate=_env_int("ELEVENLABS_OUTPUT_SAMPLE_RATE", 44100),
        cartesia_output_sample_rate=_env_int("CARTESIA_OUTPUT_SAMPLE_RATE", 48000),
        gemini_internal_output_sample_rate=_env_int("GEMINI_INTERNAL_OUTPUT_SAMPLE_RATE", 24000),
        # Model Selection
        fast_observer_model=_env("FAST_OBSERVER_MODEL", "gemini-3-flash-preview"),
        cerebras_director_model=_env("CEREBRAS_DIRECTOR_MODEL", "gpt-oss-120b"),
        groq_director_model=_env("GROQ_DIRECTOR_MODEL", "openai/gpt-oss-20b"),
        call_analysis_model=_env("CALL_ANALYSIS_MODEL", "gemini-3-flash-preview"),
        anthropic_model=_env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
        # Auth
        jwt_secret=_env("JWT_SECRET", "donna-admin-secret-change-me"),
        jwt_secret_previous=_env("JWT_SECRET_PREVIOUS"),
        donna_api_key=_env("DONNA_API_KEY"),
        donna_api_keys=_env("DONNA_API_KEYS"),
        cofounder_api_key_1=_env("COFOUNDER_API_KEY_1"),
        cofounder_api_key_2=_env("COFOUNDER_API_KEY_2"),
        clerk_secret_key=_env("CLERK_SECRET_KEY"),
        clerk_publishable_key=_env("CLERK_PUBLISHABLE_KEY", _env("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")),
        clerk_jwks_url=_env("CLERK_JWKS_URL"),
        # Monitoring
        sentry_dsn=_env("SENTRY_DSN"),
        # Scalability
        max_concurrent_calls=int(_env("MAX_CONCURRENT_CALLS", "50")),
        load_test_mode=_env("LOAD_TEST_MODE", "false").lower() == "true",
        redis_url=_env("REDIS_URL"),
        pipecat_require_redis=_truthy(_env("PIPECAT_REQUIRE_REDIS")),
        pipecat_draining=_truthy(_env("PIPECAT_DRAINING")),
        instance_id=_env("INSTANCE_ID", _env("RAILWAY_REPLICA_ID")),
        # Replica readiness gate (Phase 3)
        readiness_min_pool_connections=int(_env("READINESS_MIN_POOL_CONNECTIONS", "3")),
        readiness_check_timeout_seconds=float(_env("READINESS_CHECK_TIMEOUT_SECONDS", "30")),
        readiness_require_prompt_cache_primer=_truthy(_env("READINESS_REQUIRE_PROMPT_CACHE_PRIMER", "true")),
        readiness_require_deepgram_session=_truthy(_env("READINESS_REQUIRE_DEEPGRAM_SESSION", "true")),
        readiness_require_tts_session=_truthy(_env("READINESS_REQUIRE_TTS_SESSION", "true")),
        readiness_require_growthbook_loaded=_truthy(_env("READINESS_REQUIRE_GROWTHBOOK_LOADED", "true")),
        readiness_require_db_pool_warm=_truthy(_env("READINESS_REQUIRE_DB_POOL_WARM", "true")),
        readiness_require_breakers_closed=_truthy(_env("READINESS_REQUIRE_BREAKERS_CLOSED", "true")),
        # GrowthBook
        growthbook_api_host=_env("GROWTHBOOK_API_HOST"),
        growthbook_client_key=_env("GROWTHBOOK_CLIENT_KEY"),
        # Encryption
        field_encryption_key=_env("FIELD_ENCRYPTION_KEY"),
        # Feature Flags
        scheduler_enabled=_env("SCHEDULER_ENABLED", "false").lower() == "true",
        pipecat_retention_enabled=_truthy(_env("PIPECAT_RETENTION_ENABLED")),
        post_call_queue_enabled=_truthy(_env("POST_CALL_QUEUE_ENABLED")),
        post_call_worker_enabled=_truthy(_env("POST_CALL_WORKER_ENABLED")),
        voice_backend=_env("VOICE_BACKEND"),
        tts_provider=_env("TTS_PROVIDER"),
        telephony_ws_handshake_timeout_seconds=float(
            _env("TELEPHONY_WS_HANDSHAKE_TIMEOUT_SECONDS", _env("TWILIO_WS_HANDSHAKE_TIMEOUT_SECONDS", "5"))
        ),
        # Data Retention (HIPAA)
        retention_conversations_days=int(_env("RETENTION_CONVERSATIONS_DAYS", "365")),
        retention_conversation_metadata_days=int(_env("RETENTION_CONVERSATION_METADATA_DAYS", "1095")),
        retention_memories_days=int(_env("RETENTION_MEMORIES_DAYS", "730")),
        retention_call_analyses_days=int(_env("RETENTION_CALL_ANALYSES_DAYS", "365")),
        retention_daily_context_days=int(_env("RETENTION_DAILY_CONTEXT_DAYS", "90")),
        retention_call_metrics_days=int(_env("RETENTION_CALL_METRICS_DAYS", "180")),
        retention_inactive_reminders_days=int(_env("RETENTION_INACTIVE_REMINDERS_DAYS", "365")),
        retention_reminder_deliveries_days=int(_env("RETENTION_REMINDER_DELIVERIES_DAYS", "90")),
        retention_notifications_days=int(_env("RETENTION_NOTIFICATIONS_DAYS", "180")),
        retention_caregiver_notes_days=int(_env("RETENTION_CAREGIVER_NOTES_DAYS", "365")),
        retention_prospects_days=int(_env("RETENTION_PROSPECTS_DAYS", "90")),
        retention_inactive_senior_review_days=int(_env("RETENTION_INACTIVE_SENIOR_REVIEW_DAYS", "365")),
        retention_call_queue_days=int(_env("RETENTION_CALL_QUEUE_DAYS", "90")),
        retention_call_attempts_days=int(_env("RETENTION_CALL_ATTEMPTS_DAYS", "180")),
        retention_post_call_jobs_days=int(_env("RETENTION_POST_CALL_JOBS_DAYS", "180")),
        retention_outbound_call_guards_days=int(_env("RETENTION_OUTBOUND_CALL_GUARDS_DAYS", "30")),
        retention_scheduler_shadow_comparisons_days=int(_env("RETENTION_SCHEDULER_SHADOW_COMPARISONS_DAYS", "30")),
        retention_waitlist_days=int(_env("RETENTION_WAITLIST_DAYS", "365")),
        retention_audit_logs_days=int(_env("RETENTION_AUDIT_LOGS_DAYS", "2190")),
    )


# Module-level accessor — import this
settings = _load_settings()


def get_settings() -> Settings:
    """Return a fresh settings snapshot for code paths that rely on env overrides."""
    _load_settings.cache_clear()
    return _load_settings()
