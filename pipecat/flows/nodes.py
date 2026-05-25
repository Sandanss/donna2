"""Pipecat Flows call phase node definitions.

Defines call phases: [reminder] → main → winding_down → closing.
The opening phase is merged into main — the bot greets and continues
in one phase, eliminating the transition_to_main double-LLM-call penalty.
The reminder phase is conditional — only activates when pending reminders exist.

Prompt text lives in prompts.py — edit prompts there, edit flow logic here.
"""

from __future__ import annotations

import time

from loguru import logger
from pipecat_flows import (
    FlowsFunctionSchema,
    NodeConfig,
    ContextStrategy,
    ContextStrategyConfig,
)

from prompts import (
    BASE_SYSTEM_PROMPT,
    GREETING_TASK_OUTBOUND,
    GREETING_TASK_INBOUND,
    REMINDER_TASK,
    MAIN_TASK,
    WINDING_DOWN_TASK,
    CLOSING_TASK_TEMPLATE,
    ONBOARDING_SYSTEM_PROMPT,
    ONBOARDING_TASK_FIRST_CALL,
    ONBOARDING_TASK_RETURN_CALLER,
    ONBOARDING_CLOSING_TASK,
    CONSENT_SYSTEM_PROMPT,
    CONSENT_TASK_TEMPLATE,
    CONSENT_CLOSING_TASK_TEMPLATE,
)
from services.context_trace import record_context_event


_EMPATHY_KEYWORDS = {"pain", "hurt", "ache", "sore", "discomfort", "bothering", "bother",
                      "tired", "exhausted", "dizzy", "fell", "fall", "swollen", "stiff"}


def _record_prompt_event(
    session_state: dict,
    *,
    source: str,
    label: str,
    content: str | None,
    provider: str = "pipecat_flows",
    item_count: int | None = None,
    metadata: dict | None = None,
    dedupe_key: str | None = None,
) -> None:
    if not content:
        return
    record_context_event(
        session_state,
        source=source,
        action="seeded",
        label=label,
        content=content,
        provider=provider,
        item_count=item_count,
        metadata=metadata,
        dedupe_key=dedupe_key,
    )


def _line_item_count(text: str | None) -> int | None:
    if not text:
        return None
    count = sum(1 for line in text.splitlines() if line.strip().startswith("-"))
    return count or None


def _format_analysis_insights(analysis: dict) -> str | None:
    """Format follow-ups, positive observations, and empathy-relevant concerns
    from the last call analysis into a prompt section."""
    lines: list[str] = []

    # Follow-up suggestions — highest signal for personalization
    follow_ups = analysis.get("follow_up_suggestions") or []
    if follow_ups:
        time_label = analysis.get("call_time_label")
        if time_label:
            lines.append(f"From last call ({time_label}), follow up on:")
        else:
            lines.append("From last call, follow up on:")
        for fu in follow_ups[:4]:
            lines.append(f"- {fu}")
        lines.append(
            "Timing guard: if the follow-up is about a future plan, only ask if it happened after that date/time has arrived."
        )

    # Positive observations — what lit them up
    positives = analysis.get("positive_observations") or []
    if positives:
        lines.append("What went well last time:")
        for po in positives[:3]:
            lines.append(f"- {po}")

    # Concerns — only emotional or pain/discomfort (empathetic, not clinical)
    concerns = analysis.get("concerns") or []
    empathy_concerns: list[str] = []
    for c in concerns:
        if not isinstance(c, dict):
            continue
        ctype = (c.get("type") or "").lower()
        desc = c.get("description") or ""
        desc_lower = desc.lower()
        if ctype == "emotional":
            empathy_concerns.append(desc)
        elif ctype == "health" and any(kw in desc_lower for kw in _EMPATHY_KEYWORDS):
            empathy_concerns.append(desc)
    if empathy_concerns:
        lines.append("They shared something that might still be on their mind:")
        for ec in empathy_concerns[:2]:
            lines.append(f"- {ec}")

    return "\n".join(lines) if lines else None


def _build_senior_context(session_state: dict) -> str:
    """Build the senior-specific context sections of the system prompt."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    parts: list[str] = []
    senior = session_state.get("senior") or {}

    # Inject current local time so the LLM knows morning/afternoon/evening
    tz_name = senior.get("timezone") or "America/New_York"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("America/New_York")
    local_now = datetime.now(tz)
    local_time_text = f"Current time: {local_now.strftime('%A, %B %d, %Y at %I:%M %p')}."
    parts.append(local_time_text)
    timing_guard_text = (
        "Use prior-call time labels literally. If an earlier-today call said something would happen tomorrow, "
        "do not ask whether it already happened yet."
    )
    parts.append(timing_guard_text)
    _record_prompt_event(
        session_state,
        source="local_time",
        label="Senior local time",
        content=f"{local_time_text}\n{timing_guard_text}",
        provider="runtime_clock",
        metadata={"timezone": tz_name},
        dedupe_key="senior_context:local_time",
    )

    first_name = (senior.get("name") or "").split(" ")[0] or "there"
    city = senior.get("city") or ""
    state = senior.get("state") or ""
    location = f"{city}, {state}" if city and state else city or state or ""
    location_note = f" They live in {location}." if location else ""
    profile_text = f"You are speaking with {first_name}.{location_note}"
    parts.append(profile_text)
    _record_prompt_event(
        session_state,
        source="senior_profile",
        label="Senior profile context",
        content=profile_text,
        provider="seniors",
        metadata={"has_location": bool(location)},
        dedupe_key="senior_context:profile",
    )

    # Donna's conversation language (set by caregiver)
    family_info = senior.get("family_info") or senior.get("familyInfo") or {}
    if isinstance(family_info, str):
        import json as _json
        try:
            family_info = _json.loads(family_info)
        except Exception:
            family_info = {}
    if not isinstance(family_info, dict):
        family_info = {}
    preferred_call_times = senior.get("preferred_call_times") or senior.get("preferredCallTimes") or {}
    if isinstance(preferred_call_times, str):
        import json as _json
        try:
            preferred_call_times = _json.loads(preferred_call_times)
        except Exception:
            preferred_call_times = {}
    if not isinstance(preferred_call_times, dict):
        preferred_call_times = {}
    donna_language = family_info.get("donnaLanguage", "en")
    if donna_language == "es":
        from prompts import SPANISH_LANGUAGE_INSTRUCTION
        parts.append(SPANISH_LANGUAGE_INSTRUCTION)

    # Date of birth → age + birthday awareness
    dob_str = family_info.get("dateOfBirth") or ""
    if dob_str:
        try:
            from datetime import date as _date
            parts_dob = dob_str.split("/")
            if len(parts_dob) == 3:
                dob = _date(int(parts_dob[2]), int(parts_dob[0]), int(parts_dob[1]))
                today = local_now.date()
                age = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
                birthday_month_day = dob.strftime("%B %d")
                days_until = ((dob.replace(year=today.year) - today).days) % 365
                if days_until == 0:
                    bday_note = "Today is their birthday!"
                elif days_until <= 7:
                    bday_note = f"Their birthday is coming up in {days_until} days ({birthday_month_day})."
                else:
                    bday_note = f"Their birthday is {birthday_month_day}."
                parts.append(f"They are {age} years old. {bday_note}")
        except (ValueError, IndexError):
            pass

    interests = senior.get("interests") or []
    interest_details = family_info.get("interestDetails") or {}
    if interests:
        # Build rich interest descriptions using detail text when available
        interest_parts = []
        for interest in interests:
            detail = interest_details.get(interest, "")
            if detail:
                interest_parts.append(f"- {interest}: {detail}")
            else:
                interest_parts.append(f"- {interest}")
        interests_text = "Their interests:\n" + "\n".join(interest_parts)
        parts.append(interests_text)
        _record_prompt_event(
            session_state,
            source="interests",
            label="Senior interests",
            content=interests_text,
            provider="seniors",
            item_count=len(interests),
            dedupe_key="senior_context:interests",
        )

    # Additional topics / context provided by caregiver
    additional_info = senior.get("additional_info") or senior.get("additionalInfo") or ""
    if additional_info:
        additional_text = f"Additional context from family: {additional_info}"
        parts.append(additional_text)
        _record_prompt_event(
            session_state,
            source="additional_info",
            label="Additional info from caregiver",
            content=additional_text,
            provider="seniors",
            dedupe_key="senior_context:additional_info",
        )

    # Topics to avoid (set by caregiver)
    topics_to_avoid = (
        family_info.get("topicsToAvoid")
        or preferred_call_times.get("topicsToAvoid")
        or ""
    )
    if isinstance(topics_to_avoid, list):
        topics_to_avoid = "; ".join(str(topic).strip() for topic in topics_to_avoid if str(topic).strip())
    if topics_to_avoid:
        avoid_text = f"Topics to AVOID (family request): {topics_to_avoid}"
        parts.append(avoid_text)
        _record_prompt_event(
            session_state,
            source="topics_to_avoid",
            label="Topics to avoid",
            content=avoid_text,
            provider="seniors",
            dedupe_key="senior_context:topics_to_avoid",
        )

    medical = senior.get("medical_notes") or senior.get("medicalNotes")
    if medical:
        medical_text = f"Health notes: {medical}"
        parts.append(medical_text)
        _record_prompt_event(
            session_state,
            source="medical_notes",
            label="Health notes",
            content=medical_text,
            provider="seniors",
            dedupe_key="senior_context:medical_notes",
        )

    # Profile authority: explicit profile data overrides conversation memories
    parts.append(
        "\nIMPORTANT: The profile information above (age, interests, birthday, additional context) "
        "is authoritative and set by the family. If any conversation memories below contradict "
        "the profile (e.g., different age, different interests), ALWAYS use the profile data. "
        "The profile is the source of truth."
    )

    summaries = session_state.get("previous_calls_summary")
    if summaries:
        previous_calls_text = f"\nRecent calls:\n{summaries}"
        parts.append(previous_calls_text)
        _record_prompt_event(
            session_state,
            source="previous_calls_summary",
            label="Recent call summary context",
            content=previous_calls_text,
            provider="context_cache",
            item_count=_line_item_count(summaries),
            dedupe_key="senior_context:previous_calls_summary",
        )

    recent_turns = session_state.get("recent_turns")
    if recent_turns:
        turns_text = str(recent_turns)
        if len(turns_text) > 1600:
            turns_text = turns_text[:1600].rsplit("\n", 1)[0] + "\n..."
        parts.append(
            "\nRecent turn excerpts from previous calls:\n"
            f"{turns_text}\n"
            "Use these for continuity. Respect any dates or time labels exactly."
        )

    todays_ctx = session_state.get("todays_context")
    if todays_ctx:
        todays_text = f"\n{todays_ctx}"
        parts.append(todays_text)
        _record_prompt_event(
            session_state,
            source="daily_context",
            label="Same-day call context",
            content=todays_text,
            provider="daily_context",
            item_count=_line_item_count(todays_ctx),
            dedupe_key="senior_context:daily_context",
        )

    memory_ctx = session_state.get("memory_context")
    if memory_ctx:
        memory_text = f"\n{memory_ctx}"
        parts.append(memory_text)
        _record_prompt_event(
            session_state,
            source="memory_context",
            label="Initial memory context",
            content=memory_text,
            provider="context_cache",
            item_count=_line_item_count(memory_ctx),
            dedupe_key="senior_context:memory_context",
        )
        logger.info("System prompt includes memory context ({n} chars)", n=len(memory_ctx))
    else:
        logger.warning("No memory context in session_state for system prompt")

    # --- Pre-cached news (fetched daily based on interests) ---
    news_ctx = session_state.get("news_context")
    if news_ctx:
        news_availability_text = (
            "\nFresh interest-based news is available for this call. "
            "Bring it up only if the conversation is neutral or positive, "
            "the topic is winding down, or they ask about current events."
        )
        parts.append(news_availability_text)
        _record_prompt_event(
            session_state,
            source="news_context",
            label="Pre-cached news availability note",
            content=news_availability_text,
            provider="context_cache",
            item_count=_line_item_count(news_ctx),
            metadata={"full_context_chars": len(news_ctx), "content_deferred": True},
            dedupe_key="senior_context:news_context",
        )
        logger.info("System prompt notes fresh news availability ({n} chars)", n=len(news_ctx))

    # --- Insights from last call analysis ---
    analysis = session_state.get("last_call_analysis") or {}
    analysis_parts = _format_analysis_insights(analysis)
    if analysis_parts:
        analysis_text = f"\n{analysis_parts}"
        parts.append(analysis_text)
        _record_prompt_event(
            session_state,
            source="last_call_analysis",
            label="Last-call analysis follow-up context",
            content=analysis_text,
            provider="call_analysis",
            item_count=_line_item_count(analysis_parts),
            dedupe_key="senior_context:last_call_analysis",
        )

    # Caregiver notes: pre-fetched at call start, injected into system prompt
    notes = session_state.get("_caregiver_notes_content") or []
    if notes:
        note_lines = ["\nFamily messages to share during this call:"]
        for note in notes:
            content = note.get("content", "") if isinstance(note, dict) else str(note)
            if content:
                note_lines.append(f"- {content}")
        note_lines.append("Share naturally: \"Oh, your daughter wanted me to mention...\" Don't force it if the moment isn't right.")
        caregiver_notes_text = "\n".join(note_lines)
        parts.append(caregiver_notes_text)
        _record_prompt_event(
            session_state,
            source="caregiver_notes",
            label="Caregiver notes",
            content=caregiver_notes_text,
            provider="caregivers",
            item_count=len(notes),
            dedupe_key="senior_context:caregiver_notes",
        )

    return "\n".join(parts)


def _build_reminder_context(session_state: dict) -> str:
    """Build reminder-related prompt sections."""
    parts: list[str] = []

    reminder_prompt = session_state.get("reminder_prompt")
    if reminder_prompt:
        parts.append(reminder_prompt)

    delivered = session_state.get("reminders_delivered") or set()
    if delivered:
        parts.append("\nREMINDERS ALREADY DELIVERED THIS CALL (do NOT repeat these):")
        for r in delivered:
            parts.append(f"- {r}")
        parts.append('If they bring up a delivered reminder again, say something like "As I mentioned earlier..." instead of repeating the full reminder.')

    return "\n".join(parts)


def _build_tracking_context(session_state: dict) -> str:
    """Build conversation tracking context."""
    tracking = session_state.get("conversation_tracking")
    return tracking or ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _record_phase_transition(session_state: dict, new_phase: str) -> None:
    """Record phase timing: compute duration of previous phase, start new one."""
    now = time.time()
    durations = session_state.setdefault("_phase_durations", {})
    prev_phase = session_state.get("_current_phase")
    phase_start = session_state.get("_phase_start_time")
    if prev_phase and phase_start:
        durations[prev_phase] = round(now - phase_start)
    session_state["_current_phase"] = new_phase
    session_state["_phase_start_time"] = now


def _update_tracking_context(session_state: dict) -> None:
    """Pull current tracking summary from ConversationTracker into session_state."""
    tracker = session_state.get("_conversation_tracker")
    if tracker and hasattr(tracker, "get_summary"):
        summary = tracker.get_summary()
        if summary:
            session_state["conversation_tracking"] = summary


def _build_greeting_task(session_state: dict) -> str:
    """Build the greeting instruction for the initial call phase."""
    is_outbound = session_state.get("is_outbound", True)
    greeting_task = GREETING_TASK_OUTBOUND if is_outbound else GREETING_TASK_INBOUND

    greeting = session_state.get("greeting", "")
    if greeting:
        greeting_task += f'\n\nUse this greeting to start: "{greeting}"'

    return greeting_task


def _record_node_prompts(
    session_state: dict,
    *,
    node_name: str,
    system_prompt: str | None = None,
    task_prompt: str | None = None,
    prompt_variant: str = "subscriber",
) -> None:
    if system_prompt:
        _record_prompt_event(
            session_state,
            source="system_prompt",
            label=f"{prompt_variant.title()} system prompt",
            content=system_prompt,
            metadata={"node": node_name, "variant": prompt_variant},
            dedupe_key=f"node:{node_name}:system_prompt:{prompt_variant}",
        )
    if task_prompt:
        _record_prompt_event(
            session_state,
            source="flow_task",
            label=f"{node_name.replace('_', ' ').title()} task prompt",
            content=task_prompt,
            metadata={"node": node_name, "variant": prompt_variant},
            dedupe_key=f"node:{node_name}:task_prompt:{prompt_variant}",
        )


# ---------------------------------------------------------------------------
# Transition functions
# ---------------------------------------------------------------------------

def _make_transition_reminder_to_main(session_state: dict, flows_tools: dict):
    """Create transition function: reminder → main."""

    async def transition_to_main(args: dict, flow_manager) -> tuple[dict, NodeConfig]:
        logger.info("Transitioning: reminder → main")
        _record_phase_transition(session_state, "main")
        _update_tracking_context(session_state)
        return (
            {"status": "success"},
            build_main_node(session_state, flows_tools),
        )

    return transition_to_main


def _make_transition_to_winding_down(session_state: dict, flows_tools: dict):
    """Create transition function: main → winding_down."""

    async def transition_to_winding_down(args: dict, flow_manager) -> tuple[dict, NodeConfig]:
        logger.info("Transitioning: main → winding_down")
        _record_phase_transition(session_state, "winding_down")
        _update_tracking_context(session_state)
        return (
            {"status": "success"},
            build_winding_down_node(session_state, flows_tools),
        )

    return transition_to_winding_down


def _make_transition_to_closing(session_state: dict):
    """Create transition function: → closing."""

    async def transition_to_closing(args: dict, flow_manager) -> tuple[dict, NodeConfig]:
        logger.info("Transitioning → closing")
        _record_phase_transition(session_state, "closing")
        return (
            {"status": "success"},
            build_closing_node(session_state),
        )

    return transition_to_closing


# ---------------------------------------------------------------------------
# Node builders
# ---------------------------------------------------------------------------

def build_reminder_node(
    session_state: dict, flows_tools: dict, *, with_greeting: bool = False
) -> NodeConfig:
    """Build the reminder node — deliver pending reminders.

    Only activated when session_state has pending reminders.
    Tools: mark_reminder_acknowledged, save_important_detail, transition_to_main.
    Context strategy: APPEND.

    When with_greeting=True (initial node), includes system prompt and greeting.
    """
    reminder_ctx = _build_reminder_context(session_state)

    reminder_task = REMINDER_TASK
    if reminder_ctx:
        reminder_task += f"\n\n{reminder_ctx}"

    # When this is the initial node, prepend the greeting with a bridge to reminders
    if with_greeting:
        greeting_task = _build_greeting_task(session_state)
        reminder_task = (
            greeting_task
            + " After they respond to your greeting, move to the reminders promptly."
            + "\n\n" + reminder_task
        )

    functions: list = []
    if "mark_reminder_acknowledged" in flows_tools:
        functions.append(flows_tools["mark_reminder_acknowledged"])
    # Allow new-reminder creation during the delivery phase too — seniors often
    # ask for one while Donna is delivering an existing reminder.
    if "create_reminder" in flows_tools:
        functions.append(flows_tools["create_reminder"])

    functions.append(FlowsFunctionSchema(
        name="transition_to_main",
        description="Call this after all reminders have been delivered and acknowledged, to move into the main conversation.",
        properties={},
        required=[],
        handler=_make_transition_reminder_to_main(session_state, flows_tools),
    ))

    # When this is the initial node, include system prompt
    role_messages = []
    if with_greeting:
        senior_ctx = _build_senior_context(session_state)
        system_content = BASE_SYSTEM_PROMPT + "\n\n" + senior_ctx
        _record_node_prompts(
            session_state,
            node_name="reminder",
            system_prompt=BASE_SYSTEM_PROMPT,
            task_prompt=reminder_task,
        )
        role_messages = [{"role": "system", "content": system_content}]
    _record_node_prompts(
        session_state,
        node_name="reminder",
        task_prompt=reminder_task,
    )

    return NodeConfig(
        name="reminder",
        role_messages=role_messages,
        task_messages=[{"role": "user", "content": reminder_task}],
        functions=functions,
        context_strategy=ContextStrategyConfig(strategy=ContextStrategy.APPEND),
        respond_immediately=with_greeting,  # Bot speaks first only on initial node
    )


def build_main_node(
    session_state: dict, flows_tools: dict, *, with_greeting: bool = False
) -> NodeConfig:
    """Build the main conversation node — free-form conversation + reminders.

    Tools: all tools + transition_to_winding_down.
    Context strategy: APPEND.

    When with_greeting=True (initial node), includes system prompt and greeting.
    """
    reminder_ctx = _build_reminder_context(session_state)
    tracking_ctx = _build_tracking_context(session_state)

    main_task = MAIN_TASK

    # When this is the initial node, prepend the greeting
    if with_greeting:
        greeting_task = _build_greeting_task(session_state)
        main_task = greeting_task + "\n\n" + main_task

    if reminder_ctx:
        main_task += f"\n\n{reminder_ctx}"

    if tracking_ctx:
        main_task += f"\n\n{tracking_ctx}"

    # Active tools: web_search + mark_reminder (others moved to Director/post-call)
    functions: list = list(flows_tools.values())

    # Transition tool
    functions.append(FlowsFunctionSchema(
        name="transition_to_winding_down",
        description="Call this when the conversation is naturally winding down, the senior signals they want to go, or after about 10 minutes of conversation.",
        properties={},
        required=[],
        handler=_make_transition_to_winding_down(session_state, flows_tools),
    ))

    # When this is the initial node, include system prompt
    role_messages = []
    if with_greeting:
        senior_ctx = _build_senior_context(session_state)
        system_content = BASE_SYSTEM_PROMPT + "\n\n" + senior_ctx
        _record_node_prompts(
            session_state,
            node_name="main",
            system_prompt=BASE_SYSTEM_PROMPT,
            task_prompt=main_task,
        )
        role_messages = [{"role": "system", "content": system_content}]
    _record_node_prompts(
        session_state,
        node_name="main",
        task_prompt=main_task,
    )

    return NodeConfig(
        name="main",
        role_messages=role_messages,
        task_messages=[{"role": "user", "content": main_task}],
        functions=functions,
        context_strategy=ContextStrategyConfig(strategy=ContextStrategy.APPEND),
        respond_immediately=with_greeting,  # Bot speaks first only on initial node
    )


def build_winding_down_node(session_state: dict, flows_tools: dict) -> NodeConfig:
    """Build the winding down node — deliver remaining reminders, wrap up.

    Tools: mark_reminder, save_detail, transition_to_closing.
    Context strategy: APPEND.
    """
    reminder_ctx = _build_reminder_context(session_state)

    winding_task = WINDING_DOWN_TASK

    if reminder_ctx:
        winding_task += f"\n\n{reminder_ctx}"

    _record_node_prompts(
        session_state,
        node_name="winding_down",
        task_prompt=winding_task,
    )

    functions: list = []
    if "mark_reminder_acknowledged" in flows_tools:
        functions.append(flows_tools["mark_reminder_acknowledged"])
    # Last-minute new-reminder requests still work while wrapping up.
    if "create_reminder" in flows_tools:
        functions.append(flows_tools["create_reminder"])

    functions.append(FlowsFunctionSchema(
        name="transition_to_closing",
        description="Call this when you are ready to say goodbye.",
        properties={},
        required=[],
        handler=_make_transition_to_closing(session_state),
    ))

    return NodeConfig(
        name="winding_down",
        role_messages=[],
        task_messages=[{"role": "user", "content": winding_task}],
        functions=functions,
        context_strategy=ContextStrategyConfig(strategy=ContextStrategy.APPEND),
        respond_immediately=False,
    )


def build_closing_node(session_state: dict) -> NodeConfig:
    """Build the closing node — warm goodbye and end conversation.

    Tools: none (just end_conversation post-action).
    Context strategy: APPEND.
    """
    senior = session_state.get("senior") or {}
    first_name = (senior.get("name") or "").split(" ")[0] or "there"

    closing_task = CLOSING_TASK_TEMPLATE.format(first_name=first_name)
    _record_node_prompts(
        session_state,
        node_name="closing",
        task_prompt=closing_task,
    )

    return NodeConfig(
        name="closing",
        role_messages=[],
        task_messages=[{"role": "user", "content": closing_task}],
        functions=[],
        post_actions=[{"type": "end_conversation"}],
        context_strategy=ContextStrategyConfig(strategy=ContextStrategy.APPEND),
        respond_immediately=False,
    )


# ---------------------------------------------------------------------------
# Onboarding nodes (unsubscribed callers)
# ---------------------------------------------------------------------------

def _build_prospect_context(session_state: dict) -> str:
    """Build context string for onboarding calls from prospect data."""
    prospect = session_state.get("prospect") or {}

    from services.prospects import build_context_for_prompt
    return build_context_for_prompt(prospect)


def _make_transition_to_onboarding_closing(session_state: dict):
    """Create transition function: onboarding → closing."""

    async def transition_to_closing(args: dict, flow_manager) -> tuple[dict, NodeConfig]:
        logger.info("Transitioning: onboarding → closing")
        _record_phase_transition(session_state, "closing")
        return (
            {"status": "success"},
            build_onboarding_closing_node(session_state),
        )

    return transition_to_closing


def build_onboarding_node(session_state: dict, flows_tools: dict) -> NodeConfig:
    """Build the onboarding node for unsubscribed callers.

    Single node covers all 6 conversation stages via prompt instructions.
    Tools: web_search, transition_to_closing.
    """
    prospect = session_state.get("prospect") or {}
    prospect_ctx = _build_prospect_context(session_state)
    call_count = prospect.get("call_count", 0)

    # Select task based on whether this is a return caller
    if call_count > 0:
        name = prospect.get("learned_name", "there")
        # Build context reference from what we know
        ctx_parts = []
        if prospect.get("loved_one_name"):
            ctx_parts.append(f"We were talking about {prospect['loved_one_name']}.")
        elif prospect.get("relationship"):
            ctx_parts.append(f"You were looking into Donna for a loved one.")
        context_reference = " ".join(ctx_parts) if ctx_parts else "How have you been?"

        task = ONBOARDING_TASK_RETURN_CALLER.format(
            name=name,
            context_reference=context_reference,
        )
    else:
        task = ONBOARDING_TASK_FIRST_CALL

    # Memory context for return callers
    memory_ctx = session_state.get("memory_context")
    if memory_ctx:
        task += f"\n\nPREVIOUS CONVERSATION CONTEXT:\n{memory_ctx}"
        _record_prompt_event(
            session_state,
            source="memory_context",
            label="Onboarding return-caller memory context",
            content=memory_ctx,
            provider="context_cache",
            item_count=_line_item_count(memory_ctx),
            dedupe_key="onboarding:memory_context",
        )

    # Tools: all onboarding tools + transition
    functions: list = list(flows_tools.values())
    functions.append(FlowsFunctionSchema(
        name="transition_to_closing",
        description="Call this when the caller is ready to end the conversation or says goodbye.",
        properties={},
        required=[],
        handler=_make_transition_to_onboarding_closing(session_state),
    ))

    system_content = ONBOARDING_SYSTEM_PROMPT + "\n\n" + prospect_ctx
    _record_prompt_event(
        session_state,
        source="prospect_context",
        label="Prospect onboarding context",
        content=prospect_ctx,
        provider="prospects",
        dedupe_key="onboarding:prospect_context",
    )
    _record_node_prompts(
        session_state,
        node_name="onboarding",
        system_prompt=ONBOARDING_SYSTEM_PROMPT,
        task_prompt=task,
        prompt_variant="onboarding",
    )

    return NodeConfig(
        name="onboarding",
        role_messages=[{"role": "system", "content": system_content}],
        task_messages=[{"role": "user", "content": task}],
        functions=functions,
        context_strategy=ContextStrategyConfig(strategy=ContextStrategy.APPEND),
        respond_immediately=True,
    )


def build_onboarding_closing_node(session_state: dict) -> NodeConfig:
    """Build the closing node for onboarding calls."""
    _record_node_prompts(
        session_state,
        node_name="onboarding_closing",
        task_prompt=ONBOARDING_CLOSING_TASK,
        prompt_variant="onboarding",
    )
    return NodeConfig(
        name="onboarding_closing",
        role_messages=[],
        task_messages=[{"role": "user", "content": ONBOARDING_CLOSING_TASK}],
        functions=[],
        post_actions=[{"type": "end_conversation"}],
        context_strategy=ContextStrategyConfig(strategy=ContextStrategy.APPEND),
        respond_immediately=False,
    )


# ---------------------------------------------------------------------------
# Consent nodes (call_type="consent" — outbound permission + AI disclosure)
# ---------------------------------------------------------------------------

def _build_consent_caregiver_intro(session_state: dict) -> str:
    """Render the caregiver introduction snippet for the consent prompt.

    Falls back to a neutral phrase when caregiver info isn't available — never
    leaves a literal placeholder in the spoken prompt.
    """
    senior = session_state.get("senior") or {}
    caregivers = session_state.get("_caregivers") or []
    if caregivers:
        cg = caregivers[0]
        name = (cg.get("name") or "").strip().split(" ")[0]
        relation = (cg.get("relation") or "").strip().lower()
        if name and relation:
            return f"{name}, your {relation},"
        if name:
            return f"{name}"
        if relation:
            return f"your {relation}"
    family_info = senior.get("family_info") or senior.get("familyInfo") or {}
    if isinstance(family_info, dict):
        rel = (family_info.get("caregiverRelation") or "").strip().lower()
        if rel:
            return f"your {rel}"
    return "someone in your family"


def _make_transition_to_consent_closing(session_state: dict):
    """Create transition function: consent → consent_closing."""

    async def transition_to_consent_closing(args: dict, flow_manager) -> tuple[dict, NodeConfig]:
        logger.info("Transitioning: consent → consent_closing")
        _record_phase_transition(session_state, "consent_closing")
        return (
            {"status": "success"},
            build_consent_closing_node(session_state),
        )

    return transition_to_consent_closing


def build_consent_node(session_state: dict, flows_tools: dict) -> NodeConfig:
    """Build the consent node — capture call + recording permission.

    Stripped flow: no web search, no memory, no caregiver notes.
    Tools: record_consent_response + transition_to_consent_closing.
    """
    senior = session_state.get("senior") or {}
    first_name = (senior.get("name") or "").split(" ")[0] or "there"
    caregiver_intro = _build_consent_caregiver_intro(session_state)

    task = CONSENT_TASK_TEMPLATE.format(
        first_name=first_name,
        caregiver_intro=caregiver_intro,
    )

    functions: list = []
    if "record_consent_response" in flows_tools:
        functions.append(flows_tools["record_consent_response"])
    functions.append(FlowsFunctionSchema(
        name="transition_to_consent_closing",
        description=(
            "Call this once both consents have been captured (or the senior "
            "declined call_permission, which short-circuits the recording ask). "
            "Moves into the warm goodbye phase."
        ),
        properties={},
        required=[],
        handler=_make_transition_to_consent_closing(session_state),
    ))

    system_content = CONSENT_SYSTEM_PROMPT
    _record_node_prompts(
        session_state,
        node_name="consent",
        system_prompt=CONSENT_SYSTEM_PROMPT,
        task_prompt=task,
        prompt_variant="consent",
    )

    return NodeConfig(
        name="consent",
        role_messages=[{"role": "system", "content": system_content}],
        task_messages=[{"role": "user", "content": task}],
        functions=functions,
        context_strategy=ContextStrategyConfig(strategy=ContextStrategy.APPEND),
        respond_immediately=True,  # Donna initiated the call; she speaks first.
    )


def build_consent_closing_node(session_state: dict) -> NodeConfig:
    """Build the consent closing node — warm goodbye and end conversation."""
    senior = session_state.get("senior") or {}
    first_name = (senior.get("name") or "").split(" ")[0] or "there"

    closing_task = CONSENT_CLOSING_TASK_TEMPLATE.format(first_name=first_name)
    _record_node_prompts(
        session_state,
        node_name="consent_closing",
        task_prompt=closing_task,
        prompt_variant="consent",
    )

    return NodeConfig(
        name="consent_closing",
        role_messages=[],
        task_messages=[{"role": "user", "content": closing_task}],
        functions=[],
        post_actions=[{"type": "end_conversation"}],
        context_strategy=ContextStrategyConfig(strategy=ContextStrategy.APPEND),
        respond_immediately=False,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# Call types with a dedicated entry-node builder. Register new flows here
# (consent, discovery, etc.) instead of growing the if-chain in
# build_initial_node. Each entry is (phase_name, builder). Subscriber default
# path — reminder vs main, gated by `schedule` — is NOT in this dict; it
# stays inline because it routes on session state (pending reminders) in
# addition to call_type.
CALL_TYPE_INITIAL_NODES = {
    "onboarding": ("onboarding", build_onboarding_node),
    "consent": ("consent", build_consent_node),
}


def build_initial_node(session_state: dict, flows_tools: dict) -> NodeConfig:
    """Build the initial node for a new call.

    Routes via CALL_TYPE_INITIAL_NODES for dedicated flows (onboarding,
    consent, discovery, …) or the standard subscriber flow (reminder vs main).
    """
    call_type = session_state.get("call_type", "")

    if call_type in CALL_TYPE_INITIAL_NODES:
        phase_name, builder = CALL_TYPE_INITIAL_NODES[call_type]
        logger.info("Initial node: {phase} (call_type={ct})", phase=phase_name, ct=call_type)
        _record_phase_transition(session_state, phase_name)
        return builder(session_state, flows_tools)

    reminder_prompt = session_state.get("reminder_prompt")
    reminders_delivered = session_state.get("reminders_delivered") or set()

    # Scheduled calls always go to main node — reminders are mentioned naturally
    # during conversation, not as a dedicated delivery phase.
    if call_type == "schedule":
        logger.info("Initial node: main (scheduled call, reminders as context)")
        _record_phase_transition(session_state, "main")
        return build_main_node(session_state, flows_tools, with_greeting=True)

    if reminder_prompt and not reminders_delivered:
        logger.info("Initial node: reminder (pending reminders)")
        _record_phase_transition(session_state, "reminder")
        return build_reminder_node(session_state, flows_tools, with_greeting=True)

    logger.info("Initial node: main (no pending reminders)")
    _record_phase_transition(session_state, "main")
    return build_main_node(session_state, flows_tools, with_greeting=True)
