# Donna — Developer Onboarding Guide

Welcome to Donna! This guide gets you from zero to deploying and testing voice calls.

---

## 1. Machine Setup

Install these in order.

### iTerm2

Download from https://iterm2.com or install via the default Terminal:

```bash
brew install --cask iterm2
```

**Open iTerm2 and use it for everything below.**

### Xcode (from App Store)

Install Xcode from the Mac App Store (~10 GB) — this includes the iPhone Simulator for mobile development. Start this early, it takes a while. After it finishes:

```bash
sudo xcodebuild -license accept
xcode-select --install
```

### Homebrew

If you don't have Homebrew yet:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### CLI Tools & Apps

```bash
# CLI tools
brew install tmux gh jq railway neonctl pyenv uv fnm cocoapods watchman

```

### Node.js (via fnm)

```bash
fnm install --lts
fnm use lts-latest
```

Add to your shell profile (`~/.zshrc`):

```bash
eval "$(fnm env --use-on-cd)"
```

### Python 3.12 (via pyenv)

```bash
pyenv install 3.12
pyenv global 3.12
```

Add to your shell profile (`~/.zshrc`):

```bash
eval "$(pyenv init -)"
```

### Global npm Packages

```bash
npm install -g eas-cli
```

---

## 2. Access & Accounts

Ask David to invite you to each of these:

| Platform | What it's for | URL |
|----------|--------------|-----|
| **GitHub** | Code, PRs, CI/CD | github.com |
| **Railway** | Hosting (Pipecat + Node.js API) | railway.app |
| **Neon** | PostgreSQL database | console.neon.tech |
| **Vercel** | Frontend deploys (admin, website/caregiver web, observability) | vercel.com |
| **GrowthBook** | Feature flags | app.growthbook.io |
| **Sentry** | Error monitoring | sentry.io |
| **Telnyx** | Voice calls, phone numbers, media streaming | portal.telnyx.com |
| **Clerk** | Caregiver auth for website and mobile | clerk.com |

After you have access:

```bash
# Log in to CLIs
gh auth login
railway login
```

---

## 3. Clone & Verify

```bash
gh repo clone <org>/donna2
cd donna2

# Install dependencies
npm ci
npm run install:apps
cd pipecat && uv sync && cd ..

# Mobile app env (required before running Expo)
cp apps/mobile/.env.example apps/mobile/.env
# Edit apps/mobile/.env and set EXPO_PUBLIC_API_URL + EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY

# Run tests to verify setup
make test

# Install Playwright browsers (for E2E tests)
npx playwright install chromium
```

The frontend apps use their own `package-lock.json` files, so root `npm ci` is not enough by itself. `npm run install:apps` installs the app-local dependencies that Playwright and Expo expect.

---

## 4. Project Architecture (The 2-Minute Version)

Donna makes friendly phone calls to elderly people. Two backends work together:

| Backend | Language | Port | Responsibility |
|---------|----------|------|----------------|
| **Pipecat** | Python | 7860 | Voice pipeline: microphone audio in → speech-to-text → AI conversation → text-to-speech → audio out |
| **Node.js API** | JavaScript | 3001 | REST APIs for admin, website, and mobile clients; reminder scheduler; call initiation |

Both share the same PostgreSQL database (Neon).

**Key insight:** The voice call pipeline runs entirely in Python (Pipecat). Node.js handles everything that isn't real-time voice.

### Frontend Apps

| App | Directory | URL |
|-----|-----------|-----|
| Admin Dashboard | `apps/admin-v2/` | admin-v2-liart.vercel.app |
| Website/caregiver web | `apps/website/` | calldonna.co |
| Observability | `apps/observability/` | — |
| Mobile (iOS/Android) | `apps/mobile/` | — |

### Mobile Setup And Onboarding Validation

The mobile app is an Expo/React Native app with a checked-in native `ios/` project. It talks to Clerk and the repo-root Node API, never directly to Pipecat.

Before running Expo or Maestro from a clean worktree:

```bash
cd apps/mobile
test -f .env
node -e 'const fs=require("fs"); const text=fs.readFileSync(".env","utf8"); for (const k of ["EXPO_PUBLIC_API_URL","EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"]) { console.log(`${k}: ${new RegExp(`^${k}=.+`, "m").test(text) ? "present" : "missing"}`); }'
```

For EAS builds, verify all build environments without printing values:

```bash
for env in development preview production; do
  echo "== $env =="
  npx eas env:exec "$env" 'node -e "const c=require(\"./app.config.js\")(); const e=c.extra||{}; const ok=Boolean(e.apiUrl)&&Boolean(e.clerkPublishableKey)&&e.apiUrl.startsWith(\"https://\")&&/^pk_(test|live)_/.test(e.clerkPublishableKey); console.log({apiUrlPresent:Boolean(e.apiUrl),clerkKeyPresent:Boolean(e.clerkPublishableKey),ok}); process.exit(ok?0:1)"'
done
```

Fresh onboarding tests must create a Clerk account through the visible Create Account screen. Do not sign in with a no-profile user to start onboarding; the app now treats that as an incomplete account and cleans it up. Useful checks:

```bash
npm --prefix apps/mobile run test:unit
npm --prefix apps/mobile run test:auth-guard
npm --prefix apps/mobile run test:e2e:onboarding
(cd apps/mobile && maestro test .maestro/flows/12_incomplete_account_cleanup.yaml)
(cd apps/mobile && maestro test .maestro/flows/13_leave_setup_cleanup.yaml)
```

---

## 5. Read These First

Before writing any code, read these two files:

1. **[`claude.md`](../claude.md)** — Full project context, architecture, every feature, environment variables, deployment workflow
2. **[`DIRECTORY.md`](../DIRECTORY.md)** — What each directory does and which file to open for any task

These are the source of truth. They're also what AI assistants read to understand the project.

Other useful docs:
- `pipecat/docs/ARCHITECTURE.md` — Pipeline deep-dive with diagrams
- `pipecat/docs/LEARNINGS.md` — Hard-won engineering lessons from production
- `docs/architecture/` — Architecture, security, scalability, cost, testing docs
- `docs/compliance/` — HIPAA compliance documentation

---

## 6. Three Environments

| Environment | Purpose | How to deploy | Phone # for testing |
|-------------|---------|---------------|---------------------|
| **dev** | Your experiments | `make deploy-dev` | Shared dev Telnyx number; confirm current value in Railway/Telnyx before calling |
| **staging** | Pre-merge CI | Automatic on PR | Do not assume the dev number; coordinate before staging voice tests |
| **production** | Live customers | Automatic on merge to `main` | +18064508649 (DO NOT test here) |

Each has its own database (Neon branch) and Railway services. Dev is your playground — you can't break production from dev.

---

## 7. Daily Development Workflow

```bash
# 1. Create a feature branch
git checkout -b feat/your-feature

# 2. Make your changes

# 3. Deploy to dev
make deploy-dev-pipecat      # Voice pipeline changes (~30s)
make deploy-dev              # Both Pipecat + Node.js API (~60s)

# 4. Test with a real call
#    Call the current dev Telnyx number from an approved dummy/consenting test phone.

# 5. Check logs
make logs-dev                # Voice/call pipeline logs
railway logs --service donna-api --environment dev   # API logs

# 6. Iterate: edit → deploy → call → check logs → repeat

# 7. Push and open a PR
git push -u origin feat/your-feature
gh pr create
```

### Common Makefile Commands

```bash
# Deploy
make deploy-dev              # Both services to dev
make deploy-dev-pipecat      # Just Pipecat (fastest for voice changes)
make deploy-prod             # Both services to production

# Health checks
make health-dev
make health-prod

# Logs
make logs-dev                # Pipecat logs (voice/calls)
make logs-prod

# Tests
make test                    # All tests
make test-python             # Pipecat only
make test-node               # Node.js only
npm run test:e2e             # Frontend E2E (Playwright)
```

---

## 8. Important Gotchas

**Railway CLI defaults to the Node.js API service.** If you're debugging voice/call issues, you MUST specify the Pipecat service:

```bash
# WRONG — shows API request logs, not voice logs
railway logs

# RIGHT — shows voice pipeline logs
make logs-dev
# or
railway logs --service donna-pipecat --environment dev
```

**Don't test voice locally with ngrok.** Always deploy to Railway dev environment and test with real phone calls.

**Donna currently uses one shared secret set across dev, staging, and production.** You don't need your own Anthropic, Deepgram, ElevenLabs, Cartesia, Groq, Google, OpenAI, or Telnyx keys for normal dev work when Railway injects the configured environment values. SMS is inactive for now. Production-like environments must have `DONNA_API_KEYS`, `FIELD_ENCRYPTION_KEY`, `JWT_SECRET`, `CLERK_SECRET_KEY`, `PIPECAT_PUBLIC_URL`, and Telnyx voice credentials set so Pipecat can fail closed. Treat dev/staging Railway variable or runtime-log exposure as production secret exposure until these secrets are split by environment.

**Commit messages should be specific.** Not `feat: update memory system` but `feat: reduce memory context to 20 items (recent turns already cover last 3 calls)`. See the commit message guidelines in `claude.md`.

---

## 9. HIPAA Compliance

Donna handles health-adjacent data for elderly users. Key rules:

- **Never log PII** (names, phone numbers) in plaintext — use `maskName()` / `maskPhone()` helpers
- **PHI fields are encrypted** at rest where encrypted companion columns are deployed and backfilled — see `lib/encryption.py`, `lib/encryption.js`, and `docs/architecture/SECURITY.md`
- **Audit logging is partial** — verify coverage before changing PHI read/write paths, and add events where missing
- **Data retention is a policy target with implementation gaps** — see `docs/compliance/DATA_RETENTION_POLICY.md`
- **Do not store PHI or credentials in browser/mobile local storage** unless an approved encrypted/minimized design explicitly allows it
- **Do not point tests or local clients at production Railway APIs** unless the test is an approved production smoke test

Read `docs/compliance/` for the full picture before working on anything that touches senior data.

---

## 10. Getting Help

- **Project questions:** Read `claude.md` — it has answers to almost everything
- **AI assistant context:** `claude.md` gives coding agents the project context
- **Stuck on something:** Check `pipecat/docs/LEARNINGS.md` — common pitfalls are documented there
- **David:** Ask anytime

---

Welcome aboard!
