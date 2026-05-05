# Plans

## Current Plan

- [`2026-05-05-engineering-remediation-plan.md`](2026-05-05-engineering-remediation-plan.md) - current engineering fix plan from the May 5 audit. BAA/vendor agreement gates are intentionally out of scope for this plan.

## Historical Plans

Other dated plans are retained for context and auditability. They may describe superseded Twilio voice/SMS paths, Sonnet defaults, Cerebras experiments, Cartesia rollout ideas, `search_memories` as a live Claude tool, Director-owned web-search gating, or old 8kHz media assumptions.

For current implementation source of truth, use:

- [`../../DIRECTORY.md`](../../DIRECTORY.md)
- [`../architecture/`](../architecture/)
- [`../../pipecat/docs/ARCHITECTURE.md`](../../pipecat/docs/ARCHITECTURE.md)
- [`../../pipecat/docs/LEARNINGS.md`](../../pipecat/docs/LEARNINGS.md)

As of April 22, 2026, the active live-call stack is Telnyx Call Control/media streams with L16/16k audio, Deepgram Nova 3 STT, Claude Haiku 4.5 for conversation, Groq Director with Gemini fallback, ElevenLabs Flash TTS, Gemini post-call analysis, and email/in-app caregiver notifications. SMS and Twilio voice are inactive.
