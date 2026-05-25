"""Post-call analysis service.

Runs after each call to generate a companion-call summary and engagement
metrics. It intentionally does not classify medical, safety, or other care
alerts.
"""

from __future__ import annotations

import json
import os
import re
from loguru import logger
from db import query_one
from lib.circuit_breaker import CircuitBreaker
from lib.encryption import encrypt, decrypt, encrypt_json, decrypt_json
from lib.sanitize import sanitize_untrusted_text
from services.time_context import format_call_time_label, format_local_datetime

_breaker = CircuitBreaker("gemini_analysis", failure_threshold=3, recovery_timeout=60.0, call_timeout=15.0)


ANALYSIS_MODEL = os.environ.get("CALL_ANALYSIS_MODEL", "gemini-3-flash-preview")

# Static instructions — passed as system_instruction
ANALYSIS_SYSTEM_INSTRUCTION = """You analyze completed phone calls between Donna (an AI companion) and elderly individuals for the senior's caregiver.

Write the summary for a caregiver, not for Donna or an internal operator. It should answer: how did the senior seem and what mattered from the conversation. Keep it concise, factual, and useful. Do not include raw quotes, private details that are not needed for a companion-call summary, or unsupported medical/financial conclusions.

Donna is not a healthcare, safety-monitoring, or emergency-response product:
- Do not classify health, cognitive, emotional, or safety concerns.
- Do not create alerts, diagnoses, risk assessments, care plans, or urgent recommendations.
- Do not recommend monitoring symptoms, changing routines, arranging care, or contacting professionals.
- If the transcript includes health or emergency-like statements, keep the caregiver summary high level and factual without advice.
- Always set `concerns` to [], `recommended_caregiver_action` to "", and `follow_up_suggestions` to [].

Return JSON with:
- summary: 2-3 caregiver-facing sentences. Start with the senior's overall sentiment/mood, then include useful non-clinical conversation context and reminders if present.
- sentiment: one of positive, neutral, concerned, worried, distressed. Use positive for upbeat/engaged calls; neutral for routine calls with no meaningful issue; concerned for low engagement or low mood; worried or distressed only for the senior's clearly expressed emotional state, not for health or safety classification.
- topics_discussed
- reminders_delivered
- engagement_score: 1-10
- mood: one or two caregiver-friendly words, such as cheerful, calm, content, quiet, tired, worried, sad
- caregiver_sms: legacy field name for a warm, privacy-respecting caregiver message used by email/in-app notifications. Keep it high-level, never expose vulnerability or repeat sensitive details; if mood seems low, subtly suggest the caregiver give them a call; include call duration naturally; max 280 chars.
- caregiver_takeaways: 1-4 concise items a caregiver would care about
- recommended_caregiver_action: always empty string
- concerns: always empty array
- positive_observations
- follow_up_suggestions: always empty array
- call_quality: rapport strong/moderate/weak, goals_achieved bool, duration_appropriate bool

Temporal grounding:
- The transcript is anchored to the call date/time provided below.
- If the senior says "tomorrow", "next week", "later today", or similar, preserve that future timing in summaries and follow-up suggestions.
- Do not write a follow-up that implies a future plan already happened unless the transcript says it happened.
- If a future plan is merely mentioned, describe it as planned or upcoming. Do not upgrade it into a caregiver task unless the transcript says support is needed.

Output ONLY valid JSON: {"summary":"str","sentiment":"positive|neutral|concerned|worried|distressed","topics_discussed":["str"],"reminders_delivered":["str"],"engagement_score":0,"mood":"str","caregiver_sms":"str","caregiver_takeaways":["str"],"recommended_caregiver_action":"","concerns":[],"positive_observations":["str"],"follow_up_suggestions":[],"call_quality":{"rapport":"strong|moderate|weak","goals_achieved":true,"duration_appropriate":true}}"""

# Dynamic per-call content — passed as contents
ANALYSIS_TURN_TEMPLATE = """Senior: {{SENIOR_NAME}}
Call date/time: {{CALL_DATETIME}}
Family: {{FAMILY_MEMBERS}}

## TRANSCRIPT
{{TRANSCRIPT}}"""

_SENTIMENT_VALUES = {"positive", "neutral", "concerned", "worried", "distressed"}


def _repair_json(json_text: str) -> str:
    """Repair malformed JSON from LLM responses."""
    repaired = json_text
    # Remove trailing commas
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)

    open_braces = repaired.count("{")
    close_braces = repaired.count("}")
    open_brackets = repaired.count("[")
    close_brackets = repaired.count("]")

    # Close unclosed brackets
    repaired += "]" * (open_brackets - close_brackets)
    repaired += "}" * (open_braces - close_braces)

    # Final trailing comma cleanup
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    return repaired


def _format_transcript(history: list[dict] | str | None) -> str:
    """Format transcript for analysis prompt."""
    if not history:
        return "No transcript available"
    if isinstance(history, str):
        return history
    return "\n\n".join(
        f"{'DONNA' if m.get('role') == 'assistant' else 'SENIOR'}: {m.get('content', '')}"
        for m in history
    )


def _as_list(value) -> list:
    if isinstance(value, list):
        return value
    return []


def _sanitize_analysis_text(value, *, max_len: int = 1000) -> str:
    return sanitize_untrusted_text(value, max_len=max_len, replacement="")


def _sanitize_analysis_list(values, *, max_len: int = 300) -> list[str]:
    sanitized = []
    for value in _as_list(values):
        text = _sanitize_analysis_text(value, max_len=max_len)
        if text:
            sanitized.append(text)
    return sanitized


def _normalize_sentiment(raw, analysis: dict) -> str:
    """Return a stable caregiver-facing sentiment label."""
    if isinstance(raw, str):
        value = raw.strip().lower()
        if value in _SENTIMENT_VALUES:
            return value

    mood = str(analysis.get("mood") or "").lower()
    engagement = analysis.get("engagement_score")
    try:
        engagement = int(engagement)
    except (TypeError, ValueError):
        engagement = None

    if any(term in mood for term in ("distress", "hopeless", "panic", "despair")):
        return "distressed"
    if engagement is not None and engagement <= 3:
        return "concerned"
    if any(term in mood for term in ("worried", "anxious", "sad", "lonely", "tired", "quiet")):
        return "concerned"
    if any(term in mood for term in ("cheer", "happy", "content", "upbeat", "positive", "engaged")):
        return "positive"
    return "neutral"


def _normalize_analysis(analysis: dict | None) -> dict:
    """Normalize LLM output so downstream storage and UI get stable keys."""
    if not isinstance(analysis, dict):
        analysis = {}
    raw_sentiment = analysis.get("sentiment")

    default = _get_default_analysis()
    merged = {**default, **analysis}

    merged["summary"] = _sanitize_analysis_text(merged.get("summary"), max_len=1200)
    merged["mood"] = _sanitize_analysis_text(merged.get("mood"), max_len=80)
    merged["caregiver_sms"] = _sanitize_analysis_text(merged.get("caregiver_sms"), max_len=280)
    merged["topics_discussed"] = _sanitize_analysis_list(
        merged.get("topics_discussed") or merged.get("topics"),
        max_len=160,
    )
    merged["reminders_delivered"] = _sanitize_analysis_list(merged.get("reminders_delivered"), max_len=160)
    merged["concerns"] = []
    merged["positive_observations"] = _sanitize_analysis_list(merged.get("positive_observations"))
    merged["follow_up_suggestions"] = []
    merged["caregiver_takeaways"] = _sanitize_analysis_list(merged.get("caregiver_takeaways"))
    merged["recommended_caregiver_action"] = ""
    merged["sentiment"] = _normalize_sentiment(raw_sentiment, merged)

    try:
        merged["engagement_score"] = int(merged.get("engagement_score", 5))
    except (TypeError, ValueError):
        merged["engagement_score"] = 5
    merged["engagement_score"] = max(1, min(10, merged["engagement_score"]))

    call_quality = merged.get("call_quality")
    if not isinstance(call_quality, dict):
        call_quality = default["call_quality"]
    merged["call_quality"] = call_quality

    return merged


def _get_default_analysis() -> dict:
    """Default analysis when processing fails."""
    return {
        "summary": "Analysis unavailable",
        "sentiment": "neutral",
        "topics_discussed": [],
        "reminders_delivered": [],
        "engagement_score": 5,
        "mood": "unknown",
        "caregiver_sms": "",
        "caregiver_takeaways": [],
        "recommended_caregiver_action": "",
        "concerns": [],
        "positive_observations": [],
        "follow_up_suggestions": [],
        "call_quality": {
            "rapport": "moderate",
            "goals_achieved": False,
            "duration_appropriate": True,
        },
    }


async def analyze_completed_call(
    transcript: list[dict] | str,
    senior_context: dict | None,
    *,
    call_started_at=None,
) -> dict:
    """Analyze a completed call using Gemini Flash."""
    call_datetime = (
        format_local_datetime(
            call_started_at,
            (senior_context or {}).get("timezone") or "America/New_York",
        )
        or "Unknown"
    )
    # Determine output language from senior's configured donnaLanguage
    family_info = (senior_context or {}).get("family_info") or {}
    if isinstance(family_info, str):
        try:
            family_info = json.loads(family_info)
        except (json.JSONDecodeError, TypeError):
            family_info = {}
    donna_language = family_info.get("donnaLanguage", "en")
    language_instruction = (
        "\n\nIMPORTANT: Write ALL text fields (summary, caregiver_sms, caregiver_takeaways, recommended_caregiver_action, follow_up_suggestions, mood, positive_observations) in Spanish."
        if donna_language == "es"
        else ""
    )

    turn_content = (
        ANALYSIS_TURN_TEMPLATE
        .replace("{{SENIOR_NAME}}", (senior_context or {}).get("name") or "Unknown")
        .replace("{{CALL_DATETIME}}", call_datetime)
        .replace(
            "{{FAMILY_MEMBERS}}",
            ", ".join((senior_context or {}).get("family") or []) or "Unknown",
        )
        .replace("{{TRANSCRIPT}}", _format_transcript(transcript) or "")
    ) + language_instruction

    try:
        # Use google-genai for Gemini (async to avoid blocking event loop)
        from google import genai

        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            logger.error("GOOGLE_API_KEY not set")
            return _get_default_analysis()

        client = genai.Client(api_key=api_key)

        async def _gemini_call():
            return await client.aio.models.generate_content(
                model=ANALYSIS_MODEL,
                contents=turn_content,
                config=genai.types.GenerateContentConfig(
                    system_instruction=ANALYSIS_SYSTEM_INSTRUCTION,
                    max_output_tokens=1500,
                    temperature=0.2,
                ),
            )

        response = await _breaker.call(_gemini_call(), fallback=None)
        if response is None:
            return _get_default_analysis()

        json_text = response.text.strip()
        # Strip markdown fences
        if "```" in json_text:
            json_text = re.sub(r"```json?\n?", "", json_text).replace("```", "").strip()
        # Extract JSON object
        match = re.search(r"\{[\s\S]*\}", json_text)
        if match:
            json_text = match.group(0)

        try:
            analysis = json.loads(json_text)
        except json.JSONDecodeError:
            logger.info("JSON parse failed, attempting repair")
            analysis = json.loads(_repair_json(json_text))

        analysis = _normalize_analysis(analysis)

        logger.info(
            "Analysis complete: sentiment={sentiment}, engagement={score}/10, observations={observations}",
            sentiment=analysis.get("sentiment"),
            score=analysis.get("engagement_score"),
            observations=len(analysis.get("positive_observations", [])),
        )
        return analysis

    except Exception as e:
        logger.error("Call analysis error: {err}", err=str(e))
        return _get_default_analysis()


async def save_call_analysis(
    conversation_id: str, senior_id: str, analysis: dict
) -> dict | None:
    """Save call analysis to database.

    Writes analysis_encrypted for PHI-bearing details. Legacy plaintext
    columns remain read-only fallback for rows written before encryption.
    """
    try:
        row = await query_one(
            """INSERT INTO call_analyses
               (conversation_id, senior_id, summary, topics, engagement_score,
                concerns, positive_observations, follow_up_suggestions, call_quality,
                analysis_encrypted)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               RETURNING *""",
            conversation_id,
            senior_id,
            None,
            None,
            analysis.get("engagement_score"),
            None,
            None,
            None,
            None,
            encrypt_json(analysis),
        )
        logger.info("Saved analysis for conversation {cid}", cid=conversation_id)
        return row
    except Exception as e:
        logger.error("Save analysis error: {err}", err=str(e))
        return None


def get_high_severity_concerns(analysis: dict) -> list[dict]:
    """Legacy compatibility shim. Donna no longer creates care alerts."""
    return []


async def get_latest_analysis(
    senior_id: str,
    timezone_name: str = "America/New_York",
) -> dict | None:
    """Get the most recent call analysis for a senior."""
    row = await query_one(
        """SELECT ca.engagement_score, ca.call_quality, ca.summary,
                  ca.analysis_encrypted, ca.created_at,
                  c.started_at AS call_started_at
           FROM call_analyses ca
           LEFT JOIN conversations c ON c.id = ca.conversation_id
           WHERE ca.senior_id = $1
           ORDER BY ca.created_at DESC LIMIT 1""",
        senior_id,
    )
    if row and row.get("analysis_encrypted"):
        full = decrypt_json(row["analysis_encrypted"])
        if full and isinstance(full, dict):
            row["summary"] = full.get("summary", row.get("summary"))
            row["call_quality"] = full.get("call_quality", row.get("call_quality"))
            row["sentiment"] = full.get("sentiment")
            row["mood"] = full.get("mood")
        row.pop("analysis_encrypted", None)
    elif row:
        row.pop("analysis_encrypted", None)
    if row:
        call_started_at = row.get("call_started_at") or row.get("created_at")
        row["call_time_label"] = format_call_time_label(call_started_at, timezone_name)
        row["call_datetime"] = format_local_datetime(call_started_at, timezone_name)
    return row
