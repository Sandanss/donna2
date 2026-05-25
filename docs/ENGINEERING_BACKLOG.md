# Engineering Backlog

Tech-debt and refactor opportunities surfaced from periodic codebase audits. Distinct from [`docs/FEATURE_BACKLOG.md`](FEATURE_BACKLOG.md) (product/Nick) and [`docs/plans/`](plans/) (active dated plans). Mark items DONE in place when shipped; remove items that are no longer relevant.

## P0 — High-leverage / shipping risk

### `/api/calls` returns hardcoded active-call data
- **Evidence:** `routes/calls.js:80-81` returns `{ activeCalls: 0, callSids: [] }`. Active calls live in Pipecat, not Node.
- **Risk:** Admin/observability surfaces showing call counts are silently wrong.
- **Suggested next step:** Proxy the call count from Pipecat (e.g., `/health` already returns `_active_calls`) or remove the stub from Node-facing surfaces. Frontends should continue calling the Node API rather than Pipecat directly.

## P1 — Architecture and maintainability

### Largest orchestration files keep growing
- **Evidence (May 2026):**
  - `pipecat/api/routes/telnyx.py` — 1,604 LOC (was 1,306 in April)
  - `services/scheduler.js` — 1,553 LOC (was 990; grew most)
  - `pipecat/processors/conversation_director.py` — 1,303 LOC
  - `routes/observability.js` — 901 LOC
- **Risk:** Reviewers can't hold these in their head; merge conflicts cluster here.
- **Suggested next step:** Extract along stable seams — for `telnyx.py`, separate signature validation / event parsing from outbound call orchestration; for `scheduler.js`, the dual-path queue branches are now large enough to live in their own module.

### Largest mobile screens
- **Evidence:** `apps/mobile/app/(auth)/sign-in.tsx` 1,018 LOC; `apps/mobile/app/(tabs)/schedule.tsx` 1,005 LOC; `apps/mobile/app/(tabs)/reminders.tsx` 573 LOC.
- **Risk:** Combine form state, API calls, validation, and rendering — hard to test, easy to regress.
- **Suggested next step:** Extract screen-specific hooks and field components. Start with `schedule.tsx` (most user-visible) and `sign-in.tsx` (Apple/Clerk auth surface).

### Load tests still model Twilio
- **Evidence:** `pipecat/tests/load/locustfile_ws.py` references Twilio media streams 5×; Telnyx is the active provider.
- **Risk:** Capacity-planning numbers derived from these tests don't reflect production protocol shape.
- **Suggested next step:** Replace mock protocol with Telnyx WebSocket event shapes and L16/16k audio assumptions before using results for scale-2000 capacity planning.

### Node/Python parity contract tests
- **Evidence:** Auth, audit, encryption, token revocation, and retention all have parallel implementations in `services/*.js` and `pipecat/services/*.py` (intentional — see CLAUDE.md). No tests assert the two stay in sync.
- **Risk:** Encrypted-field format drift, audit shape drift, token-revocation semantic drift between backends.
- **Suggested next step:** Paired tests asserting same encrypted field wire format, retention behavior, audit event shape, and token revocation semantics.

---

*Last updated: 2026-05-24 — seeded from April 2026 inventory pass; items re-verified against current main before inclusion.*
