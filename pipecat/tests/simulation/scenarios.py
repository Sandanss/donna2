"""Predefined simulation scenarios for LLM-to-LLM voice tests.

Each factory function returns a fully configured ``LiveSimScenario`` — a
dataclass that bundles a senior profile, caller persona, ordered goals,
and expected outcomes.  Scenarios are pure data: no DB access, no LLM
calls, no I/O.  They are consumed by ``CallSimRunner`` (Task 7) which
wires them into the live pipeline.

Scenarios shipped:

* ``web_search_scenario``   — weather + sports triggers web_search tool
* ``memory_seed_scenario``  — shares new family info (post-call extraction)
* ``memory_recall_scenario``— asks Donna to recall previously seeded info
* ``reminder_scenario``     — everyday reminder acknowledgement flow
* ``multiple_reminders_scenario`` — several reminders in the opening
* ``reminder_overload_scenario`` — five reminders, only some acknowledged
* ``ambiguous_reminder_ack_scenario`` — caller says "the second one"
* ``reminder_interruption_scenario`` — caller interrupts delivery with a new reminder request
* ``similar_reminders_scenario`` — similar reminder titles exercise tool mapping
* ``out_of_order_reminder_ack_scenario`` — caller acknowledges reminders out of order
* ``unacknowledged_reminder_scenario`` — caller never clearly acknowledges
* ``false_goodbye_reminder_ack_scenario`` — false goodbye plus reminder acknowledgement
* ``cognitive_confusion_reminder_scenario`` — confused caller asks Donna to repeat reminder
* ``low_engagement_reminder_scenario`` — terse caller receives a reminder
* ``consent_grant_scenario`` — senior grants both call + recording consent
* ``consent_decline_scenario`` — senior accepts calls but declines recording
* ``consent_mock_call_scenarios`` — five-branch consent coverage set
* ``consent_boundary_reminder_attempt_scenario`` — consent call resists reminder drift
* ``discovery_scenario`` — senior shares friends/hobbies/routines
* ``discovery_mock_call_scenarios`` — six-branch discovery coverage set
* ``discovery_boundary_reminder_attempt_scenario`` — discovery call resists reminder creation drift
* ``embedding_outage_scenario`` — memory search disabled by embedding failure
* ``false_goodbye_scenario`` — goodbye-like phrase to someone else mid-call
* ``low_engagement_scenario`` — reserved senior gives short answers
* ``health_concern_scenario`` — caller mentions a stumble / lightheadedness
* ``cognitive_confusion_scenario`` — caller repeats and forgets context
* ``reminder_creation_scenario`` — caller asks Donna to create a new reminder
* ``async_search_overlap_scenario`` — second request while search is in flight
* ``slow_search_overlap_scenario`` — current-info search is forced slow
* ``empty_search_result_scenario`` — web search returns no useful result
* ``search_phi_guard_scenario`` — web search request contains private details to sanitize
"""

from __future__ import annotations

from dataclasses import dataclass, field

from tests.simulation.caller import CallerGoal, CallerPersona
from tests.simulation.fixtures import TestSenior


# ---------------------------------------------------------------------------
# Core dataclass
# ---------------------------------------------------------------------------


@dataclass
class LiveSimScenario:
    """Complete definition of a simulation test scenario.

    Attributes:
        name: Short machine-friendly identifier (e.g. ``"web_search"``).
        description: Human-readable summary of what the scenario tests.
        senior: Senior profile to seed in the database before the call.
        persona: Caller identity and speech style for the Haiku agent.
        goals: Ordered conversational objectives the caller will pursue.
        call_type: ``"check-in"`` or ``"reminder"``.
        max_turns: Safety cap — caller says goodbye after this many exchanges.
        requires_audio: Reserved for Phase 2 audio transport scenarios.
        reminder_title: Reminder title (reminder scenarios only).
        reminder_description: Reminder detail text (reminder scenarios only).
        reminder_type: Reminder category passed to the reminder prompt formatter.
        reminders: Multiple pending reminders for a reminder call. Each item
            should include title/description/type and may include id.
        expect_tool_calls: Tool names that *should* be invoked during the call.
        expect_memories_injected: Whether Director should inject memories.
        expect_post_call_analysis: Whether post-call analysis should run.
        force_embedding_outage: Simulation fault injection for memory search
            degradation tests.
        force_empty_web_search: Simulation fault injection for web search
            empty-result degradation tests.
        force_slow_web_search_seconds: Simulation fault injection for delayed
            web search results.
    """

    name: str
    description: str
    senior: TestSenior = field(default_factory=TestSenior)
    persona: CallerPersona = field(default_factory=CallerPersona)
    goals: list[CallerGoal] = field(default_factory=list)
    call_type: str = "check-in"
    max_turns: int = 12
    requires_audio: bool = False  # Phase 2 only

    # Reminder setup (for reminder scenarios)
    reminder_title: str | None = None
    reminder_description: str | None = None
    reminder_type: str = "generic"
    reminders: list[dict] = field(default_factory=list)

    # Expected outcomes
    expect_tool_calls: list[str] = field(default_factory=list)
    expect_memories_injected: bool = False
    expect_post_call_analysis: bool = True
    force_embedding_outage: bool = False
    force_empty_web_search: bool = False
    force_slow_web_search_seconds: float = 0.0


# ---------------------------------------------------------------------------
# Factory helpers — shared building blocks
# ---------------------------------------------------------------------------

_MARGARET_BASE = CallerPersona(
    name="Margaret Johnson",
    age=78,
    personality="Warm, chatty, occasionally forgetful. Loves gardening and family.",
    speech_style=(
        "Natural elderly speech — uses 'dear', pauses with 'well...', "
        "short sentences."
    ),
)

_HAROLD_BASE = CallerPersona(
    name="Harold Williams",
    age=82,
    personality="Quiet, reserved, practical. Likes woodworking, fishing, and old westerns.",
    speech_style=(
        "Reserved older adult speech. Short answers, plain language, "
        "warms up only when a topic feels familiar."
    ),
)

_CARMEN_BASE = CallerPersona(
    name="Carmen Lopez",
    age=76,
    personality="Warm, bilingual, family-oriented. Comfortable switching between Spanish and English.",
    speech_style=(
        "Natural bilingual elderly speech. Short sentences, sometimes starts "
        "a request in Spanish and clarifies in English if asked."
    ),
)


def _margaret_senior() -> TestSenior:
    """Default test senior matching the Margaret persona."""
    return TestSenior()


def _harold_senior() -> TestSenior:
    """Reserved test senior for low-engagement scenarios."""
    return TestSenior(
        name="Harold Simulation",
        phone="5551234568",
        interests=["woodworking", "fishing", "old westerns"],
        profile_notes="Prefers short, practical check-ins",
        city="Tulsa",
        state="OK",
    )


def _carmen_senior() -> TestSenior:
    """Bilingual test senior for reminder creation scenarios."""
    return TestSenior(
        name="Carmen Simulation",
        phone="5551234569",
        interests=["cooking", "church", "grandchildren"],
        profile_notes="Prefers warm bilingual conversation",
        city="San Antonio",
        state="TX",
    )


# ---------------------------------------------------------------------------
# Scenario factories
# ---------------------------------------------------------------------------


def web_search_scenario() -> LiveSimScenario:
    """Scenario that triggers web search via weather and sports questions.

    Margaret asks about the weather (for gardening) and a Dallas Cowboys
    score.  The pipeline should invoke the ``web_search`` tool at least
    once.
    """
    return LiveSimScenario(
        name="web_search",
        description=(
            "Caller asks about weather for gardening and a Dallas Cowboys "
            "score, triggering web_search tool calls."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Curious and talkative. Loves gardening and checks the "
                "weather every morning. Follows the Dallas Cowboys religiously."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask about the weather for gardening this week",
                trigger_phrase=(
                    "I was wondering, what's the weather looking like? "
                    "I need to know if I should cover my tomatoes."
                ),
            ),
            CallerGoal(
                description="Ask about a Dallas Cowboys score or game",
                trigger_phrase=(
                    "Oh, and did the Cowboys win their game?"
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Well, thanks dear. I better go water my plants. Bye bye!",
            ),
        ],
        call_type="check-in",
        max_turns=10,
        expect_tool_calls=["web_search"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def memory_seed_scenario() -> LiveSimScenario:
    """Scenario where the caller shares memorable family updates.

    Margaret tells Donna about her grandson Jake winning a baseball
    championship and her plans to visit daughter Lisa in Florida.
    Post-call analysis should extract these as new memories.
    """
    return LiveSimScenario(
        name="memory_seed",
        description=(
            "Caller shares new family information (grandson's baseball "
            "win, Florida trip) that should be extracted as memories "
            "during post-call processing."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Talkative and proud grandma. Loves sharing family updates "
                "and gets excited telling stories about her grandchildren."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description=(
                    "Tell Donna about grandson Jake winning his baseball "
                    "championship"
                ),
                trigger_phrase=(
                    "Oh, I have to tell you! My grandson Jake, he won his "
                    "baseball championship last weekend. I'm so proud!"
                ),
            ),
            CallerGoal(
                description=(
                    "Mention planning a trip to visit daughter Lisa in Florida"
                ),
                trigger_phrase=(
                    "And you know, I'm thinking about going to visit my "
                    "daughter Lisa down in Florida next month."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Alright dear, I should get going. Talk to you soon!",
            ),
        ],
        call_type="check-in",
        max_turns=8,
        expect_tool_calls=[],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def memory_recall_scenario() -> LiveSimScenario:
    """Scenario where the caller expects Donna to recall previous info.

    Margaret asks if Donna remembers Jake's baseball game and brings up
    the Florida trip again.  The Director should inject relevant memories
    from the previous (seed) call.

    **Prerequisite**: ``memory_seed_scenario`` should have run previously
    so that the memories exist in the database.
    """
    return LiveSimScenario(
        name="memory_recall",
        description=(
            "Caller asks Donna to recall grandson Jake's baseball game "
            "and mentions the Florida trip again. Expects memory injection "
            "from a prior seed call."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Continues a previous conversation naturally. Expects Donna "
                "to remember what she shared last time."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description=(
                    "Ask if Donna remembers Jake's baseball game"
                ),
                trigger_phrase=(
                    "Do you remember I told you about my grandson Jake's "
                    "big game?"
                ),
            ),
            CallerGoal(
                description="Mention the Florida trip again",
                trigger_phrase=(
                    "I'm still planning that trip to see Lisa in Florida, "
                    "by the way."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Okay dear, I'll talk to you tomorrow. Bye now!",
            ),
        ],
        call_type="check-in",
        max_turns=8,
        expect_tool_calls=[],
        expect_memories_injected=True,
        expect_post_call_analysis=True,
    )


def reminder_scenario() -> LiveSimScenario:
    """Scenario that tests everyday reminder delivery and acknowledgement.

    This is a reminder-type call.  Margaret chats briefly, receives the
    plant-watering reminder, and acknowledges it.  The pipeline should invoke
    ``mark_reminder_acknowledged``.
    """
    return LiveSimScenario(
        name="reminder",
        description=(
            "Reminder call: caller chats briefly, receives a household "
            "reminder, and acknowledges it. Expects "
            "mark_reminder_acknowledged tool call."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Cooperative about household routines. Appreciates reminders "
                "and is good about following through when prompted."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description=(
                    "Chat briefly and wait for the household reminder"
                ),
                trigger_phrase="Oh, I'm doing alright today, just had some lunch.",
            ),
            CallerGoal(
                description="Acknowledge the household reminder clearly",
                trigger_phrase=(
                    "Oh yes, thank you for reminding me! I'll water the "
                    "porch plants this evening after dinner."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Thanks dear, you're always so helpful. Bye bye!",
            ),
        ],
        call_type="reminder",
        max_turns=8,
        reminder_title="Water the porch plants",
        reminder_description="This evening after dinner",
        reminder_type="generic",
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def multiple_reminders_scenario() -> LiveSimScenario:
    """Scenario that tests Donna surfacing several reminders up front.

    This is a reminder-type call with two everyday reminders. Donna should include both in the opening
    hello/introduction and record acknowledgement for each reminder.
    """
    return LiveSimScenario(
        name="multiple_reminders",
        description=(
            "Reminder call: caller receives multiple reminders in the opening "
            "hello/introduction and acknowledges both. Expects "
            "mark_reminder_acknowledged for each reminder."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Cooperative and organized about reminders. Appreciates when "
                "Donna groups household and social details clearly."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Acknowledge both reminders after Donna brings them up",
                trigger_phrase=(
                    "Thank you, dear. I'll water the porch plants after dinner, "
                    "and I wrote down the bridge club call for tomorrow "
                    "morning at nine."
                ),
            ),
            CallerGoal(
                description="Confirm both reminders are clear",
                trigger_phrase=(
                    "Yes, both are clear. Plants after dinner and the bridge "
                    "club call tomorrow morning."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Thanks for helping me keep track. Bye bye!",
            ),
        ],
        call_type="reminder",
        max_turns=8,
        reminders=[
            {
                "id": "00000000-0000-0000-0000-000000000101",
                "title": "Water the porch plants",
                "description": "This evening after dinner",
                "type": "generic",
            },
            {
                "id": "00000000-0000-0000-0000-000000000102",
                "title": "Call Eleanor about bridge club",
                "description": "Tomorrow at 9 AM",
                "type": "generic",
            },
        ],
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def reminder_overload_scenario() -> LiveSimScenario:
    """Scenario with many non-medical reminders and partial acknowledgement."""
    return LiveSimScenario(
        name="reminder_overload",
        description=(
            "Reminder call with five household/social items. Caller clearly "
            "acknowledges only some items so Donna must avoid flattening the "
            "whole batch into one acknowledgement."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Organized but a little overwhelmed when Donna lists several "
                "things at once. Will confirm only the items she is sure about."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Acknowledge two reminders and ask Donna to repeat the rest",
                trigger_phrase=(
                    "Okay, I can water the porch plants and call Eleanor. "
                    "Could you repeat the other ones for me?"
                ),
            ),
            CallerGoal(
                description="Confirm one more reminder but not the full list",
                trigger_phrase=(
                    "Right, I wrote down the library books too. I'm still not "
                    "sure about the last couple."
                ),
            ),
            CallerGoal(
                description="Say goodbye after partial acknowledgement",
                trigger_phrase="Thanks, Donna. That's enough for now. Bye bye.",
            ),
        ],
        call_type="reminder",
        max_turns=10,
        reminders=[
            {
                "id": "00000000-0000-0000-0000-000000000201",
                "title": "Water the porch plants",
                "description": "This evening after dinner",
                "type": "generic",
            },
            {
                "id": "00000000-0000-0000-0000-000000000202",
                "title": "Call Eleanor",
                "description": "Before bridge club signups close",
                "type": "social",
            },
            {
                "id": "00000000-0000-0000-0000-000000000203",
                "title": "Return library books",
                "description": "Due tomorrow afternoon",
                "type": "generic",
            },
            {
                "id": "00000000-0000-0000-0000-000000000204",
                "title": "Put bins by the curb",
                "description": "Before bedtime",
                "type": "generic",
            },
            {
                "id": "00000000-0000-0000-0000-000000000205",
                "title": "Bring recipe card to Lisa",
                "description": "Sunday dinner",
                "type": "social",
            },
        ],
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def ambiguous_reminder_ack_scenario() -> LiveSimScenario:
    """Scenario where the caller acknowledges by ordinal instead of title."""
    return LiveSimScenario(
        name="ambiguous_reminder_ack",
        description=(
            "Reminder call where the caller says 'the second one' instead of "
            "naming the reminder. Tool handling should map ordinal references "
            "without guessing the wrong item."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality="Cooperative but terse when acknowledging reminders.",
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Acknowledge only the second reminder",
                trigger_phrase="Yes, the second one is handled. I wrote that down.",
            ),
            CallerGoal(
                description="Ask Donna to repeat the first reminder",
                trigger_phrase="Could you remind me what the first one was again?",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="Thanks for keeping me straight. Bye now.",
            ),
        ],
        call_type="reminder",
        max_turns=9,
        reminders=[
            {
                "id": "00000000-0000-0000-0000-000000000211",
                "title": "Water the porch plants",
                "description": "After dinner",
                "type": "generic",
            },
            {
                "id": "00000000-0000-0000-0000-000000000212",
                "title": "Call Eleanor about bridge club",
                "description": "Tomorrow at 9 AM",
                "type": "social",
            },
        ],
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def reminder_interruption_scenario() -> LiveSimScenario:
    """Scenario where a caller interrupts reminder delivery with a new request."""
    return LiveSimScenario(
        name="reminder_interruption",
        description=(
            "Reminder delivery gets interrupted by a new reminder request. "
            "Donna should return to the pending reminders after handling the "
            "new request details."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality="Warm, distractible, and quick to add new to-dos.",
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Interrupt with a new reminder request",
                trigger_phrase=(
                    "Before I forget, could you also remind me to bring the "
                    "library tote tomorrow afternoon?"
                ),
            ),
            CallerGoal(
                description="Confirm the new reminder details",
                trigger_phrase="Yes, call it bring the library tote. Tomorrow at two, just once.",
            ),
            CallerGoal(
                description="Acknowledge the original reminders",
                trigger_phrase=(
                    "And yes, I will water the porch plants and call Eleanor "
                    "about bridge club."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Thanks, Donna. Bye bye.",
            ),
        ],
        call_type="reminder",
        max_turns=12,
        reminders=[
            {
                "id": "00000000-0000-0000-0000-000000000221",
                "title": "Water the porch plants",
                "description": "After dinner",
                "type": "generic",
            },
            {
                "id": "00000000-0000-0000-0000-000000000222",
                "title": "Call Eleanor about bridge club",
                "description": "Tomorrow at 9 AM",
                "type": "social",
            },
        ],
        expect_tool_calls=["mark_reminder_acknowledged", "create_reminder"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def similar_reminders_scenario() -> LiveSimScenario:
    """Scenario with similar reminder titles that stress title/slug matching."""
    return LiveSimScenario(
        name="similar_reminders",
        description=(
            "Two reminders share a name prefix. A slug like "
            "'call-eleanor-about-bridge-club' must resolve to the specific "
            "bridge-club reminder, not the shorter 'Call Eleanor' reminder."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality="Careful and specific once prompted.",
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Acknowledge the more specific Eleanor reminder first",
                trigger_phrase=(
                    "The bridge club call with Eleanor is the one I handled. "
                    "The regular call to Eleanor can wait."
                ),
            ),
            CallerGoal(
                description="Acknowledge the shorter Eleanor reminder separately",
                trigger_phrase="Okay, I will also call Eleanor later this afternoon.",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="That clears it up. Bye Donna.",
            ),
        ],
        call_type="reminder",
        max_turns=9,
        reminders=[
            {
                "id": "00000000-0000-0000-0000-000000000231",
                "title": "Call Eleanor",
                "description": "This afternoon",
                "type": "social",
            },
            {
                "id": "00000000-0000-0000-0000-000000000232",
                "title": "Call Eleanor about bridge club",
                "description": "Tomorrow at 9 AM",
                "type": "social",
            },
        ],
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def out_of_order_reminder_ack_scenario() -> LiveSimScenario:
    """Scenario where acknowledgements arrive in a different order."""
    return LiveSimScenario(
        name="out_of_order_reminder_ack",
        description=(
            "Donna mentions reminders in one order, but the caller confirms "
            "the second reminder before the first."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality="Cooperative but answers in the order she remembers.",
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Confirm the bridge club reminder first",
                trigger_phrase=(
                    "I wrote down the bridge club call for tomorrow morning. "
                    "That's handled."
                ),
            ),
            CallerGoal(
                description="Confirm the plant reminder after that",
                trigger_phrase="And yes, I will water the porch plants after dinner.",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="Thank you, Donna. Bye now.",
            ),
        ],
        call_type="reminder",
        max_turns=9,
        reminders=[
            {
                "id": "00000000-0000-0000-0000-000000000241",
                "title": "Water the porch plants",
                "description": "After dinner",
                "type": "generic",
            },
            {
                "id": "00000000-0000-0000-0000-000000000242",
                "title": "Call Eleanor about bridge club",
                "description": "Tomorrow at 9 AM",
                "type": "social",
            },
        ],
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def unacknowledged_reminder_scenario() -> LiveSimScenario:
    """Scenario where the caller never clearly acknowledges the reminder."""
    return LiveSimScenario(
        name="unacknowledged_reminder",
        description=(
            "Caller dodges the reminder and changes topic. Donna should not "
            "treat a vague topic change as a confirmation."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality="Friendly but evasive when asked to confirm tasks.",
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Change topic instead of acknowledging",
                trigger_phrase=(
                    "Oh, speaking of the porch, the roses out there are "
                    "finally blooming beautifully."
                ),
            ),
            CallerGoal(
                description="Still avoid confirming the reminder",
                trigger_phrase="I'll think about that later. Tell me about the weather instead.",
            ),
            CallerGoal(
                description="Say goodbye without confirming",
                trigger_phrase="I should go now. Bye Donna.",
            ),
        ],
        call_type="reminder",
        max_turns=9,
        reminder_title="Water the porch plants",
        reminder_description="After dinner",
        reminder_type="generic",
        expect_tool_calls=[],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def false_goodbye_reminder_ack_scenario() -> LiveSimScenario:
    """Scenario with a false goodbye embedded in reminder acknowledgement."""
    return LiveSimScenario(
        name="false_goodbye_reminder_ack",
        description=(
            "Caller says goodbye to someone nearby while also acknowledging "
            "a reminder. Quick Observer should not end the call early."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality="Friendly and easily distracted by people nearby.",
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="False goodbye plus reminder acknowledgement",
                trigger_phrase=(
                    "Bye Helen, thanks for stopping by. Sorry Donna, I'm "
                    "still here, and yes, I'll water the porch plants tonight."
                ),
            ),
            CallerGoal(
                description="Continue the call after the false goodbye",
                trigger_phrase="Now, what was the other thing you wanted to tell me?",
            ),
            CallerGoal(
                description="Say goodbye to Donna",
                trigger_phrase="Okay, now goodbye Donna.",
            ),
        ],
        call_type="reminder",
        max_turns=9,
        reminder_title="Water the porch plants",
        reminder_description="After dinner",
        reminder_type="generic",
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def cognitive_confusion_reminder_scenario() -> LiveSimScenario:
    """Scenario where a confused caller needs reminder repetition."""
    return LiveSimScenario(
        name="cognitive_confusion_reminder",
        description=(
            "Caller asks Donna to repeat who she is and what the reminder was "
            "before eventually acknowledging it."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Pleasant but foggy today. Needs orientation and repetition "
                "before confirming."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask Donna to repeat the reminder",
                trigger_phrase="I'm sorry, who is this again? What was I supposed to remember?",
            ),
            CallerGoal(
                description="Acknowledge after repetition",
                trigger_phrase="Oh yes, the porch plants. I can do that after dinner.",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="Thank you for being patient with me. Bye for now.",
            ),
        ],
        call_type="reminder",
        max_turns=10,
        reminder_title="Water the porch plants",
        reminder_description="After dinner",
        reminder_type="generic",
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def low_engagement_reminder_scenario() -> LiveSimScenario:
    """Scenario where a low-engagement caller receives a reminder."""
    return LiveSimScenario(
        name="low_engagement_reminder",
        description=(
            "Reserved caller gives very short responses. Donna should not "
            "over-prompt while still making the reminder clear."
        ),
        senior=_harold_senior(),
        persona=CallerPersona(
            name=_HAROLD_BASE.name,
            age=_HAROLD_BASE.age,
            personality=_HAROLD_BASE.personality,
            speech_style=_HAROLD_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Give a very short acknowledgement",
                trigger_phrase="Yep. Got it.",
            ),
            CallerGoal(
                description="Give another short answer",
                trigger_phrase="That's all.",
            ),
            CallerGoal(
                description="Say goodbye briefly",
                trigger_phrase="Bye.",
            ),
        ],
        call_type="reminder",
        max_turns=8,
        reminder_title="Put bins by the curb",
        reminder_description="Before bedtime",
        reminder_type="generic",
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


# ---------------------------------------------------------------------------
# Consent + Discovery scenarios
# See docs/plans/2026-05-24-consent-and-discovery-call-flows.md
# ---------------------------------------------------------------------------


def consent_grant_scenario() -> LiveSimScenario:
    """First-ever call: Donna asks permission and the senior agrees.

    Single combined consent (call + recording). Expects record_consent_response
    fired exactly once with granted=true.
    """
    return LiveSimScenario(
        name="consent_grant",
        description=(
            "Consent call: senior grants the combined call+recording consent. "
            "Expects record_consent_response invoked exactly once with granted=true."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Friendly but a little cautious about new technology. Trusts her "
                "daughter who set up the account. Agrees once Donna explains things "
                "clearly."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description=(
                    "Listen to Donna's introduction; ask a brief clarifying question"
                ),
                trigger_phrase="Oh — okay. Who did you say set this up?",
            ),
            CallerGoal(
                description=(
                    "Agree to the combined consent (calls + recording) in one answer"
                ),
                trigger_phrase=(
                    "Yeah, that sounds fine. Calls are okay and I don't mind "
                    "you recording."
                ),
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="Alright dear, talk to you soon. Bye now.",
            ),
        ],
        call_type="consent",
        max_turns=8,
        expect_tool_calls=["record_consent_response"],
        expect_memories_injected=False,
        expect_post_call_analysis=False,
    )


def consent_decline_scenario() -> LiveSimScenario:
    """Senior does not want this service at all.

    Single combined consent — any decline is a full no. Expects
    record_consent_response fired exactly once with granted=false; roll-up
    marks consent_status='declined' and callable=false.
    """
    return LiveSimScenario(
        name="consent_decline",
        description=(
            "Consent call: senior declines the combined consent. Expects "
            "record_consent_response invoked exactly once with granted=false; "
            "seniors.consent_status='declined', callable=false."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Friendly and chatty but private about her conversations. Doesn't "
                "want recorded calls — and since it's a combined consent, she says "
                "no to the whole thing."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Acknowledge Donna's introduction",
                trigger_phrase="Oh, alright. That's nice of her to set up.",
            ),
            CallerGoal(
                description=(
                    "Decline the combined consent firmly but politely — the "
                    "recording part is what she dislikes"
                ),
                trigger_phrase=(
                    "Hmm — no, I'd rather not. I'm a private person and I don't "
                    "want our calls recorded."
                ),
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="Thanks for asking, dear. Take care now.",
            ),
        ],
        call_type="consent",
        max_turns=8,
        expect_tool_calls=["record_consent_response"],
        expect_memories_injected=False,
        expect_post_call_analysis=False,
    )


def consent_ambiguous_then_grant_scenario() -> LiveSimScenario:
    """Senior gives a fuzzy answer first, then confirms yes clearly."""
    return LiveSimScenario(
        name="consent_ambiguous_then_grant",
        description=(
            "Consent call: senior starts with a fuzzy maybe, then confirms yes. "
            "Expects Donna to clarify before record_consent_response granted=true."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Polite and agreeable, but not precise at first. Needs Donna to "
                "slow down and confirm the combined call and recording permission."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Respond with an uncertain maybe to the combined consent ask",
                trigger_phrase=(
                    "Well, I suppose that might be alright. I'm not completely "
                    "sure what I'm saying yes to, though."
                ),
            ),
            CallerGoal(
                description="Confirm a clear yes after Donna clarifies",
                trigger_phrase=(
                    "Yes, that's okay. You can call me, and recording is alright "
                    "if it helps my family."
                ),
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="Okay, thank you for explaining. Goodbye now.",
            ),
        ],
        call_type="consent",
        max_turns=9,
        expect_tool_calls=["record_consent_response"],
        expect_memories_injected=False,
        expect_post_call_analysis=False,
    )


def consent_ai_question_then_grant_scenario() -> LiveSimScenario:
    """Senior asks whether Donna is AI and who set this up before agreeing."""
    return LiveSimScenario(
        name="consent_ai_question_then_grant",
        description=(
            "Consent call: senior asks if Donna is AI and who set up the service, "
            "then grants the combined consent after disclosure."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Cautious about unfamiliar callers. Wants a direct answer about "
                "whether Donna is a person before granting permission."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask whether Donna is a real person or AI",
                trigger_phrase=(
                    "Wait now, are you a real person calling me, or one of those "
                    "computer voices?"
                ),
            ),
            CallerGoal(
                description="Ask who will hear or see the recordings",
                trigger_phrase=(
                    "And who gets to hear these recordings or read about what I say?"
                ),
            ),
            CallerGoal(
                description="Grant the combined consent after the explanation",
                trigger_phrase=(
                    "Alright, if it's just to help my family stay updated, that's "
                    "fine. You can call and record."
                ),
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="That answers my question. Bye now.",
            ),
        ],
        call_type="consent",
        max_turns=10,
        expect_tool_calls=["record_consent_response"],
        expect_memories_injected=False,
        expect_post_call_analysis=False,
    )


def consent_off_topic_redirect_decline_scenario() -> LiveSimScenario:
    """Senior tries to turn the permission call into a chat, then declines."""
    return LiveSimScenario(
        name="consent_off_topic_redirect_decline",
        description=(
            "Consent call: senior asks for weather and tries to chat before "
            "answering. Donna should stay on the consent task and capture one no."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Friendly and distractible. Wants to chat about the day but is "
                "not comfortable approving recorded calls yet."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask an off-topic weather question during the consent call",
                trigger_phrase=(
                    "Before all that, can you tell me if it's going to rain today? "
                    "I was hoping to sit outside."
                ),
            ),
            CallerGoal(
                description="Decline after Donna redirects back to permission",
                trigger_phrase=(
                    "No, I don't think I want to do recorded calls. Let's not set "
                    "that up."
                ),
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="Thank you for understanding. Goodbye.",
            ),
        ],
        call_type="consent",
        max_turns=9,
        expect_tool_calls=["record_consent_response"],
        expect_memories_injected=False,
        expect_post_call_analysis=False,
    )


def consent_mock_call_scenarios() -> list[LiveSimScenario]:
    """Five-branch consent coverage set for the mock-call harness."""
    return [
        consent_grant_scenario(),
        consent_decline_scenario(),
        consent_ambiguous_then_grant_scenario(),
        consent_ai_question_then_grant_scenario(),
        consent_off_topic_redirect_decline_scenario(),
    ]


def consent_boundary_reminder_attempt_scenario() -> LiveSimScenario:
    """Consent call where the senior tries to start a reminder workflow."""
    return LiveSimScenario(
        name="consent_boundary_reminder_attempt",
        description=(
            "During consent, caller asks Donna to set a reminder. Donna should "
            "finish consent first and not drift into reminder creation."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Friendly and cooperative, but prone to asking unrelated "
                "questions while Donna is explaining setup."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask for a reminder before consent is complete",
                trigger_phrase=(
                    "Before I answer that, could you remind me tomorrow to "
                    "call Eleanor?"
                ),
            ),
            CallerGoal(
                description="Grant call permission after Donna redirects",
                trigger_phrase="Yes, it's okay if you call me like this.",
            ),
            CallerGoal(
                description="Grant recording permission",
                trigger_phrase="Yes, recording is fine too.",
            ),
        ],
        call_type="consent",
        max_turns=10,
        expect_tool_calls=["record_consent_response"],
        expect_memories_injected=False,
        expect_post_call_analysis=False,
    )


def discovery_scenario() -> LiveSimScenario:
    """Get-to-know-you call: senior shares friends, hobbies, routines.

    Tests the discovery flow — Donna should invoke record_discovery_fact
    multiple times as the senior shares specifics (name + activity), and
    transition_to_discovery_closing once the conversation feels complete.
    """
    return LiveSimScenario(
        name="discovery",
        description=(
            "Discovery call: senior shares friends, weekly routines, and a hobby. "
            "Expects record_discovery_fact invoked multiple times across categories."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Warm and opens up easily when asked about people and activities "
                "she loves. Has a regular Thursday bridge group with her friend "
                "Eleanor, gardens most mornings, and talks to her son Tom on Sundays."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Greet warmly and ask how Donna is doing",
                trigger_phrase=(
                    "Hi Donna, it's good to hear from you again. I'm doing well, "
                    "thank you for asking."
                ),
            ),
            CallerGoal(
                description="Share about Thursday bridge with Eleanor",
                trigger_phrase=(
                    "Well, every Thursday I play bridge with my friend Eleanor "
                    "and a couple of ladies from the church. We've been doing it "
                    "for years."
                ),
            ),
            CallerGoal(
                description="Share morning gardening routine",
                trigger_phrase=(
                    "Oh, and most mornings I'm out in the garden right after "
                    "breakfast. The roses are really coming in this year."
                ),
            ),
            CallerGoal(
                description="Mention her son Tom",
                trigger_phrase=(
                    "My son Tom calls every Sunday too. He lives in Houston but "
                    "we talk every week."
                ),
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase=(
                    "It was lovely chatting, Donna. I'll talk to you again soon."
                ),
            ),
        ],
        call_type="discovery",
        max_turns=14,
        expect_tool_calls=["record_discovery_fact"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def discovery_quiet_routine_scenario() -> LiveSimScenario:
    """Quiet senior gives short answers; Donna should still elicit specifics."""
    return LiveSimScenario(
        name="discovery_quiet_routine",
        description=(
            "Discovery call: quiet senior gives short answers, then shares a "
            "specific morning routine and neighbor relationship."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Reserved and soft-spoken. Gives short answers until Donna asks "
                "gentle follow-ups about everyday routines."
            ),
            speech_style="Quiet elderly speech. Short answers, then a little more detail when prompted.",
        ),
        goals=[
            CallerGoal(
                description="Give a short opening answer",
                trigger_phrase="Oh, I'm alright. Not much going on.",
            ),
            CallerGoal(
                description="Share a specific morning routine",
                trigger_phrase=(
                    "I do sit by the kitchen window with tea every morning and "
                    "watch the cardinals at the feeder."
                ),
            ),
            CallerGoal(
                description="Share a neighbor relationship",
                trigger_phrase=(
                    "My neighbor Ruth checks in most afternoons when she walks "
                    "her little dog."
                ),
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="That's enough about me for today. Bye now.",
            ),
        ],
        call_type="discovery",
        max_turns=12,
        expect_tool_calls=["record_discovery_fact"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def discovery_off_topic_weather_scenario() -> LiveSimScenario:
    """Senior asks for current weather while also sharing a hobby."""
    return LiveSimScenario(
        name="discovery_off_topic_weather",
        description=(
            "Discovery call: senior shares gardening details and asks for current "
            "weather, exercising record_discovery_fact plus web_search."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Talkative gardener. Gives useful discovery details but also asks "
                "Donna to check current weather."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Share a gardening hobby",
                trigger_phrase=(
                    "I've been fussing over my tomatoes and basil every morning. "
                    "The basil is doing beautifully."
                ),
            ),
            CallerGoal(
                description="Ask for current weather as an off-topic request",
                trigger_phrase=(
                    "Could you check whether rain is coming later today? I don't "
                    "want those tomato plants soaked again."
                ),
            ),
            CallerGoal(
                description="Share a regular family call",
                trigger_phrase="My daughter Carla calls me every Wednesday evening.",
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="Thanks for checking on that. I'll let you go now.",
            ),
        ],
        call_type="discovery",
        max_turns=14,
        expect_tool_calls=["record_discovery_fact", "web_search"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def discovery_boundary_redirect_scenario() -> LiveSimScenario:
    """Senior declines private topics and pivots to safe interests."""
    return LiveSimScenario(
        name="discovery_boundary_redirect",
        description=(
            "Discovery call: senior refuses private topics and then shares a safe "
            "interest and family routine. Tests respectful redirect behavior."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Warm but private. Does not want to discuss personal details, "
                "but enjoys talking about music and family routines."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Set a boundary around private topics",
                trigger_phrase=(
                    "I don't really want to talk about private things like that."
                ),
            ),
            CallerGoal(
                description="Share a safe interest after Donna redirects",
                trigger_phrase=(
                    "But I do love the old hymns. I listen to the choir program "
                    "on Sunday mornings."
                ),
            ),
            CallerGoal(
                description="Share a family routine",
                trigger_phrase=(
                    "My sister Anita calls after the Sunday program so we can "
                    "talk about the songs."
                ),
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="I'm glad we talked about that instead. Goodbye.",
            ),
        ],
        call_type="discovery",
        max_turns=12,
        expect_tool_calls=["record_discovery_fact"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def discovery_early_goodbye_scenario() -> LiveSimScenario:
    """Senior shares one useful fact, then ends the call early."""
    return LiveSimScenario(
        name="discovery_early_goodbye",
        description=(
            "Discovery call: senior shares one specific relationship, then says "
            "goodbye early. Tests partial discovery without forcing more questions."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Pleasant but busy. Will answer one question, then needs to leave."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Share one neighbor relationship",
                trigger_phrase=(
                    "My neighbor June brings my mail up to the porch when it's cold."
                ),
            ),
            CallerGoal(
                description="End the call early",
                trigger_phrase=(
                    "I need to go start supper now. It was nice talking. Bye."
                ),
            ),
        ],
        call_type="discovery",
        max_turns=7,
        expect_tool_calls=["record_discovery_fact"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def discovery_correction_scenario() -> LiveSimScenario:
    """Senior corrects a previously stated fact during the same call."""
    return LiveSimScenario(
        name="discovery_correction",
        description=(
            "Discovery call: senior shares a friend/routine fact, then corrects "
            "the friend's name. Tests correction handling in scenario coverage."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Chatty and self-correcting. Notices when she misspeaks and gives "
                "Donna the corrected detail."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Share an initial bridge routine with a friend's name",
                trigger_phrase=(
                    "I play bridge on Tuesday with Eleanor from church."
                ),
            ),
            CallerGoal(
                description="Correct the friend's name",
                trigger_phrase=(
                    "Oh listen to me, I meant Nora, not Eleanor. Nora is the one "
                    "from church."
                ),
            ),
            CallerGoal(
                description="Share a hobby detail",
                trigger_phrase="We usually have tea afterward and talk about quilting.",
            ),
            CallerGoal(
                description="Warm goodbye",
                trigger_phrase="I'm glad I corrected that. Talk to you later.",
            ),
        ],
        call_type="discovery",
        max_turns=12,
        expect_tool_calls=["record_discovery_fact"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def discovery_mock_call_scenarios() -> list[LiveSimScenario]:
    """Six-branch discovery coverage set for the mock-call harness."""
    return [
        discovery_scenario(),
        discovery_quiet_routine_scenario(),
        discovery_off_topic_weather_scenario(),
        discovery_boundary_redirect_scenario(),
        discovery_early_goodbye_scenario(),
        discovery_correction_scenario(),
    ]


def discovery_boundary_reminder_attempt_scenario() -> LiveSimScenario:
    """Discovery call where the senior tries to create a reminder."""
    return LiveSimScenario(
        name="discovery_boundary_reminder_attempt",
        description=(
            "During discovery, caller asks Donna to set a reminder. Donna "
            "should keep the get-to-know-you call focused and avoid turning "
            "the whole call into reminder scheduling."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Warm and talkative. Shares useful profile details, but also "
                "tests whether Donna drifts into unrelated workflows."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Share a discovery fact",
                trigger_phrase="I usually see my neighbor Helen on Thursday mornings.",
            ),
            CallerGoal(
                description="Try to create a reminder during discovery",
                trigger_phrase="Could you remind me to bring Helen the pie plate next week?",
            ),
            CallerGoal(
                description="Return to profile-building conversation",
                trigger_phrase="Anyway, Helen and I usually talk about our gardens.",
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="It was nice getting to know you, Donna. Bye.",
            ),
        ],
        call_type="discovery",
        max_turns=12,
        expect_tool_calls=["record_discovery_fact"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def embedding_outage_scenario() -> LiveSimScenario:
    """Scenario for memory-search degradation when embeddings are unavailable.

    This simulates the OpenAI embedding quota/token exhaustion class of failure:
    Donna should keep the conversation moving even when semantic memory search
    cannot produce a query embedding.
    """
    return LiveSimScenario(
        name="embedding_outage",
        description=(
            "Caller asks Donna to remember a prior detail while embedding "
            "generation is forced unavailable. The call should continue "
            "without memory injection."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Warm and patient. Curious whether Donna remembers earlier "
                "garden details, but comfortable moving on if she does not."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask whether Donna remembers the rose bushes from a prior call",
                trigger_phrase=(
                    "Do you remember what I told you about my rose bushes "
                    "last time? I was worried they weren't blooming."
                ),
            ),
            CallerGoal(
                description="Accept uncertainty and continue talking about the garden",
                trigger_phrase=(
                    "That's alright if you don't have it handy. The roses "
                    "are doing a bit better this week."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Thanks for chatting with me, dear. Bye bye!",
            ),
        ],
        call_type="check-in",
        max_turns=8,
        expect_tool_calls=[],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
        force_embedding_outage=True,
    )


def false_goodbye_scenario() -> LiveSimScenario:
    """Scenario that exercises false-goodbye handling mid-call."""
    return LiveSimScenario(
        name="false_goodbye",
        description=(
            "Caller says a goodbye-like phrase to someone nearby, then clearly "
            "continues with Donna. The call should not end early."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Friendly and easily distracted by neighbors, but clear when "
                "she is still speaking to Donna."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Say goodbye to a neighbor, then immediately continue with Donna",
                trigger_phrase=(
                    "Oh, hold on just a second — bye Helen, take care getting "
                    "home. Sorry Donna, that was my neighbor leaving. I'm "
                    "still here."
                ),
            ),
            CallerGoal(
                description="Continue the conversation with a gardening update",
                trigger_phrase=(
                    "Anyway, I wanted to tell you the roses by the porch are "
                    "finally opening up."
                ),
            ),
            CallerGoal(
                description="Say goodbye to Donna warmly at the end",
                trigger_phrase="Now I really should go. Bye Donna, talk to you soon!",
            ),
        ],
        call_type="check-in",
        max_turns=9,
        expect_tool_calls=[],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def low_engagement_scenario() -> LiveSimScenario:
    """Scenario where a reserved senior gives short, low-signal answers."""
    return LiveSimScenario(
        name="low_engagement",
        description=(
            "Reserved caller gives short answers. Donna should vary "
            "re-engagement and use personal interests without interrogating."
        ),
        senior=_harold_senior(),
        persona=CallerPersona(
            name=_HAROLD_BASE.name,
            age=_HAROLD_BASE.age,
            personality=_HAROLD_BASE.personality,
            speech_style=_HAROLD_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Answer briefly without volunteering much",
                trigger_phrase="Fine. Not much going on.",
            ),
            CallerGoal(
                description="Stay reserved, then mention an old western if Donna keeps trying",
                trigger_phrase="I watched an old western earlier. It was alright.",
            ),
            CallerGoal(
                description="Say a brief goodbye",
                trigger_phrase="Alright. Thanks for calling. Bye.",
            ),
        ],
        call_type="check-in",
        max_turns=10,
        expect_tool_calls=[],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def health_concern_scenario() -> LiveSimScenario:
    """Scenario for a non-emergency health/safety mention."""
    return LiveSimScenario(
        name="health_concern",
        description=(
            "Caller mentions feeling lightheaded and taking a small stumble. "
            "Donna should respond with calm concern and practical escalation."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Warm but a little embarrassed to bring up a safety concern. "
                "Open to telling family or a clinician if Donna suggests it."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Mention feeling lightheaded and taking a small stumble",
                trigger_phrase=(
                    "I got a little lightheaded yesterday and took a small "
                    "stumble in the kitchen. I'm alright now, just a bit shaken."
                ),
            ),
            CallerGoal(
                description="Say you have not told family or a clinician yet",
                trigger_phrase=(
                    "No, I haven't told Lisa or called anyone yet. I didn't "
                    "want to make a fuss."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly after discussing the concern",
                trigger_phrase="Thank you for worrying about me. I'll be careful. Bye now.",
            ),
        ],
        call_type="check-in",
        max_turns=10,
        expect_tool_calls=[],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def cognitive_confusion_scenario() -> LiveSimScenario:
    """Scenario where the caller is pleasant but confused."""
    return LiveSimScenario(
        name="cognitive_confusion",
        description=(
            "Caller asks who Donna is, repeats herself, and mixes up the day. "
            "Donna should stay patient, orient gently, and avoid frustration."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Pleasant but foggy today. Repeats herself and needs gentle "
                "orientation, but is not in acute distress."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask who is calling even after Donna introduces herself",
                trigger_phrase="I'm sorry, who is this again? I got a little turned around.",
            ),
            CallerGoal(
                description="Repeat a question and confuse the day",
                trigger_phrase=(
                    "Did I already ask about the garden club? Was that today "
                    "or Tuesday? I can't quite remember."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Thank you for being patient with me. Bye for now.",
            ),
        ],
        call_type="check-in",
        max_turns=10,
        expect_tool_calls=[],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def reminder_creation_scenario() -> LiveSimScenario:
    """Scenario where the caller asks Donna to create a new reminder."""
    return LiveSimScenario(
        name="reminder_creation",
        description=(
            "Bilingual caller asks Donna to save a new one-time reminder. "
            "Donna should gather title, timing, recurrence, confirm, and call "
            "create_reminder."
        ),
        senior=_carmen_senior(),
        persona=CallerPersona(
            name=_CARMEN_BASE.name,
            age=_CARMEN_BASE.age,
            personality=(
                "Warm and cooperative. Wants Donna to remember a specific "
                "appointment and will answer follow-up questions clearly."
            ),
            speech_style=_CARMEN_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask Donna in Spanish to create a new reminder",
                trigger_phrase=(
                    "Donna, recuérdame que el martes tengo cita con Elena "
                    "a las tres de la tarde."
                ),
            ),
            CallerGoal(
                description="Clarify that this is a one-time appointment next Tuesday at 3 PM",
                trigger_phrase=(
                    "Sí, está bien. Es solo una vez, el próximo martes a "
                    "las tres de la tarde."
                ),
            ),
            CallerGoal(
                description="Confirm the reminder details when Donna reads them back",
                trigger_phrase="Sí, correcto. Por favor guárdalo así.",
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Gracias, Donna. Hasta luego.",
            ),
        ],
        call_type="check-in",
        max_turns=12,
        expect_tool_calls=["create_reminder"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def async_search_overlap_scenario() -> LiveSimScenario:
    """Scenario where the caller asks another question while search is pending."""
    return LiveSimScenario(
        name="async_search_overlap",
        description=(
            "Caller asks for weather, then asks about the Cowboys while Donna "
            "is still working through the search result. This exercises filler "
            "timing, tool overlap, and stale-answer handling."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Curious and a little impatient when waiting for information. "
                "Loves gardening and follows the Dallas Cowboys."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask Donna to check the weather for the tomato plants",
                trigger_phrase=(
                    "Could you check the weather for me? I need to know if "
                    "I should cover my tomato plants."
                ),
            ),
            CallerGoal(
                description="Ask about the Cowboys before the earlier search fully settles",
                trigger_phrase=(
                    "And while you're checking, did the Cowboys play this "
                    "weekend? I wanted to know how they did."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly after getting the information",
                trigger_phrase="Thank you for looking all that up. I should go now. Bye bye!",
            ),
        ],
        call_type="check-in",
        max_turns=10,
        expect_tool_calls=["web_search"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


def slow_search_overlap_scenario() -> LiveSimScenario:
    """Scenario where web search is intentionally delayed."""
    scenario = async_search_overlap_scenario()
    scenario.name = "slow_search_overlap"
    scenario.description = (
        "Caller asks a second current-info question while web_search is "
        "forced slow. Donna should use filler, avoid duplicate queries, and "
        "answer from the result once it arrives."
    )
    scenario.force_slow_web_search_seconds = 3.0
    return scenario


def empty_search_result_scenario() -> LiveSimScenario:
    """Scenario where web search returns no useful result."""
    return LiveSimScenario(
        name="empty_search_result",
        description=(
            "Caller asks a current-info question while web_search is forced "
            "to return an empty result. Donna should explain naturally and "
            "not retry-loop."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Curious but comfortable if Donna cannot find something "
                "reliable right away."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask about a local event search",
                trigger_phrase=(
                    "Could you check whether there are any garden club events "
                    "near me this weekend?"
                ),
            ),
            CallerGoal(
                description="Accept that Donna may not find a useful result",
                trigger_phrase="That's okay if you can't find it. I can ask Eleanor later.",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="Thanks for trying, Donna. Bye.",
            ),
        ],
        call_type="check-in",
        max_turns=8,
        expect_tool_calls=["web_search"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
        force_empty_web_search=True,
    )


def search_phi_guard_scenario() -> LiveSimScenario:
    """Scenario where the caller includes private details in a search request."""
    return LiveSimScenario(
        name="search_phi_guard",
        description=(
            "Caller includes fake private details in a web-search request. "
            "The search tool should sanitize names/contact/location details "
            "before sending the query out."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality="Trusting and likely to include too much detail in a request.",
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Ask a search question with fake private details",
                trigger_phrase=(
                    "Could you look up garden services for my neighbor Alice "
                    "at 123 Maple Street? Her number is 555-121-3434."
                ),
            ),
            CallerGoal(
                description="Move on after Donna answers or redirects",
                trigger_phrase="That's fine. I just wanted a general idea.",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="Thanks, Donna. Bye now.",
            ),
        ],
        call_type="check-in",
        max_turns=8,
        expect_tool_calls=["web_search"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )
