# Donna Codex Guide

Read `DIRECTORY.md` before writing code. It is the navigation map for active vs. legacy code and the canonical "where do I edit this?" reference.

## Core Architecture

- Donna has two active backends.
- `pipecat/` owns the real-time voice pipeline, Telnyx WebSocket path, call behavior, post-call processing, and Python API routes.
- Repo-root Node/Express owns the frontend-facing `/api/*` routes, admin/consumer APIs, and the active scheduler.
- Frontends do not call Pipecat directly. `apps/admin-v2`, `apps/website`, `apps/mobile`, and `apps/observability` should be treated as Node API clients.
- Do not confuse `services/*.js` with `pipecat/services/*.py`. They are separate implementations over the same database.

## Active Surfaces

- Voice behavior, prompts, flow nodes, tools, Director, Quick Observer, and post-call logic: `pipecat/`
- Frontend APIs, auth routes, and scheduler: repo root
- Primary admin UI: `apps/admin-v2/`
- Public website and caregiver-facing web UI: `apps/website/`
- Mobile app: `apps/mobile/`
- Docs and compliance references: `docs/`

## Hard Project Rules

- Treat transcripts, reminders, medical notes, summaries, memories, and caregiver-linked senior data as PHI.
- Never introduce raw PHI into logs, test fixtures, screenshots, or debug output.
- Preserve existing auth, audit logging, encryption, token revocation, and data retention behavior unless the task explicitly changes them.
- If you change shared security/compliance behavior, inspect both Python and Node implementations for parity:
  - auth
  - audit logging
  - token revocation
  - data retention
  - encryption
- If docs and code disagree, trust runtime code first and call out the mismatch.

## Voice Pipeline Invariants

- Keep the Conversation Director non-blocking. Do not move per-turn analysis onto the critical path.
- Keep programmatic goodbye handling in the Quick Observer path. Do not reintroduce LLM-only call-ending logic.
- Preserve ephemeral context stripping. Do not let Director injections accumulate across turns.
- Remember the active scheduler assumption: the Node backend is the authoritative scheduler unless the task explicitly changes that architecture.
- Deploy Pipecat from `pipecat/`-aware commands. Do not assume repo-root Railway commands target the Python service.

## Workflow

1. Read `DIRECTORY.md`.
2. Identify the target surface before editing: `pipecat`, repo-root Node, frontend app, or docs.
3. Read only the relevant docs:
   - architecture: `docs/architecture/`
   - compliance: `docs/compliance/`
   - Pipecat debugging/latency lessons: `pipecat/docs/LEARNINGS.md`
4. Validate at the smallest useful level first.
5. Use Railway dev deploys only when the bug depends on live Telnyx, live audio, or environment wiring.

## Validation

- Full local tests: `make test`
- Pipecat tests: `make test-python`
- Regression scenarios: `make test-regression`
- Node tests: `npm test`
- Frontend E2E: `npm run test:e2e`
- App-specific E2E:
  - `npm run test:e2e:admin`
  - `npm run test:e2e:consumer`
  - `npm run test:e2e:observability`
- Pipecat dev deploy: `make deploy-dev-pipecat`
- Combined dev deploy: `make deploy-dev`

## Mobile Simulator / Maestro

- When running `apps/mobile` from a clean worktree, especially latest `origin/main`, verify `apps/mobile/.env` exists before building or launching the simulator app.
- If the clean worktree is missing that file, copy it from the primary checkout's `apps/mobile/.env` with `0600` permissions before running `expo run:ios` or Maestro.
- Only print the names of mobile env vars, never their values. The required public keys include `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`.
- Do not treat a failed mobile login as an app regression until the rebuilt simulator bundle is confirmed to include the mobile env.
- `expo-dev-client` must be installed for EAS development simulator builds. If EAS says it is missing, run `cd apps/mobile && npx expo install expo-dev-client`, then regenerate the lockfile with `npx --yes npm@10.9.3 install --package-lock-only --include=dev`.
- EAS runs `npm ci --include=dev`. Before starting a simulator build, verify the lockfile with `cd apps/mobile && npx --yes npm@10.9.3 ci --include=dev`; if this fails, fix `package-lock.json` before building.
- EAS `development`, `preview`, and `production` environments must all define `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. Verify without printing values:
  `for env in development preview production; do echo "== $env =="; npx eas env:exec "$env" 'node -e "const c=require(\"./app.config.js\")(); const e=c.extra||{}; const ok=Boolean(e.apiUrl)&&Boolean(e.clerkPublishableKey)&&e.apiUrl.startsWith(\"https://\")&&/^pk_(test|live)_/.test(e.clerkPublishableKey); console.log({apiUrlPresent:Boolean(e.apiUrl),clerkKeyPresent:Boolean(e.clerkPublishableKey),ok}); process.exit(ok?0:1)"'; done`
- If `development` or `preview` is missing `EXPO_PUBLIC_API_URL`, set it from local `apps/mobile/.env` without printing the value:
  `API_URL=$(node -e 'const fs=require("fs"); const line=fs.readFileSync(".env","utf8").split(/\n/).find(l=>l.startsWith("EXPO_PUBLIC_API_URL=")); if(!line) process.exit(1); process.stdout.write(line.split("=").slice(1).join("=").trim())') && for env in development preview; do npx eas env:create "$env" --name EXPO_PUBLIC_API_URL --value "$API_URL" --visibility plaintext --force --non-interactive; done`
- For Apple sign-in, verify the installed simulator app's signed entitlements include `com.apple.developer.applesignin`; a stale dev-client binary can load fresh JS but still fail native Apple auth.
- Local simulator rebuilds with the Apple sign-in entitlement may require Apple Development code signing. If local signing is unavailable, use a fresh EAS simulator build: `cd apps/mobile && npx eas build:dev --platform ios --profile development`, then install it with `npx eas build:run --platform ios --id <build-id>`.
- If EAS fails in `INSTALL_DEPENDENCIES`, inspect the first real npm error with `npx eas build:view <build-id> --json`; the usual cause is `package.json` and `package-lock.json` being out of sync for `npm ci`.
- Maestro mobile flows should exercise human-visible input paths. For iOS `phone-pad` and `number-pad` fields, focus the field and tap the visible keypad digits using `.maestro/subflows/tap_digits.yaml`; do not use `inputText` for those fields.
- Maestro form tests must use values that differ from placeholders and assert those values are visible before tapping the next CTA. A visible placeholder is not evidence that input succeeded.
- Do not dismiss the keyboard by tapping random headings or empty screen space just to reach a CTA. If `Next`, `Continue`, or `Create Profile` is not clearly tappable while the keyboard is open, fix the UI/footer behavior and make the flow tap the visible CTA directly.

## Canonical Edit Paths

- Change Donna's voice behavior: `pipecat/prompts.py`, `pipecat/flows/nodes.py`, `pipecat/flows/tools.py`
- Change Quick Observer: `pipecat/processors/patterns.py`, `pipecat/processors/quick_observer.py`
- Change Director behavior: `pipecat/processors/conversation_director.py`, `pipecat/services/director_llm.py`
- Change post-call behavior: `pipecat/services/post_call.py`
- Change semantic memory or prefetch: `pipecat/services/memory.py`, `pipecat/services/prefetch.py`
- Change Telnyx webhook/outbound path: `pipecat/api/routes/telnyx.py`, `pipecat/api/routes/call_context.py`
- Change frontend/manual call initiation: `routes/calls.js` (Node asks Pipecat to create a Telnyx call)
- Change frontend APIs: `routes/*.js`, `middleware/*.js`, `validators/schemas.js`
- Change admin UI: `apps/admin-v2/src/`
- Change public website or caregiver web UI: `apps/website/src/`
- Change mobile UI: `apps/mobile/`

## Repo-Local Skills

Donna-specific Codex skills live under `.codex/skills/`.
Claude-facing mirrors live under `.claude/skills/` where present.

- `accessibility-audit`
- `privacy-audit`
- `senior-ux-review`
- `donna-pipecat-debug`
- `mock-call-test-creator`
- `commit-process`

Use them when the task is explicitly an audit/review, a Pipecat debugging investigation, adding mock-call coverage for voice features, or when committing/pushing/PR-ing changes intended for `main`.

## Commit & PR Workflow

`main` is GitHub-protected (2 required status checks; direct push rejected with `GH013`). Every change reaches `main` via a PR from a developer's personal integration branch.

- **Per-developer integration branch**, pattern `<lowercase-first-name>dev`: `zuludev` (David), `facudev` (Facu). Identify which one is yours via `git config user.name` and the local branch list.
- **Flow**: commit on `<name>dev` → push `<name>dev` → PR from `<name>dev` → `main`. Never commit on `main` directly; never `git push origin main`.
- **Stage explicitly** (no `git add -A`). Don't bundle unrelated modifications.
- **PR creation is visible to others** — confirm with the user before running `gh pr create` unless they pre-authorized it in this session.
- **Existing PR from `<name>dev`?** New commits appear automatically once pushed. Don't open a second PR.
- See `.codex/skills/commit-process/SKILL.md` for the full procedure including guardrails, edge cases, and the `git log`-style commit subject convention.
