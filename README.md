# Donna

Donna is an AI companion for older adults. Seniors talk to Donna by phone through the Pipecat voice pipeline, while caregivers and operators use the web, mobile, and admin apps through the Node API.

## Start Here

- Codebase map and edit paths: [`DIRECTORY.md`](DIRECTORY.md)
- Documentation index: [`docs/README.md`](docs/README.md)
- System architecture: [`docs/architecture/OVERVIEW.md`](docs/architecture/OVERVIEW.md)
- Pipecat voice architecture: [`pipecat/docs/ARCHITECTURE.md`](pipecat/docs/ARCHITECTURE.md)
- Feature backlog: [`docs/FEATURE_BACKLOG.md`](docs/FEATURE_BACKLOG.md)
- Current pilot backlog: [`docs/plans/PROTOTYPE_PILOT_BACKLOG.md`](docs/plans/PROTOTYPE_PILOT_BACKLOG.md)
- Current remediation plan: [`docs/plans/2026-05-05-engineering-remediation-plan.md`](docs/plans/2026-05-05-engineering-remediation-plan.md)

## Active Architecture

Donna has two active backends sharing one Neon PostgreSQL database:

| Surface | Owns | Primary path |
|---|---|---|
| Pipecat Python service | Telnyx webhooks, WebSocket voice pipeline, STT/LLM/TTS, call flow, post-call processing | `pipecat/` |
| Node/Express service | Frontend APIs, caregiver/admin auth routes, reminder scheduler, manual call initiation | repo root `routes/`, `services/`, `middleware/` |

All frontends call the Node API. Frontends do not call Pipecat directly. For voice calls, Node authorizes the frontend request and asks Pipecat to create or end Telnyx calls.

Active frontend surfaces:

- Admin dashboard: `apps/admin-v2/`
- Public website and caregiver web app: `apps/website/`
- Mobile caregiver app: `apps/mobile/`
- Observability dashboard: `apps/observability/`

## Local Setup

```bash
npm ci
npm run install:apps
cd pipecat && uv sync && cd ..
cp apps/mobile/.env.example apps/mobile/.env
```

Set `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in `apps/mobile/.env` before running the mobile app. Print only variable names or presence checks, never values.

## Validation

```bash
make test                    # Python + Node
make test-python             # Pipecat
make test-regression         # Regression scenarios
npm test                     # Node
npm run test:e2e             # Browser E2E
```

Mobile checks:

```bash
cd apps/mobile
npm run test:unit
npm run test:auth-guard
npm run verify:assets
npx tsc --noEmit
```

## Development Notes

- Voice and live call behavior should be validated through Railway dev and the current dev Telnyx number, using only dummy or consenting test phones.
- Local frontend work should use configured dev/mock APIs and must not silently fall back to production Railway APIs.
- Treat transcripts, reminders, medical notes, summaries, memories, and caregiver-linked senior data as PHI. Do not put real PHI in logs, fixtures, screenshots, or docs.
- Production boot is intentionally fail-closed. Node and Pipecat require safe production secrets and labeled `DONNA_API_KEYS`; legacy `DONNA_API_KEY` is local/test compatibility only.

## Deployment

```bash
make deploy-dev
make deploy-dev-pipecat
make deploy-staging
make deploy-prod
```

Frontend deploys:

```bash
cd apps/admin-v2 && npx vercel --prod --yes
cd apps/website && npx vercel --prod --yes
```

## Historical Material

Archived plans live in [`docs/plans/archive/`](docs/plans/archive/). They are kept for context and may describe superseded Twilio voice/SMS paths, older model choices, or old media assumptions. Use the docs linked above as the current source of truth.

## License

Private - All rights reserved
