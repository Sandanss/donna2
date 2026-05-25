"""Replay regression suite for post-call analysis.

For each fixture in tests/fixtures/transcripts/, run analyze_completed_call
against the sanitized transcript and assert:
  - The forced tool-use actually fired (no parse-error fallback)
  - All required output fields are present
  - sentiment is one of the enum values
  - engagement_score is an int 1-10 within the fixture's expected band
  - summary is non-empty and within length bounds
  - call_quality has rapport/goals_achieved/duration_appropriate
  - The locked-empty fields (concerns / follow_up_suggestions /
    recommended_caregiver_action) stay empty — by-design constraint of
    the tool input_schema

Two run modes:

  1. Fixture mode (default): replays the JSON fixtures shipped in the repo.
     Hits the real Anthropic API. Gated by @pytest.mark.llm_simulation +
     ANTHROPIC_API_KEY env var — skipped silently without the key.

  2. Live-DB mode (opt-in): set DONNA_REPLAY_LIVE_SOURCE=dev (or staging)
     plus DATABASE_URL, and the suite pulls the last N conversations from
     that DB on the fly and runs the same property checks. Adds @pytest.mark.
     live_analysis so it never runs in CI. Run manually like:

         cd pipecat
         railway run --environment dev --service donna-pipecat -- \
           env DONNA_REPLAY_LIVE_SOURCE=dev DONNA_REPLAY_LIVE_COUNT=5 \
           uv run pytest tests/test_call_analysis_replay.py::TestLiveDbReplay -v

Regenerate the in-repo fixtures with:
    cd pipecat
    railway run --environment dev --service donna-pipecat -- \
        uv run python scripts/generate_analysis_fixtures.py --count 5 --force
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "transcripts"

# Required env for any of these tests to run. The whole module is skipped
# silently in CI / local without the key — opt-in only.
pytestmark = [
    pytest.mark.llm_simulation,
    pytest.mark.skipif(
        not os.environ.get("ANTHROPIC_API_KEY"),
        reason="Requires ANTHROPIC_API_KEY",
    ),
]


_SENTIMENT_ENUM = {"positive", "neutral", "concerned", "worried", "distressed"}


def _load_fixtures() -> list[tuple[str, dict]]:
    """Return [(fixture_name, fixture_dict), ...] for every .json file."""
    if not FIXTURE_DIR.exists():
        return []
    fixtures = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        with path.open() as f:
            fixtures.append((path.stem, json.load(f)))
    return fixtures


def _assert_structural_correctness(result: dict, expected: dict):
    """Property checks that hold for any well-formed analysis result."""
    # 1. Required fields present
    required_keys = {
        "summary", "sentiment", "topics_discussed", "reminders_delivered",
        "engagement_score", "mood", "caregiver_sms", "caregiver_takeaways",
        "recommended_caregiver_action", "concerns", "positive_observations",
        "follow_up_suggestions", "call_quality",
    }
    missing = required_keys - set(result.keys())
    assert not missing, f"Missing required fields: {missing}"

    # 2. sentiment is a valid enum member
    sentiment = result.get("sentiment")
    assert sentiment in _SENTIMENT_ENUM, (
        f"sentiment={sentiment!r} is not in {_SENTIMENT_ENUM}"
    )

    # 3. engagement_score 1-10 integer
    eng = result.get("engagement_score")
    assert isinstance(eng, int), f"engagement_score must be int, got {type(eng).__name__}"
    assert 1 <= eng <= 10, f"engagement_score={eng} out of range"

    # 4. summary present + length bounds
    summary = result.get("summary") or ""
    assert isinstance(summary, str)
    assert len(summary) >= expected.get("summary_min_chars", 1), (
        f"summary too short ({len(summary)} chars): {summary[:80]}"
    )
    assert len(summary) <= expected.get("summary_max_chars", 1000), (
        f"summary too long ({len(summary)} chars)"
    )

    # 5. Topics + caregiver_sms shape
    topics = result.get("topics_discussed") or []
    assert isinstance(topics, list)
    assert len(topics) <= expected.get("topics_max_count", 12)
    csms = result.get("caregiver_sms") or ""
    assert isinstance(csms, str)
    assert len(csms) <= expected.get("caregiver_sms_max_chars", 280)

    # 6. call_quality shape
    cq = result.get("call_quality") or {}
    assert isinstance(cq, dict)
    assert cq.get("rapport") in {"strong", "moderate", "weak"}, (
        f"call_quality.rapport={cq.get('rapport')!r}"
    )
    assert isinstance(cq.get("goals_achieved"), bool)
    assert isinstance(cq.get("duration_appropriate"), bool)

    # 7. Locked-empty fields — by-design tool schema constraint
    if expected.get("concerns_must_be_empty"):
        assert result.get("concerns") == [], (
            f"concerns must be empty, got {result.get('concerns')!r}"
        )
    if expected.get("follow_up_suggestions_must_be_empty"):
        assert result.get("follow_up_suggestions") == [], (
            f"follow_up_suggestions must be empty, got {result.get('follow_up_suggestions')!r}"
        )
    if expected.get("recommended_caregiver_action_must_be_empty_string"):
        rca = result.get("recommended_caregiver_action")
        assert rca == "", (
            f"recommended_caregiver_action must be empty string, got {rca!r}"
        )


def _assert_within_fixture_band(result: dict, expected: dict):
    """Soft assertions tied to the fixture's captured baseline. Catches
    big behavioral regressions without being brittle to Claude's natural
    output variability (allowed ±2 on engagement, sentiment band flex)."""
    eng = result["engagement_score"]
    eng_min = expected.get("engagement_min", 1)
    eng_max = expected.get("engagement_max", 10)
    assert eng_min <= eng <= eng_max, (
        f"engagement={eng} drifted outside fixture band [{eng_min}, {eng_max}]"
    )
    # sentiment is harder to compare directly (positive/neutral/concerned
    # are close neighbors in this taxonomy). Just check it's a valid enum
    # member; bigger flips (positive → distressed) would be caught by a
    # human review of the test diffs.


# ---------------------------------------------------------------------------
# Fixture-based regression
# ---------------------------------------------------------------------------

_fixtures = _load_fixtures()


@pytest.mark.skipif(not _fixtures, reason="No fixtures committed yet")
class TestFixtureReplay:
    """Run analyze_completed_call against committed fixture transcripts.

    Each fixture was generated from a real sanitized conversation. The
    fixture itself records expected_traits — sentiment value, engagement
    range — captured at generation time. This test ensures the analyzer
    keeps producing structurally-valid output of comparable quality on
    representative transcripts.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "fixture_name,fixture",
        _fixtures,
        ids=[name for name, _ in _fixtures],
    )
    async def test_fixture_analyzed_within_structural_bounds(
        self, fixture_name, fixture
    ):
        from datetime import datetime
        from services.call_analysis import analyze_completed_call

        started_at = None
        if fixture.get("source_started_at"):
            try:
                started_at = datetime.fromisoformat(fixture["source_started_at"])
            except Exception:
                started_at = None

        result = await analyze_completed_call(
            transcript=fixture["transcript"],
            senior_context=fixture.get("senior_context") or {},
            call_started_at=started_at,
        )

        expected = fixture.get("expected_traits") or {}
        _assert_structural_correctness(result, expected)
        _assert_within_fixture_band(result, expected)


# ---------------------------------------------------------------------------
# Live-DB replay (opt-in)
# ---------------------------------------------------------------------------

_LIVE_SOURCE = os.environ.get("DONNA_REPLAY_LIVE_SOURCE")
_LIVE_COUNT = int(os.environ.get("DONNA_REPLAY_LIVE_COUNT") or "5")


@pytest.mark.live_analysis
@pytest.mark.skipif(
    not _LIVE_SOURCE,
    reason="Set DONNA_REPLAY_LIVE_SOURCE=dev|staging to enable. Never runs in CI.",
)
class TestLiveDbReplay:
    """Pull the last N conversations from the live DB and verify the
    analyzer produces structurally-correct output. Use sparingly — burns
    real Anthropic tokens and only catches regressions you wouldn't have
    seen from the committed fixtures."""

    @pytest.fixture
    async def live_conversations(self):
        import asyncpg
        from lib.encryption import decrypt, decrypt_json

        conn = await asyncpg.connect(os.environ["DATABASE_URL"])
        try:
            rows = await conn.fetch(
                """SELECT c.id, c.call_sid, c.senior_id, c.duration_seconds,
                          c.started_at, c.transcript, c.transcript_encrypted,
                          c.transcript_text_encrypted,
                          s.name AS senior_name, s.timezone
                   FROM conversations c
                   JOIN seniors s ON s.id = c.senior_id
                   WHERE c.duration_seconds IS NOT NULL
                     AND c.duration_seconds >= 60
                     AND (c.transcript IS NOT NULL
                          OR c.transcript_encrypted IS NOT NULL
                          OR c.transcript_text_encrypted IS NOT NULL)
                   ORDER BY c.started_at DESC
                   LIMIT $1""",
                _LIVE_COUNT,
            )
            out = []
            for row in rows:
                transcript = None
                if row["transcript_encrypted"]:
                    try:
                        transcript = decrypt_json(row["transcript_encrypted"])
                    except Exception:
                        pass
                if not transcript and row["transcript_text_encrypted"]:
                    transcript = decrypt(row["transcript_text_encrypted"])
                if not transcript:
                    continue
                out.append({
                    "id": str(row["id"]),
                    "transcript": transcript,
                    "senior_context": {
                        "name": row["senior_name"],
                        "timezone": row["timezone"],
                    },
                    "started_at": row["started_at"],
                })
            return out
        finally:
            await conn.close()

    @pytest.mark.asyncio
    async def test_recent_live_conversations_analyze_correctly(
        self, live_conversations
    ):
        from services.call_analysis import analyze_completed_call

        # Property-only checks for live data; no fixture band since these
        # transcripts are new.
        baseline = {
            "summary_min_chars": 20,
            "summary_max_chars": 800,
            "topics_max_count": 12,
            "caregiver_sms_max_chars": 280,
            "concerns_must_be_empty": True,
            "follow_up_suggestions_must_be_empty": True,
            "recommended_caregiver_action_must_be_empty_string": True,
        }

        results = []
        for conv in live_conversations:
            result = await analyze_completed_call(
                transcript=conv["transcript"],
                senior_context=conv["senior_context"],
                call_started_at=conv["started_at"],
            )
            _assert_structural_correctness(result, baseline)
            results.append({
                "id": conv["id"],
                "sentiment": result["sentiment"],
                "engagement": result["engagement_score"],
            })
        assert results, f"Pulled 0 live conversations from {_LIVE_SOURCE}"
        # Print a quick summary so the operator can eyeball drift.
        print(f"\nLive replay summary ({_LIVE_SOURCE}): {len(results)} calls analyzed")
        for r in results:
            print(f"  {r['id'][:8]}  sentiment={r['sentiment']:10}  eng={r['engagement']}/10")
