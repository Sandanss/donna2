"""Predefined simulation scenarios for LLM-to-LLM voice tests.

Each factory function returns a fully configured ``LiveSimScenario`` — a
dataclass that bundles a senior profile, caller persona, ordered goals,
and expected outcomes.  Scenarios are pure data: no DB access, no LLM
calls, no I/O.  They are consumed by ``CallSimRunner`` (Task 7) which
wires them into the live pipeline.

Scenarios shipped:

* ``web_search_scenario``      — weather + sports triggers web_search tool
* ``memory_seed_scenario``     — shares new family info (post-call extraction)
* ``memory_recall_scenario``   — asks Donna to recall previously seeded info
* ``reminder_scenario``        — medication reminder acknowledgement flow
* ``consent_grant_scenario``   — senior grants both call + recording consent
* ``consent_decline_scenario`` — senior accepts calls but declines recording
* ``discovery_scenario``       — senior shares friends/hobbies/routines
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
        reminder_title: Medication reminder title (reminder scenarios only).
        reminder_description: Reminder detail text (reminder scenarios only).
        expect_tool_calls: Tool names that *should* be invoked during the call.
        expect_memories_injected: Whether Director should inject memories.
        expect_post_call_analysis: Whether post-call analysis should run.
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

    # Expected outcomes
    expect_tool_calls: list[str] = field(default_factory=list)
    expect_memories_injected: bool = False
    expect_post_call_analysis: bool = True


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


def _margaret_senior() -> TestSenior:
    """Default test senior matching the Margaret persona."""
    return TestSenior()


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
    """Scenario that tests medication reminder delivery and acknowledgement.

    This is a reminder-type call.  Margaret chats briefly, receives the
    metformin reminder, and acknowledges it.  The pipeline should invoke
    ``mark_reminder_acknowledged``.
    """
    return LiveSimScenario(
        name="reminder",
        description=(
            "Reminder call: caller chats briefly, receives metformin "
            "reminder, and acknowledges it. Expects "
            "mark_reminder_acknowledged tool call."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Cooperative about medications. Appreciates reminders and "
                "is good about taking her medicine when prompted."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description=(
                    "Chat briefly and wait for the medication reminder"
                ),
                trigger_phrase="Oh, I'm doing alright today, just had some lunch.",
            ),
            CallerGoal(
                description="Acknowledge the medication reminder clearly",
                trigger_phrase=(
                    "Oh yes, thank you for reminding me! I'll take my "
                    "metformin right now with my dinner."
                ),
            ),
            CallerGoal(
                description="Say goodbye warmly",
                trigger_phrase="Thanks dear, you're always so helpful. Bye bye!",
            ),
        ],
        call_type="reminder",
        max_turns=8,
        reminder_title="Take metformin",
        reminder_description="500mg with dinner",
        expect_tool_calls=["mark_reminder_acknowledged"],
        expect_memories_injected=False,
        expect_post_call_analysis=True,
    )


# ---------------------------------------------------------------------------
# Consent + Discovery scenarios
# See docs/plans/2026-05-24-consent-and-discovery-call-flows.md
# ---------------------------------------------------------------------------


def consent_grant_scenario() -> LiveSimScenario:
    """First-ever call: Donna asks permission and the senior agrees to both.

    Tests the happy path of the consent flow — call_permission=true AND
    recording_permission=true must each fire record_consent_response once.
    """
    return LiveSimScenario(
        name="consent_grant",
        description=(
            "Consent call: senior grants both call and recording permission. "
            "Expects record_consent_response invoked twice (one per consent_type)."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Friendly but a little cautious about new technology. Trusts her "
                "daughter who set up the account. Agrees to both consents once Donna "
                "explains things clearly."
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
                description="Agree to receive regular calls",
                trigger_phrase="Yeah, that sounds fine. I'd like that.",
            ),
            CallerGoal(
                description="Agree to recordings",
                trigger_phrase="Sure, that's alright with me too.",
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
    """Senior is okay with calls but does NOT want them recorded.

    Tests the mixed-decline path: one consent granted, one declined → roll-up
    must mark the senior as declined (callable=false) and Donna must NOT
    push back on the recording refusal.
    """
    return LiveSimScenario(
        name="consent_decline",
        description=(
            "Consent call: senior agrees to calls but declines recording. "
            "Expects both consent_types captured; roll-up should be 'declined'."
        ),
        senior=_margaret_senior(),
        persona=CallerPersona(
            name=_MARGARET_BASE.name,
            age=_MARGARET_BASE.age,
            personality=(
                "Friendly and chatty but private about her conversations. Happy "
                "for calls but firm about not wanting recordings."
            ),
            speech_style=_MARGARET_BASE.speech_style,
        ),
        goals=[
            CallerGoal(
                description="Acknowledge Donna's introduction",
                trigger_phrase="Oh, alright. That's nice of her to set up.",
            ),
            CallerGoal(
                description="Agree to receive calls",
                trigger_phrase="Yes, calls would be lovely.",
            ),
            CallerGoal(
                description="Decline recording, firmly but politely",
                trigger_phrase=(
                    "Hmm — no, I'd rather you didn't record them. I'm a "
                    "private person."
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
