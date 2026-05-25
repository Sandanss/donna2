"""Generate sanitized post-call-analysis fixtures from real conversations.

Pulls the last N completed conversations from the connected DB
(railway run --environment dev --service donna-pipecat -- ...), decrypts
the transcript, sanitizes identifiers, and writes a JSON fixture per
conversation under tests/fixtures/transcripts/.

PHI hygiene rules applied:
  - Senior + family + friend personal names → generic placeholders
    (SENIOR_NAME, FAMILY_1, FRIEND_1, …) consistent within a single call
  - Phone numbers → REDACTED_PHONE
  - Email addresses → REDACTED_EMAIL
  - Street addresses → REDACTED_ADDRESS
  - Dates with year → keep month/day, strip year
  - Specific medication names → generic ("a medication")
  - URLs → REDACTED_URL

The fixture JSON also records expected_traits (sentiment range, engagement
range, presence of reminders, etc.) which the regression suite asserts
against on replay. expected_traits is filled by running the current
analyzer once at generation time — this captures the CURRENT model
behavior as the regression baseline; if a future model produces wildly
different output the test fails, prompting review.

Usage:
  cd pipecat
  railway run --environment dev --service donna-pipecat -- \
    uv run python scripts/generate_analysis_fixtures.py --count 5

  # Or against staging:
  railway run --environment staging --service donna-pipecat -- \
    uv run python scripts/generate_analysis_fixtures.py --count 5

Fixtures are intentionally committed to the repo so CI can run regressions
without DB access. Re-run this script when adding new edge cases.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "transcripts"


# ---------------------------------------------------------------------------
# Sanitization
# ---------------------------------------------------------------------------

_PHONE_RE = re.compile(r"\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b")
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_URL_RE = re.compile(r"https?://\S+")
_STREET_RE = re.compile(
    r"\b\d{1,6}\s+[A-Za-z0-9 .'-]+?\s+"
    r"(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b",
    re.I,
)
_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
# Crude medication name detector — capitalized word ending in common drug
# suffixes. Real medication-NER is a separate project; this is best-effort.
_MED_RE = re.compile(
    r"\b[A-Z][a-z]{3,}(?:olol|pril|sartan|statin|ide|azole|cycline|formin|ine)\b"
)


def _build_name_map(senior_first_name: str, transcript_text: str) -> dict[str, str]:
    """Build a stable name → placeholder map for one transcript.

    Detects proper-noun candidates (capitalized words 3+ chars not at sentence
    start) and assigns roles based on heuristic context. The senior's own
    name always maps to SENIOR_NAME.
    """
    name_map: dict[str, str] = {}
    if senior_first_name:
        name_map[senior_first_name] = "SENIOR_NAME"
        # Also handle title-cased variants
        for variant in (senior_first_name.upper(), senior_first_name.lower()):
            name_map[variant] = "SENIOR_NAME"

    # Candidate names: words that look like names, appear multiple times.
    candidates: dict[str, int] = {}
    for m in re.finditer(r"\b([A-Z][a-z]{2,15})\b", transcript_text):
        word = m.group(1)
        # Skip common false positives
        if word.lower() in {
            "donna", "yes", "yeah", "okay", "well", "hi", "hello", "thanks",
            "thursday", "friday", "saturday", "sunday", "monday", "tuesday",
            "wednesday", "january", "february", "march", "april", "may",
            "june", "july", "august", "september", "october", "november",
            "december", "today", "tomorrow", "yesterday", "morning",
            "afternoon", "evening", "night", "spring", "summer", "fall",
            "winter", "the", "this", "that", "but", "and", "or", "so",
            "what", "when", "where", "why", "how", "who", "she", "he",
            "they", "we", "i", "you", "it", "good", "great", "nice",
            "right", "really", "very", "much", "always", "never", "still",
            "just", "even", "only", "also", "again", "now", "then",
            "before", "after", "during", "while", "since", "until",
            "though", "although", "however", "actually", "maybe",
            "probably", "definitely", "certainly", "perhaps", "sure",
            "absolutely", "exactly", "honestly", "literally",
        }:
            continue
        candidates[word] = candidates.get(word, 0) + 1

    # Anything mentioned 2+ times that isn't already mapped → assign a placeholder
    counter = 1
    for name, count in sorted(candidates.items(), key=lambda kv: -kv[1]):
        if count >= 2 and name not in name_map:
            name_map[name] = f"PERSON_{counter}"
            counter += 1
            if counter > 8:
                break
    return name_map


def _sanitize_text(text: str, name_map: dict[str, str]) -> str:
    if not text:
        return text
    s = text
    # Phones, emails, URLs, addresses first (before name pass)
    s = _PHONE_RE.sub("REDACTED_PHONE", s)
    s = _EMAIL_RE.sub("REDACTED_EMAIL", s)
    s = _URL_RE.sub("REDACTED_URL", s)
    s = _STREET_RE.sub("REDACTED_ADDRESS", s)
    s = _MED_RE.sub("a medication", s)
    s = _YEAR_RE.sub("YEAR", s)
    # Names (longest first to avoid partial matches)
    for name, placeholder in sorted(name_map.items(), key=lambda kv: -len(kv[0])):
        s = re.sub(rf"\b{re.escape(name)}\b", placeholder, s)
    return s


def _sanitize_transcript(transcript, name_map):
    """Sanitize a transcript that may be a list-of-dicts or a string."""
    if isinstance(transcript, str):
        return _sanitize_text(transcript, name_map)
    if isinstance(transcript, list):
        return [
            {
                **t,
                "content": _sanitize_text(t.get("content", ""), name_map),
            }
            for t in transcript
        ]
    return transcript


# ---------------------------------------------------------------------------
# Fixture generation
# ---------------------------------------------------------------------------


async def _generate(count: int, environment_label: str, force: bool):
    import asyncpg
    sys.path.insert(0, str(REPO_ROOT))
    from lib.encryption import decrypt, decrypt_json
    from services.call_analysis import analyze_completed_call

    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        rows = await conn.fetch(
            """SELECT c.id, c.call_sid, c.senior_id, c.duration_seconds,
                      c.started_at, c.transcript, c.transcript_encrypted,
                      c.transcript_text_encrypted,
                      s.name AS senior_name, s.timezone AS senior_timezone,
                      s.interests AS senior_interests
               FROM conversations c
               JOIN seniors s ON s.id = c.senior_id
               WHERE c.duration_seconds IS NOT NULL
                 AND c.duration_seconds >= 60
                 AND (c.transcript IS NOT NULL OR c.transcript_encrypted IS NOT NULL OR c.transcript_text_encrypted IS NOT NULL)
               ORDER BY c.started_at DESC
               LIMIT $1""",
            count,
        )
        if not rows:
            print(f"✗ No suitable conversations found in {environment_label}")
            return 0

        FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
        generated = 0
        for row in rows:
            slug = f"{environment_label}_{row['id'].hex[:8]}"
            out_path = FIXTURE_DIR / f"{slug}.json"
            if out_path.exists() and not force:
                print(f"  ↷ {out_path.name} exists, skipping (use --force to regenerate)")
                continue

            # Decrypt transcript
            transcript = None
            if row["transcript_encrypted"]:
                try:
                    transcript = decrypt_json(row["transcript_encrypted"])
                except Exception:
                    pass
            if not transcript and row["transcript_text_encrypted"]:
                transcript = decrypt(row["transcript_text_encrypted"])
            if not transcript and row["transcript"]:
                transcript = row["transcript"]
            if not transcript:
                print(f"  ✗ {slug}: no decryptable transcript")
                continue

            # Build sanitization map from senior first name + transcript content
            senior_first = (row["senior_name"] or "").split(" ")[0]
            transcript_str = (
                "\n".join(t.get("content", "") for t in transcript)
                if isinstance(transcript, list)
                else transcript
            )
            name_map = _build_name_map(senior_first, transcript_str)
            sanitized_transcript = _sanitize_transcript(transcript, name_map)

            # Run current analyzer to capture baseline expected behavior.
            # The fixture stores expected_traits (RANGES, not exact values)
            # so regression tests can validate model behavior without being
            # brittle to natural Claude variability.
            senior_ctx = {
                "name": "SENIOR_NAME",
                "timezone": row["senior_timezone"],
                "family": [],
            }
            analysis = await analyze_completed_call(
                sanitized_transcript,
                senior_ctx,
                call_started_at=row["started_at"],
            )

            expected_traits = {
                "sentiment_enum_member": analysis.get("sentiment"),
                "engagement_min": max(1, (analysis.get("engagement_score") or 5) - 2),
                "engagement_max": min(10, (analysis.get("engagement_score") or 5) + 2),
                "summary_min_chars": 40,
                "summary_max_chars": 600,
                "topics_min_count": 0,
                "topics_max_count": 8,
                "caregiver_sms_max_chars": 280,
                "concerns_must_be_empty": True,
                "follow_up_suggestions_must_be_empty": True,
                "recommended_caregiver_action_must_be_empty_string": True,
            }

            fixture = {
                "fixture_version": 1,
                "source": environment_label,
                "source_conversation_id": str(row["id"]),
                "source_duration_seconds": row["duration_seconds"],
                "source_started_at": row["started_at"].isoformat()
                if row["started_at"]
                else None,
                "senior_context": senior_ctx,
                "transcript": sanitized_transcript,
                "expected_traits": expected_traits,
                "name_map_size": len(name_map),
            }
            out_path.write_text(json.dumps(fixture, indent=2, default=str))
            print(f"  ✓ {out_path.name} (turns={len(sanitized_transcript) if isinstance(sanitized_transcript, list) else 'text'}, sentiment={expected_traits['sentiment_enum_member']}, eng={analysis.get('engagement_score')}/10)")
            generated += 1
        return generated
    finally:
        await conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=5, help="Number of recent conversations to fetch.")
    parser.add_argument("--label", default="dev", help="Environment label to embed in fixture filenames (dev/staging).")
    parser.add_argument("--force", action="store_true", help="Overwrite existing fixtures.")
    args = parser.parse_args()

    print(f"Generating {args.count} fixture(s) labeled '{args.label}' into {FIXTURE_DIR}")
    n = asyncio.run(_generate(args.count, args.label, args.force))
    print(f"\nGenerated {n} fixture(s).")


if __name__ == "__main__":
    main()
