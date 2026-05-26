# Mobile Version Compatibility Plan

Date: May 26, 2026
Status: Proposal — not yet committed work
Primary surfaces: `apps/mobile/src/lib/api.ts`, `apps/mobile/app.config.js`, `apps/mobile/eas.json`, `middleware/`, `validators/schemas.js`, `routes/helpers.js`, `db/migrations/`, EAS submission flow, CI

## Why this exists

On 2026-05-25 we shipped a mobile binary to the App Store. While Apple held it for review, we changed the backend schema and API contract. When Apple completed review, the just-approved binary hit a backend that no longer matched what it expected and the app failed.

That's not a one-off incident. It's the inevitable result of the operating constraint we'll live with for the life of the product:

- A backend deploy takes minutes.
- An App Store review takes 1–7 days.
- A mobile binary lives on users' phones for **months or years** after release.

So at any moment, the backend is talking to multiple concurrent app versions, and that condition is permanent. We need a system that lets us ship backend changes continuously without breaking either the in-review binary or the long tail of users who haven't updated.

This document is the plan for that system. The principles are independent of any specific change; the implementation phases are concrete deliverables.

### Current repo reality

As of this plan date, Donna has the pieces to build this system, but not the system itself:

- Mobile API calls already centralize through `apps/mobile/src/lib/api.ts`, so request headers and global `426` handling have one obvious insertion point.
- EAS is configured with `cli.appVersionSource = "remote"` and production `autoIncrement`, so the server-side compatibility identity must record both the user-facing app version and the developer-facing build number from the installed native binary.
- `expo-updates` is installed, but iOS currently has `EXUpdatesEnabled = false` and the app config does not yet define `runtimeVersion` or `updates.url`. OTA is a planned lever, not an available incident-response path until we configure it, ship a compatible binary, and rehearse an update/rollback.
- There is no `api_logs` table today. Version distribution needs an explicit PHI-safe aggregate table or analytics path; we should not infer this from raw request logs.

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
| OTA hotfix capability | EAS Update for JS-only fixes after Expo Updates is configured and drilled (see §6) |

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
X-Donna-Runtime-Version: 1.5.0
X-Donna-Update-Id: 9a6f...
X-Donna-Update-Channel: production
X-Donna-Embedded-Update: false
```

`X-Donna-App-Version` and `X-Donna-Build` come from the installed native binary, not from `Constants.expoConfig`, because OTA manifests can change config values while the native binary stays the same. Use `expo-application` (`nativeApplicationVersion`, `nativeBuildVersion`) for those values. The OTA/runtime headers come from `expo-updates` when enabled and are omitted or sent as `unknown` while updates are disabled.

Server middleware validates and normalizes these headers, attaches the result to request context, and records PHI-safe aggregates. Do **not** write raw request paths, bodies, auth headers, IP addresses, senior IDs, caregiver IDs, or free-form user agents into the compatibility table.

Suggested aggregate:

```
mobile_api_version_daily
  day date
  route_template text          -- e.g. GET /api/reminders, not /api/seniors/:uuid
  platform text                -- ios/android/unknown
  app_version text             -- native app version
  build text                   -- native build number
  runtime_version text         -- EAS Update runtime, if enabled
  update_id text               -- EAS Update UUID, if enabled
  update_channel text
  status_class text            -- 2xx/4xx/5xx
  request_count bigint
```

We add a single admin dashboard view:

- **Daily active version distribution** (rolling 30 days). What percent of requests come from each version.
- **Per-endpoint version share**. Are some endpoints disproportionately used by older versions?
- **Anomaly alerts**. Alert if traffic on a version we thought was dead suddenly spikes (could indicate a regression on a newer version pushing users back).

This is the foundation. Every decision below depends on this data being available and accurate.

**Implementation**:
- `apps/mobile/src/lib/api.ts` — add headers to every request in the central `fetchJson` helper
- `apps/mobile` — add `expo-application` for native version/build identity
- `middleware/version-tracking.js` (new) — reads headers, validates safe values, attaches `req.clientVersion`
- `db/migrations/` — add the PHI-safe aggregate table above
- Admin dashboard query — aggregate from `mobile_api_version_daily`, never raw request logs

**Effort**: ~1 day for mobile headers + middleware + aggregate write path; dashboard polish can follow.

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

**Important rollout rule**: do not activate a `426` floor for normal cleanup until a released binary that handles `426` gracefully is live and adopted. The binaries shipped before this plan do not have the UpdateRequired screen or special `426` handling; they would show a generic API error. Phase 1 therefore ships the client capability and passive server instrumentation first. The gate defaults inactive, and activation is a later operations step.

For v1, missing version headers are tracked as `unknown` and are not blocked unless we explicitly choose an emergency security force-update. That emergency path is allowed, but it will not be graceful for pre-capability binaries.

**Bump policy**: bump `MIN_APP_VERSION` only when version-distribution data (§4.1) says it's safe. Default threshold: <1% of last-30d traffic on versions about to be cut off, plus a confirmed support path for anyone blocked. Treat each bump like a migration — runbook, communication plan, ramp.

**Implementation**:
- Env var or DB row for current floor
- `middleware/version-gate.js` (new)
- `apps/mobile/app/update-required.tsx` or equivalent Expo Router screen (new)
- Hook into existing error handler in `apps/mobile/src/lib/api.ts` (`getErrorMessage()` already centralizes error display)
- Unit test that pre-capability/missing-version requests are observed but not blocked while the floor is inactive

**Effort**: ~1 day for the inactive capability. Activation is a separate runbook step after a compatible binary is live.

### 4.3 Contract pattern: field-level expand-contract

For each breaking change, the engineer writes both PRs upfront, even though they're separated by weeks or months.

**Phase 1: Expand** (ships immediately)
- **Validator**: accept both old and new field names. Zod schema uses `.or()` or accepts a union; do not add `.transform()` for DB-bound fields per CLAUDE.md.
- **Route handler**: normalize at the top to canonical form. `const x = body.newName ?? body.oldName`.
- **Service layer**: only knows canonical (new) form. No back-compat here.
- **DB**: add the new canonical column nullable while keeping the old column until the contract phase.
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

### 4.4 Submission ritual: record-and-freeze

When we submit a binary to the App Store:

1. Record the submitted build identity:
   - platform (`ios`)
   - app version (`1.5.0`)
   - native build number (`153`)
   - EAS build ID
   - git SHA
   - runtime version
   - update channel
   - API environment/base URL used by the binary
2. Tag the submitted commit with version + build: `git tag mobile-ios-1.5.0-b153-submitted`
3. CI snapshots the API contract (request schemas + sample responses) and stores it keyed by the submitted build identity, not just the app version.
4. Until the submission is marked `approved` (manual or via App Store Connect API), CI runs every backend PR against the submitted build contract as a baseline.
5. Any PR that breaks the contract is blocked from merging until the submission is approved.
6. Once approved, the submission transitions to `live`.

Approval only ends the special "Apple reviewer is the first user" risk. It does **not** make it safe to break N-1 or any older live binary. Breaking changes still wait for adoption data or an explicit `MIN_APP_VERSION` bump.

This is the missing piece from our 2026-05-25 incident. The freeze is not a calendar rule someone has to remember; it is enforced by CI.

**Implementation**:
- Tag and release-record conventions documented in `AGENTS.md` or a real repo-local release skill
- New CI job `contract-freeze-check` that:
  - Lists submitted-but-not-approved mobile release records
  - For each, diffs the current branch's request/response contract against the submitted build snapshot
  - Fails if there's a breaking change
- Admin endpoint, checked-in release record, or GitHub release metadata step to mark a submission as approved/live
- This replaces "developer remembers not to break things during review"

**Effort**: ~1-2 days, separate PR.

### 4.5 CI gates: catch breaking changes before merge

Three checks that fail PRs without explicit acknowledgment.

**API contract diff**:
- On every PR, serialize request Zod schemas in `validators/schemas.js` to JSON Schema
- Capture response contracts for the mobile-facing endpoints used by `apps/mobile/src/lib/api.ts`
- Compare both request and response contracts to main and to any submitted-but-not-approved build snapshot
- Any removed response field, removed accepted request field, tightened constraint, or changed type fails the build
- Override: PR must have label `breaking-change` AND link to an expand-contract tracking issue
- The `breaking-change` label triggers a second check: "is the corresponding expand PR already merged?" — prevents shipping a contract before the back-compat for it exists.

Request validators alone are not enough. The 2026-05-25 class of failure can come from responses too: a route can keep accepting the old request shape while returning a new body shape the installed app cannot render. Start with generated PHI-free response fixtures from integration tests for:

- `GET /api/caregivers/me`
- `PATCH /api/caregivers/me`
- `POST /api/onboarding/validate-phone`
- `POST /api/onboarding`
- `GET/PATCH /api/seniors/:id`
- `GET/PATCH /api/seniors/:id/schedule`
- `GET/POST/PATCH/DELETE /api/reminders`
- `GET /api/conversations`
- `POST /api/call`
- `GET /api/notifications/preferences`
- `PATCH /api/notifications/preferences`
- `GET /api/notifications`
- `PATCH /api/notifications/:id/read`
- `POST /api/caregivers/me/push-token`

**Schema migration linter**:
- Scan new files in `db/migrations/` and `pipecat/db/migrations/`
- Flag `DROP COLUMN`, `ALTER ... TYPE`, `RENAME COLUMN`, `ALTER ... NOT NULL` (without DEFAULT)
- Cross-reference against a hand-maintained list of "API-surface tables" in `tools/api-surface-tables.json` — tables whose columns appear in mobile API responses
- If the table is on the list, require `breaking-change` label

**Submission release freeze** (described in §4.4):
- Runs on every PR
- Active only when an unapproved submission record exists
- Fails any PR that breaks the submitted build contract

**Effort**: ~2-3 days total, separate PR or sequence of PRs.

---

## 5. Implementation phases

We don't ship everything at once. The order is calibrated so each phase makes the next safer.

### Phase 1A: Compatibility-capable binary + passive instrumentation (week 1)

**Goal**: ship a mobile binary and backend path that can identify itself, understand future force-update responses, and feed version-distribution data without blocking anyone yet.

Deliverables:
- Native app version/build headers on every mobile request (§4.1)
- OTA/runtime headers where available, with `unknown` fallback while Expo Updates is disabled
- Server-side version-tracking middleware
- PHI-safe `mobile_api_version_daily` aggregate table and write path
- Force-update gate middleware present but inactive by default (§4.2)
- UpdateRequired screen in mobile app
- EAS Update configuration decision captured (`runtimeVersion`, `updates.url`, channels) if we want OTA available for future incidents

This is the **minimum viable compatibility capability**. It ships as one PR through `zuludev → main`, then as an App Store binary. It does not by itself make it safe to bump `MIN_APP_VERSION`.

### Phase 1B: Dashboard + controlled force-update activation (after Phase 1A binary is live)

**Goal**: make version data visible and establish the first safe floor-setting runbook.

Deliverables:
- Admin dashboard query for version distribution
- Alert for unexpected old-version spikes
- 426 handling verified on an installed TestFlight/App Store binary
- Force-update bump runbook documented in `AGENTS.md` or a real repo-local release skill
- Policy: no normal `MIN_APP_VERSION` bump until the compatibility-capable binary has meaningful adoption and the affected older versions are below the cutoff threshold

After this phase, force-update is available as a graceful safety valve for binaries that know how to handle it. Pre-capability binaries can only be force-updated as an explicit emergency with degraded UX.

### Phase 2: Submission ritual (week 2)

**Goal**: the App Store review window stops being a risk.

Deliverables:
- Tag/release-record convention documented in `AGENTS.md` or a real repo-local release skill
- CI job that detects unapproved submission records
- Snapshot logic for request + response contract diffing against a submitted build
- Manual "approve release record" mechanism (checked-in record, GitHub release metadata, or a small admin tool)

After this phase, the 2026-05-25 incident class is blocked by CI for covered endpoints. If a backend PR would break the in-review binary's known contract, it cannot merge without an explicit expand-contract path.

### Phase 3: Contract diffing in CI (week 3-4)

**Goal**: catch contract-breaking changes before they merge, even outside review windows.

Deliverables:
- Zod-to-JSON-Schema serializer for `validators/schemas.js`
- Response-contract fixture generator for mobile-facing endpoints
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
- Pattern documented in `AGENTS.md` or a real repo-local release skill
- A "currently expanding" registry — what compat shims exist and when they can be removed

This phase is mostly cultural/process. The CI gates from phases 3-4 enforce it.

---

## 6. The Expo OTA lever

This is a major lever specific to Donna's stack, but it is not available just because the package is installed. Expo's over-the-air (OTA) update mechanism lets us push **JavaScript-only changes** directly to compatible installed binaries without going through the App Store, but only after the native app is configured with Expo Updates and a matching runtime version.

Current state: `expo-updates` is installed, but iOS has `EXUpdatesEnabled = false`, and `apps/mobile/app.config.js` / `apps/mobile/app.json` do not yet define `runtimeVersion` or `updates.url`. The next production binary must configure and verify this before we count OTA as an incident-response tool.

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
- Any JS bundle whose runtime version does not match the installed binary's native runtime

**Implication for our plan**: many breaking-change responses become much faster after the OTA-capable binary is live. If we discover a backend incompatibility post-deploy, we can often push an OTA update within hours that adds the missing back-compat on the client side, instead of waiting for the next App Store cycle. For binaries where Expo Updates is disabled, the primary play remains backend revert or server-side back-compat.

**Required setup before relying on OTA**:
- Run and review the equivalent of `eas update:configure` for this project.
- Choose a runtime-version policy. Default recommendation: `fingerprint` if we want the safest native/JS compatibility boundary; `appVersion` only if we are disciplined about bumping app version whenever native runtime changes.
- Add production/preview update channels in `apps/mobile/eas.json`.
- Confirm the generated iOS config has `EXUpdatesEnabled = true`, `EXUpdatesRuntimeVersion`, and `EXUpdatesURL`.
- Ship a new production/TestFlight binary with that config.
- Publish a no-op update, verify the installed app picks it up, and verify request headers include update ID/runtime/channel.
- Rehearse rollback before treating OTA as a production recovery path.

**Operational note**: OTA updates carry their own identity. Add `X-Donna-Update-Id`, `X-Donna-Runtime-Version`, `X-Donna-Update-Channel`, and `X-Donna-Embedded-Update` headers alongside `X-Donna-App-Version`. Force-update floor logic might eventually distinguish "binary version" from "JS update identity" — but for now, treat OTA as a sub-version of the binary, and only force-update at the binary granularity.

**Add to Phase 1A**: include OTA/runtime headers now, even if they are `unknown` until Expo Updates is enabled. The infrastructure to react to them can come later, but capturing the data now is cheap.

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
├── Treat 426 responses as "force update" — navigate to UpdateRequired using the response body
└── Treat 5xx the same way you always have
```

The mobile side is mostly unchanged. The additions are:

- Send native app/build identity from `expo-application`, not manifest config values that OTA can change.
- Tolerate unknown fields, which is good defensive practice anyway and is automatic for most modern JSON parsers.
- Preserve graceful `426` handling in every future binary, even if the force-update gate is inactive at the time.

### 7.3 App Store submission ritual

The new ritual whenever we submit a binary:

```bash
# 1. Make sure zuludev/main is in the state you want to submit
cd apps/mobile
npx eas build:list --platform ios --limit 5 --non-interactive

# 2. Record the exact submitted build identity:
#    app version, build number, EAS build ID, git SHA, runtime version,
#    update channel, and API environment/base URL.

# 3. Tag the submitted commit with version + build.
git tag mobile-ios-1.5.0-b153-submitted <submitted-git-sha>
git push origin mobile-ios-1.5.0-b153-submitted

# 4. Submit the exact EAS build ID.
npx eas submit --platform ios --id <eas-build-id>

# 5. Wait for Apple.
# 6. Once approved, mark the release record approved/live.
#    This can be a checked-in record, GitHub release metadata, or a small admin tool.
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
- In-app banner on the version below for 1-2 weeks before the bump, if that version has the compatibility-capable binary
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
   - If the binary has Expo Updates enabled and the fix is JS-only, push an OTA update with the client-side fix (§6).
   - If OTA is unavailable or the fix needs native code, keep the backend compat shim and prepare a new App Store/TestFlight build.
5. Post-incident: write up what happened, add a regression test to the contract-diff CI.

---

## 8. Open questions and explicit non-decisions

Things we'll deliberately leave for later.

### 8.1 Senior-facing mobile app

Donna currently has a caregiver mobile app. A senior-facing app is plausibly a future product. Senior users are even less likely to update than caregivers — they're elderly, may not know how to update apps, may have grandkids do it once a year. If we ship a senior app, the version-compat windows have to be much longer (12+ months) or force-update has to be very gentle (with caregiver involvement). We'll revisit this plan when the senior app becomes real.

### 8.2 Platform divergence

iOS and Android can have different `MIN_APP_VERSION` floors. The plan accounts for this in the env vars but we haven't decided whether to use it. For now, assume the floors move together. Revisit if Android adoption diverges sharply from iOS.

### 8.3 Hot reload of MIN_APP_VERSION

Today's design can start with env vars, which require a Railway redeploy to change. A future iteration should move this to a small DB-backed config row so the floor can move without a deploy and without depending on GrowthBook availability. Not blocking for v1.

### 8.4 Contract testing tooling

We could use Pact, OpenAPI schema diffing, or roll our own. The Phase 3 plan is to start with Zod-to-JSON-Schema for requests plus generated PHI-free response fixtures for the mobile endpoint set. If we ever ship a partner API, we'll need something heavier — but that's the trigger for revisiting, not now.

### 8.5 Server-Driven UI

Not deciding to do this. SDUI (Meta's pattern of having the server send UI structure, not just data) would solve large categories of "ship a new feature without an App Store update" problems. But it's a massive architectural change and our use cases are not screen-heavy enough to justify it. Revisit if we ever find ourselves making many UI-only changes that we wish we could ship instantly.

### 8.6 Version-aware feature flags

We have GrowthBook. The natural extension is to target flags by app version: "feature X is on for users on v1.5+, off for users on v1.4-." This is mostly free with GrowthBook's targeting rules — but we need the version header (§4.1) to be passed to GrowthBook. Phase 1A includes this if it's trivial; otherwise it lives in a follow-up.

### 8.7 EAS Update runtime policy

We need to choose the runtime-version policy before enabling OTA in production. `fingerprint` is safer because native-impacting changes automatically split runtime compatibility, but it may reduce the set of binaries that can receive the same OTA update. `appVersion` is simpler, but it relies on release discipline: every native runtime change must bump the app version before updates are published. Default recommendation: use `fingerprint` unless we find it too restrictive in a rehearsal.

---

## 9. Success criteria

When this plan is fully implemented, the following are true:

- **No backend deploy breaks the covered mobile API contract for an installed app version above `MIN_APP_VERSION`.** Confirmed by CI on every PR.
- **No backend deploy during App Store review breaks the in-review binary's covered API contract.** Confirmed by the submission release CI gate.
- **The version-distribution dashboard is the single source of truth** for "is it safe to clean up this compat shim?"
- **Every breaking change is a tracked expand-contract issue**, not a surprise.
- **Release records identify exact submitted builds**, including app version, native build, EAS build ID, git SHA, runtime version, update channel, and API environment.
- **The OTA hotfix path is configured, documented, and rehearsed**, so JS-only emergencies are minutes-to-hours for compatible binaries, not days.

If all of those are true, we can ship features continuously regardless of where Donna is in the App Store cycle, and the long tail of un-updated users gets a graceful degradation instead of broken behavior.

---

## 10. References

- Existing CLAUDE.md notes on `validators/schemas.js` (no `.transform()` for DB-bound fields)
- `apps/mobile/src/lib/api.ts` for the existing API client and error handler
- `routes/helpers.js` for the existing `routeError()` helper
- GrowthBook setup in `lib/growthbook.js` and `pipecat/lib/growthbook.py`
- EAS environment configuration in `apps/mobile/.env` and AGENTS.md mobile gotchas
- Expo app version docs: https://docs.expo.dev/build-reference/app-versions/
- Expo runtime version docs: https://docs.expo.dev/eas-update/runtime-versions/
- Expo EAS Update setup docs: https://docs.expo.dev/eas-update/getting-started/
- The 2026-05-25 incident (the originating motivation)
- Big-tech analogues: Meta release trains, Stripe API versioning, Discord force-update UX

---

*Last updated: 2026-05-26 — initial proposal.*
