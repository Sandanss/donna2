# Mobile Version Compatibility Plan

Date: May 26, 2026
Status: Proposal — not yet committed work
Primary surfaces: `apps/mobile/src/lib/api.ts`, `middleware/`, `validators/schemas.js`, `routes/helpers.js`, EAS submission flow, CI

## Why this exists

On 2026-05-25 we shipped a mobile binary to the App Store. While Apple held it for review, we changed the backend schema and API contract. When Apple completed review, the just-approved binary hit a backend that no longer matched what it expected and the app failed.

That's not a one-off incident. It's the inevitable result of the operating constraint we'll live with for the life of the product:

- A backend deploy takes minutes.
- An App Store review takes 1–7 days.
- A mobile binary lives on users' phones for **months or years** after release.

So at any moment, the backend is talking to multiple concurrent app versions, and that condition is permanent. We need a system that lets us ship backend changes continuously without breaking either the in-review binary or the long tail of users who haven't updated.

This document is the plan for that system. The principles are independent of any specific change; the implementation phases are concrete deliverables.

---

## 1. The version-space-time model

To reason about this we have to picture every binary that exists at once.

### 1.1 The four cohorts

At any given moment, Donna's backend is fielding requests from:

| Cohort | Who is on it | Typical share of active users | Lifetime |
|---|---|---|---|
| **Latest** (N) | Users who just updated (1-3 days post-release with iOS auto-update on) | 15–30% on day 1, growing | Replaced by N+1 at next release |
| **Currently shipping** (N) | The "current" App Store version most users see | 50–80% at steady state | 2–6 weeks of dominance |
| **Stragglers** (N-1, N-2, N-3) | Users with auto-update off, or who don't open the App Store | 5–20% combined long tail | Indefinite. Some users stay on a version for a year+ |
| **In-review** (N+1) | Apple reviewers, and soon every user once approved | 0% until approval, then becomes the new "latest" | 1–7 days dark, then released into the wild |

For Donna specifically, the long tail will be *longer than average*. Caregivers install once because their parent needs Donna; they don't have the regular App Store browsing habit of office workers. Plan for 3–6 months of N-2 / N-3 support, not 30 days.

### 1.2 What this means for the backend

The backend is a multi-tenant time machine. It permanently serves requests from a sliding window of 3–5 client versions. Process discipline ("just freeze backend changes during review") doesn't survive contact with continuous shipping. The architecture has to absorb the constraint.

### 1.3 Where the in-review window fits

The in-review window is the period of highest risk because:

- The new binary exists but isn't installable by users yet — we can't "force update" out of trouble.
- The Apple reviewer is the first to encounter the new binary, and a backend incompatibility shows up as a *rejection*, not a degraded user experience.
- Every backend change merged during review is potentially a rejection trigger.

But it's not a unique risk — it's just the most acute version of the always-true risk that backend changes break older clients. A system that solves the steady-state problem (continuous back-compat with N-2) also solves the review-window problem (continuous back-compat with N+1, which is functionally just another version).

---

## 2. How big tech handles this

Worth grounding our approach in what actually works at scale. We won't copy any of these wholesale, but each gives us a piece.

### 2.1 Meta / Instagram / WhatsApp

- **Release trains.** Every two weeks, a release branch is cut from main and frozen. All work after that targets the next train. Mobile releases are predictable and decoupled from feature completion.
- **Aggressive feature flagging.** Every new feature is gated behind a server-controlled flag. The same binary can have a feature off for users on N-1 and on for users on N+1 — the backend decides per request based on app version + user attributes.
- **Backend supports ~6 months of versions.** Anything older is force-updated.
- **Force-update is rare** and used for security issues, not for breaking changes (those are handled by back-compat).

**For us**: feature flagging (we already have GrowthBook) is the closest analog. We don't need release trains at our team size; we ship when ready.

### 2.2 Google (Play Services pattern)

- **Modular architecture.** Many Google features run inside Play Services, which updates independently of the host app. Old apps get new capabilities without an update.
- **Protocol Buffers.** Designed for forward/backward compatibility. Unknown fields are preserved; new fields are optional; reserved field numbers prevent collisions.
- **Schema-on-read.** Servers can transform responses to match the client's expected version, often using protobuf reserved tags.

**For us**: Donna doesn't use protobuf and won't (rewriting everything isn't worth it for our scale). But the *spirit* of "schema-on-read" maps to field-level back-compat: server returns whatever shape the client expects, even when the canonical form is different.

### 2.3 Stripe / Twilio (developer-facing API)

- **URL versioning** (`/v1`, `/v2`). Every breaking change gets a new version.
- **Deprecation periods measured in years.** Stripe still serves API versions from 2015.
- **Detailed deprecation policy published**, with explicit timelines and migration guides.

**For us**: URL versioning doesn't fit. We don't have external partners. But the *spirit* — "the contract you shipped against will keep working" — is exactly the contract we need with our mobile clients.

### 2.4 Discord / Slack

- **Aggressive force-update.** Old desktop and mobile clients show an "update required" screen and refuse to run.
- **Acceptable** because users update Discord/Slack regularly anyway (they're daily-active office tools).

**For us**: Bad fit. Our users aren't daily-active office workers, and our use cases (medication reminders, urgent caregiver moments) make force-update screens dangerous. We'll have force-update as a safety valve, not a default.

### 2.5 Notion / Linear / Cash App

- **Notion**: lenient back-compat, weekly mobile releases.
- **Linear**: clean force-update UX (one-tap from the screen to the App Store), used sparingly.
- **Cash App**: strict back-compat because financial data; multi-month deprecation cycles.

**For us**: Donna is closer to Cash App than Notion in tolerance for break — missing a check-in call because the app stopped working is a trust-eroding event. We'll aim for Cash App's strictness but Linear's force-update UX as the safety valve.

### 2.6 What we're borrowing

| Big-tech pattern | Our adaptation |
|---|---|
| Server-controlled feature flags | GrowthBook with app-version targeting |
| Schema-on-read | Field-level back-compat at the API boundary |
| Long deprecation periods | 60–120 day expand-contract cycles for breaking changes |
| Clean force-update UX | One-tap-to-App-Store screen, used only when necessary |
| OTA hotfix capability | Expo Updates for JS-only fixes (see §6) |

What we're explicitly **not** borrowing:

- URL versioning (`/v1`, `/v2`) — overkill for a single mobile client
- Protocol Buffers / GraphQL — rewriting the contract layer isn't worth it
- LaunchDarkly — we already have GrowthBook
- Release trains — our team is too small to benefit from the cadence overhead
- Backend Driven UI (full SDUI) — huge architectural change, not justified yet

---

## 3. Principles

The five rules that govern every backend change we ship.

### 3.1 Additive by default

The default state for any backend change is *additive*. New endpoints, new optional fields, new response fields, new behavior gated behind feature flags. If a change is additive, ship it without ceremony. The only changes that need ceremony are the ones that break an existing contract.

This single principle eliminates 80% of the problem. Most of what we ship doesn't have to be a multi-step migration.

### 3.2 Breaking changes follow expand-contract

When a change *is* breaking, it's not one deploy — it's a process with phases (§4.3). The expand and contract are weeks or months apart. The engineer doing the change writes both PRs at the start; the second one sits open until conditions are met.

### 3.3 The API layer is the contract, the DB is implementation

Mobile clients are not aware of column names, table structures, or storage backends. The translation from canonical (DB) form to client (API) form lives in the API layer (`routes/*.js`). DB migrations are free to rename, restructure, partition, encrypt, or move to blob storage — as long as the API layer hides the change.

This is the principle that makes the audit_logs partitioning, conversations-to-blob, and similar refactors trivial from the mobile-app perspective. The DB does what's right for storage; the API does what's right for clients.

### 3.4 Observability before policy

We can't make decisions about "is it safe to clean this up" without knowing what app versions are actually live. Every policy in this plan depends on the version-distribution dashboard (§4.1). Without it, every decision is a guess.

### 3.5 Force-update is a safety valve, not a strategy

We have the force-update mechanism so we can recover from situations where back-compat isn't feasible. We don't use it to avoid doing back-compat. Each bump of `MIN_APP_VERSION` is treated like a migration with its own runbook.

---

## 4. The system

Five concrete layers. Each one is necessary; together they form a complete system.

### 4.1 Observability: version headers on every request

Every mobile API request includes:

```
X-Donna-App-Version: 1.5.0
X-Donna-Build: 153
X-Donna-Platform: ios
```

Server middleware logs these on every request alongside the existing structured log. We add a single admin dashboard view:

- **Daily active version distribution** (rolling 30 days). What percent of requests come from each version.
- **Per-endpoint version share**. Are some endpoints disproportionately used by older versions?
- **Anomaly alerts**. Alert if traffic on a version we thought was dead suddenly spikes (could indicate a regression on a newer version pushing users back).

This is the foundation. Every decision below depends on this data being available and accurate.

**Implementation**:
- `apps/mobile/src/lib/api.ts` — add headers to every request via interceptor
- `middleware/version-tracking.js` (new) — middleware that reads headers, attaches to request context, logs
- Admin dashboard query — simple `SELECT app_version, COUNT(*) FROM api_logs GROUP BY app_version` view

**Effort**: ~2-3 hours total, single PR.

### 4.2 Safety valve: force-update gate

A `MIN_APP_VERSION_IOS` / `MIN_APP_VERSION_ANDROID` env var (or DB row for hot-swap without redeploy). Server middleware:

```
if app_version < MIN_APP_VERSION_<platform>:
  return 426 Upgrade Required
    body: {
      minVersion: "1.5.0",
      currentVersion: "1.3.0",
      storeUrl: "https://apps.apple.com/...",
      message: "Donna needs an update to keep your check-ins working safely."
    }
```

Mobile client:

```
// apps/mobile/src/lib/api.ts global error handler
if (response.status === 426):
  navigate to UpdateRequired screen
  pass body.storeUrl
```

The UpdateRequired screen is non-dismissable, shows the senior's name if known (so the caregiver knows it's still "their" Donna), and has a single primary action: "Update Now" (opens the App Store).

**Bump policy**: bump `MIN_APP_VERSION` only when version-distribution data (§4.1) says it's safe. Default threshold: <1% of last-30d traffic on versions about to be cut off. Treat each bump like a migration — runbook, communication plan, ramp.

**Implementation**:
- Env var or DB row for current floor
- `middleware/version-gate.js` (new)
- `apps/mobile/src/screens/UpdateRequired.tsx` (new)
- Hook into existing error handler in `apps/mobile/src/lib/api.ts` (`getErrorMessage()` already centralizes error display)

**Effort**: ~1 day, single PR (combine with 4.1).

### 4.3 Contract pattern: field-level expand-contract

For each breaking change, the engineer writes both PRs upfront, even though they're separated by weeks or months.

**Phase 1: Expand** (ships immediately)
- **Validator**: accept both old and new field names. Zod schema uses `.or()` or accepts a union; no `.transform()` per CLAUDE.md.
- **Route handler**: normalize at the top to canonical form. `const x = body.newName ?? body.oldName`.
- **Service layer**: only knows canonical (new) form. No back-compat here.
- **DB**: only canonical schema. Migration adds new column nullable.
- **Response**: include both old and new field names. Old clients read old, new clients read new.
- **Pipecat parity**: if the changed column is read/written by Pipecat (`pipecat/services/*.py`), update both implementations together.

**Phase 2: Coexist** (weeks to months)
- One-time backfill if needed.
- Monitor: log whenever the old field is read or written, tagged with app version.
- Watch the version-distribution dashboard.

**Phase 3: Migrate** (next mobile release)
- Mobile app starts sending and reading new field names exclusively.
- Submit to App Store, wait for approval, wait for adoption.

**Phase 4: Contract** (months later)
- When <1% of last-30d traffic uses the old field (or via `MIN_APP_VERSION` bump), delete the back-compat lines.
- Migration to drop the old DB column.
- Validator drops support for old field name.

The full cycle for a single breaking change is **60–120 days**. That sounds slow but the engineer hours are tiny — most of the time is waiting for adoption, not coding.

### 4.4 Submission ritual: tag-and-freeze

When we submit a binary to the App Store:

1. Tag the current commit: `git tag mobile-1.5.0-submitted-ios`
2. CI snapshots the API contract (validators + sample responses) and stores it keyed by tag
3. Until the tag is marked `approved` (manual or via App Store Connect API), CI runs every backend PR against the tagged contract as a baseline
4. Any PR that breaks the contract is blocked from merging until the tag is approved
5. Once approved, the tag transitions to `live`. Backend changes can now break N-1 (the previous live version) as long as they pass the standard expand-contract dance for any version above `MIN_APP_VERSION`.

This is the missing piece from our 2026-05-25 incident. The freeze isn't a calendar rule someone has to remember; it's enforced by CI.

**Implementation**:
- Tag conventions documented in `commit-process` skill
- New CI job `contract-freeze-check` that:
  - Lists `git tag --list 'mobile-*-submitted-*'` and filters for non-approved
  - For each, diffs the current branch's validators against the tag's snapshot
  - Fails if there's a breaking change
- Admin endpoint or `gh release edit` step to mark a tag as approved
- This replaces "developer remembers not to break things during review"

**Effort**: ~1-2 days, separate PR.

### 4.5 CI gates: catch breaking changes before merge

Three checks that fail PRs without explicit acknowledgment.

**API contract diff**:
- On every PR, serialize all Zod schemas in `validators/schemas.js` to JSON Schema
- Compare to main's serialization
- Any removed field, tightened constraint, or changed type fails the build
- Override: PR must have label `breaking-change` AND link to an expand-contract tracking issue
- The `breaking-change` label triggers a second check: "is the corresponding expand PR already merged?" — prevents shipping a contract before the back-compat for it exists.

**Schema migration linter**:
- Scan new files in `db/migrations/` and `pipecat/db/migrations/`
- Flag `DROP COLUMN`, `ALTER ... TYPE`, `RENAME COLUMN`, `ALTER ... NOT NULL` (without DEFAULT)
- Cross-reference against a hand-maintained list of "API-surface tables" in `tools/api-surface-tables.json` — tables whose columns appear in mobile API responses
- If the table is on the list, require `breaking-change` label

**Submission tag freeze** (described in §4.4):
- Runs on every PR
- Active only when an unapproved submission tag exists
- Fails any PR that breaks the tagged contract

**Effort**: ~2-3 days total, separate PR or sequence of PRs.

---

## 5. Implementation phases

We don't ship everything at once. The order is calibrated so each phase makes the next safer.

### Phase 1: Observability + safety valve (week 1)

**Goal**: never repeat the 2026-05-25 failure mode. Even without the rest of the system, if we have version headers and a force-update gate, we can recover from any future incident.

Deliverables:
- Version header on every mobile request (§4.1)
- Server-side logging of version headers
- Admin dashboard query for version distribution
- Force-update gate middleware + env var (§4.2)
- UpdateRequired screen in mobile app
- Docs in `commit-process` skill explaining how to bump `MIN_APP_VERSION`

This is the **minimum viable system**. Ships as one PR through `zuludev → main`.

### Phase 2: Submission ritual (week 2)

**Goal**: the App Store review window stops being a risk.

Deliverables:
- Tag convention documented in `commit-process` skill
- CI job that detects unapproved submission tags
- Snapshot logic for contract diffing against a tag
- Manual "approve tag" mechanism (start with `gh release edit` or a label on the release in App Store Connect)

After this phase, the 2026-05-25 incident becomes impossible. Even if every other layer is broken, a backend PR that would break the in-review binary is blocked.

### Phase 3: Contract diffing in CI (week 3-4)

**Goal**: catch contract-breaking changes before they merge, even outside review windows.

Deliverables:
- Zod-to-JSON-Schema serializer for `validators/schemas.js`
- Snapshot on every main merge
- Per-PR diff job
- `breaking-change` label support + cross-reference to expand-contract issues

### Phase 4: Schema migration linter (week 4-5)

**Goal**: catch DB-level breaking changes that the contract diff wouldn't.

Deliverables:
- Migration scanner (new script in `tools/`)
- `tools/api-surface-tables.json` registry
- CI job
- Documented exception process (the `breaking-change` label workflow)

### Phase 5: Expand-contract operational discipline (ongoing)

**Goal**: every breaking change goes through expand-contract by default.

Deliverables:
- "Expand-contract" template issue type
- Pattern documented in `commit-process` skill and `AGENTS.md`
- A "currently expanding" registry — what compat shims exist and when they can be removed

This phase is mostly cultural/process. The CI gates from phases 3-4 enforce it.

---

## 6. The Expo OTA lever

This is a major lever specific to Donna's stack that big tech mostly doesn't have. Expo's over-the-air (OTA) update mechanism lets us push **JavaScript-only changes** directly to all installed binaries without going through the App Store.

What we can OTA-update:
- Bug fixes in React Native code
- Field-name translations in `apps/mobile/src/lib/api.ts`
- New screens (if no new native module is required)
- Feature flag default changes
- Most error-handling improvements

What we **cannot** OTA-update:
- Native module changes (any change to `apps/mobile/ios/` or `apps/mobile/android/`)
- New permissions in `app.config.js`
- Icon, splash, or app metadata changes
- Anything requiring a rebuild of the native binary

**Implication for our plan**: many breaking-change responses become much faster. If we discover a backend incompatibility post-deploy, we can often push an OTA update within hours that adds the missing back-compat on the client side, instead of waiting for the next App Store cycle.

**Operational note**: OTA updates carry their own version. We should add `X-Donna-OTA-Version` header alongside `X-Donna-App-Version`. Force-update floor logic might eventually distinguish "binary version" from "JS version" — but for now, treat OTA version as a sub-version of the binary, and only force-update at the binary granularity.

**Add to Phase 1**: include OTA version in the version header set. The infrastructure to react to it can come later, but capturing the data now is free.

---

## 7. Operations: day-to-day

What it actually looks like to ship features under this system.

### 7.1 Backend engineer's loop

```
Is this change additive?
├── Yes → Ship it. No ceremony required.
└── No (it removes, renames, or tightens something) →
    1. Open expand-contract issue. Link it.
    2. PR #1: expand. Label: backwards-compat-expand.
       - Modify validators to accept old + new
       - Modify route handler to normalize at the boundary
       - Modify service to use canonical (new) form only
       - Modify DB migration (add new, don't drop old)
       - Verify Pipecat parity if shared schema
    3. Ship #1. Wait for next mobile release that uses new path.
    4. After 30–90 days, check version-distribution dashboard.
    5. PR #2: contract. Label: breaking-change.
       - Reference the expand issue
       - Bump MIN_APP_VERSION if necessary
       - Remove back-compat from validators and route handler
       - Drop old DB column
       - Verify Pipecat doesn't read old column anymore
```

### 7.2 Mobile engineer's loop

```
When making API calls:
├── Use new field names by default
├── Defensively tolerate unknown response fields
├── Treat 426 responses as "force update" — don't try to handle the body
└── Treat 5xx the same way you always have
```

The mobile side is mostly unchanged. The only addition is "tolerate unknown fields" — which is good defensive practice anyway and is automatic for most modern JSON parsers.

### 7.3 App Store submission ritual

The new ritual whenever we submit a binary:

```bash
# 1. Make sure zuludev/main is in the state you want to submit
git tag mobile-1.5.0-submitted-ios
git push origin mobile-1.5.0-submitted-ios

# 2. Submit via EAS as usual
cd apps/mobile && npx eas submit --platform ios

# 3. Wait for Apple
# 4. Once approved:
gh release edit mobile-1.5.0-submitted-ios --tag mobile-1.5.0-live-ios
# (or use the App Store Connect webhook to flip a DB row)
```

Between submission and approval, the CI gate (§4.4) blocks any PR that would break what we submitted. Engineers can keep shipping unrelated work and additive changes during the review window; only breaking changes get blocked.

### 7.4 When to force-update

Force-update is for situations where back-compat isn't feasible:

- Security issues. (Bug in old binary leaks PII.)
- Vendor changes that can't be back-compat'd. (We had to swap auth providers.)
- Long-tail cleanup. (We've carried a back-compat shim for 8 months; <0.5% of traffic still uses it; time to retire it.)

Force-update is **not** for:
- Convenience. (We don't want to support the old code path anymore.)
- Engineering aesthetic. (The old code is ugly.)
- Avoiding back-compat for new features. (Do the expand-contract.)

Each force-update bump is communicated:
- In-app banner on the version below for 1-2 weeks before the bump
- Push notification (if we have a real notification system; today we have one but limited)
- Optional email/SMS to caregivers based on `seniors.consent_status` and contact preferences
- Then the bump happens — users who didn't update see the UpdateRequired screen

### 7.5 Emergency: backend ships a breaking change in error

The runbook for "I just realized the backend deploy 30 minutes ago broke the in-review binary":

1. **Revert the backend change immediately**. This is the primary play. Railway redeploys take ~3 minutes.
2. If revert isn't possible (data already migrated, etc.):
   - Add back-compat to the route handler. Hot-deploy.
   - Verify by hitting the API with the old binary's expected request shape.
3. If the in-review binary is still in review:
   - Check the CI gate. If it caught the issue, we never had this problem. If not, debug why.
4. If the in-review binary already shipped to users and is broken:
   - Push an OTA update with the client-side fix (§6).
   - This typically takes hours, not days.
5. Post-incident: write up what happened, add a regression test to the contract-diff CI.

---

## 8. Open questions and explicit non-decisions

Things we'll deliberately leave for later.

### 8.1 Senior-facing mobile app

Donna currently has a caregiver mobile app. A senior-facing app is plausibly a future product. Senior users are even less likely to update than caregivers — they're elderly, may not know how to update apps, may have grandkids do it once a year. If we ship a senior app, the version-compat windows have to be much longer (12+ months) or force-update has to be very gentle (with caregiver involvement). We'll revisit this plan when the senior app becomes real.

### 8.2 Platform divergence

iOS and Android can have different `MIN_APP_VERSION` floors. The plan accounts for this in the env vars but we haven't decided whether to use it. For now, assume the floors move together. Revisit if Android adoption diverges sharply from iOS.

### 8.3 Hot reload of MIN_APP_VERSION

Today's design uses env vars, which require a Railway redeploy to change. A future iteration moves this to a DB row or GrowthBook flag so the floor can move without a deploy. Not blocking for v1.

### 8.4 Contract testing tooling

We could use Pact, OpenAPI schema diffing, or roll our own. The Phase 3 plan is to start with Zod-to-JSON-Schema serialization, which is the smallest tool that works. If we ever ship a partner API, we'll need something heavier — but that's the trigger for revisiting, not now.

### 8.5 Server-Driven UI

Not deciding to do this. SDUI (Meta's pattern of having the server send UI structure, not just data) would solve large categories of "ship a new feature without an App Store update" problems. But it's a massive architectural change and our use cases are not screen-heavy enough to justify it. Revisit if we ever find ourselves making many UI-only changes that we wish we could ship instantly.

### 8.6 Version-aware feature flags

We have GrowthBook. The natural extension is to target flags by app version: "feature X is on for users on v1.5+, off for users on v1.4-." This is mostly free with GrowthBook's targeting rules — but we need the version header (§4.1) to be passed to GrowthBook. Phase 1 includes this if it's trivial; otherwise it lives in a follow-up.

---

## 9. Success criteria

When this plan is fully implemented, the following are true:

- **No backend deploy ever breaks an installed app version above `MIN_APP_VERSION`.** Confirmed by CI on every PR.
- **No backend deploy during App Store review breaks the in-review binary.** Confirmed by the submission tag CI gate.
- **The version-distribution dashboard is the single source of truth** for "is it safe to clean up this compat shim?"
- **Every breaking change is a tracked expand-contract issue**, not a surprise.
- **The OTA hotfix path is documented and rehearsed**, so emergencies are minutes-to-hours, not days.

If all of those are true, we can ship features continuously regardless of where Donna is in the App Store cycle, and the long tail of un-updated users gets a graceful degradation instead of broken behavior.

---

## 10. References

- Existing CLAUDE.md notes on `validators/schemas.js` (no `.transform()` for DB-bound fields)
- `apps/mobile/src/lib/api.ts` for the existing API client and error handler
- `routes/helpers.js` for the existing `routeError()` helper
- GrowthBook setup in `lib/growthbook.js` and `pipecat/lib/growthbook.py`
- EAS environment configuration in `apps/mobile/.env` and AGENTS.md mobile gotchas
- The 2026-05-25 incident (the originating motivation)
- Big-tech analogues: Meta release trains, Stripe API versioning, Discord force-update UX

---

*Last updated: 2026-05-26 — initial proposal.*
