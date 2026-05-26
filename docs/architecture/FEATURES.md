# Donna Product Features

> Current state of all features in the Donna AI companion system.

---

## Voice Calling

### Outbound Calls (Donna calls seniors)
- Scheduled daily check-in calls at configurable times per senior
- Reminder-triggered calls for everyday and social reminders
- Manual outbound calls via admin dashboard or API
- Time-of-day awareness (greetings adapt to morning/afternoon/evening)

### Inbound Calls (seniors call Donna)
- Seniors can call Donna's number anytime
- Caller ID lookup matches to senior profile
- Unsubscribed callers routed to `new_customer` flow
- Return caller recognition with conversation memory

### New Customer Calls
- Unrecognized callers get a warm new customer conversation
- Learns caller name, relationship to senior, senior's name, interests, and useful non-medical context
- Extracts and saves prospect details after the call to avoid in-call tool latency
- Return callers recognized and greeted by name with prior context

---

## Conversation

### Natural Dialogue
- Claude Haiku 4.5 powers the conversation (streaming responses)
- Full in-call context retention (APPEND strategy, no truncation)
- Warm, grandchild-like tone tuned for elderly users
- Barge-in support via Silero VAD (interrupt detection)

### Language Support
- Caregivers can configure Donna's call language per senior through `familyInfo.donnaLanguage`
- English and Spanish are active call languages
- Spanish calls set Deepgram STT language to `es`, inject a Spanish-only prompt instruction, and use optional Spanish ElevenLabs/Cartesia voice IDs when configured
- Claude Haiku post-call analysis writes caregiver-facing summaries and takeaways in the configured Donna language
- Mobile onboarding sends `familyInfo.donnaLanguage` and `topicsToAvoid`; the current website onboarding stores language/topics in local state but only submits relation/interest detail payloads to Node, so website parity still needs a small API payload follow-up.

### Senior Profile Context
- Donna grounds every call in the senior's local timezone and profile location
- Caregiver profile fields can add date of birth, interest-specific detail text, additional context, and topics to avoid
- Date of birth is converted into age and birthday awareness in the prompt; upcoming birthdays are mentioned only when relevant
- Topics to avoid are read from `familyInfo.topicsToAvoid`, with a compatibility fallback to `preferredCallTimes.topicsToAvoid` for onboarding-created rows

### 4-Phase Call State Machine (Pipecat Flows)
- **Reminder phase** (conditional) — Delivers pending reminders before main conversation
- **Main phase** — Free-form conversation with all tools available
- **Winding Down** — Summarize, deliver remaining reminders, prepare goodbye
- **Closing** — Warm goodbye, automatic call termination

### Greeting System
- Time-based greeting templates (morning/afternoon/evening)
- Sentiment-aware greetings (uses last call's engagement/rapport to set tone)
- Interest-based follow-ups woven into greetings
- Previous conversation references ("Last time you mentioned...")
- Rotation to prevent repetitive greetings

### 2-Layer Conversation Director
- **Layer 1: Quick Observer** — regex patterns (0ms), instant guidance injection
  - Emotion detection with valence/intensity
  - Family/relationship pattern matching
  - Activity and social-context pattern matching
  - Strong-goodbye detection → guarded programmatic call end after minimum call age and configured delay
- **Layer 2: Conversation Director** — Groq primary, Gemini fallback LLM analysis (non-blocking)
  - Call phase tracking and pacing guidance
  - Topic management (stay, transition, or wrap up)
  - Engagement monitoring with re-engagement suggestions
  - Emotional tone detection and tone adjustment
  - Reminder delivery timing (natural pauses only)
  - Time-based fallbacks (force winding-down at 9min, end at 12min)

---

## Memory System

### Semantic Memory (pgvector)
- OpenAI `text-embedding-3-small` embeddings (1536 dimensions)
- HNSW index for fast approximate nearest-neighbor search
- Cosine similarity with 0.7 minimum threshold
- Deduplication (skip if cosine > 0.9 with existing memory)
- Importance decay: `base * 0.5^(days/30)` (30-day half-life)
- Access boost: +10 importance if accessed in last week
- Tiered retrieval: Critical → Contextual → Background
- Circuit breaker on embedding calls (10s timeout, 3-failure threshold)

### In-Call Memory
- Real-time topic, question, and advice tracking (ConversationTracker)
- Mid-call memory refresh after 5+ minutes (re-fetches with current topics)
- Shared transcript via session_state for Director analysis

### Cross-Call Memory
- Recent turns from previous calls loaded into system prompt
- Same-day cross-call context (topics, advice, reminders persist across calls in a day)
- Call summaries stored for multi-day context
- Post-call memory extraction (OpenAI extracts facts, preferences, events from transcript)

### Interest Discovery
- Automatic interest extraction from conversations
- New interests are mapped to predefined mobile app categories where possible
- AI-detected topic details are stored in `familyInfo.interestDetails` so caregivers can review and edit them
- Engagement scores computed per interest topic
- Interest-weighted news story selection

---

## Reminders

### Reminder Management
- One-time and recurring reminder support
- Reminder scheduling with timezone awareness
- Priority levels and natural delivery timing
- Delivery tracking with acknowledgment status (acknowledged/confirmed)

### Reminder Delivery
- Reminders woven naturally into conversation (Director-timed)
- `mark_reminder_acknowledged` tool tracks senior's response
- `create_reminder` can save senior-requested reminders during subscribed calls after Donna confirms title, date/time, recurrence, and readback
- Undelivered reminders retried on next call
- Caregiver visibility into delivery status

---

## News & Web Search

### Curated News
- OpenAI GPT-4o-mini with web search tool fetches senior-friendly news
- Filtered by senior's interests (7-8 uplifting stories per fetch)
- 1-hour cache to avoid redundant API calls
- Interest-weighted story selection per call (top 3 from cache)
- Director-driven injection (news appears in conversation only when contextually relevant)

### Web Search (In-Call)
- Senior can ask any factual question during a call
- `web_search` tool uses Tavily raw snippets first and OpenAI web search as fallback
- Search queries are sanitized to avoid sending names, phone numbers, addresses, caregiver names, or private medical history
- Async execution with a 15-second timeout and graceful fallback

---

## Caregiver Features

### Caregiver Website And Mobile App
- Clerk authentication for caregiver web and mobile users
- Website/caregiver web app at `apps/website/` for public pages, onboarding, and caregiver dashboard access
- Mobile caregiver app at `apps/mobile/` for iOS/Android dashboard, schedule, reminders, settings, and account management
- Native iOS Sign in with Apple uses `expo-apple-authentication` directly and passes the Apple identity token into Clerk (`oauth_token_apple`); Google remains browser OAuth
- Fresh mobile onboarding starts from the visible Create Account screen and creates/links the senior through the Node `/api/onboarding` path
- Mobile sign-in is valid only for Clerk users with an existing Donna profile; no-profile Clerk sessions are treated as incomplete setup and cleaned up through `DELETE /api/caregivers/me/incomplete-account`
- View call summaries, engagement scores, and completed/missed reminder updates
- Website/caregiver APIs also support scheduling-assistant chat (`/api/chat`), batch reminder creation, and account deletion. Mobile adds notification history, mark-read, and Expo push-token registration.

### Caregiver Notes
- Backend/Pipecat support caregiver notes for Donna to deliver during calls, but current web/mobile clients do not expose a caregiver-note creation flow
- Caregiver notes are pre-fetched at call start and injected into the system prompt when present
- Natural delivery ("Oh, by the way, your daughter wanted me to ask about...")
- Notes marked as delivered with call reference

### Post-Call Notifications
- Automatic notification to Node.js API on call completion
- Completed-call and missed-reminder updates are recorded; concern alerts are deprecated
- Call summary available via API

---

## Post-Call Processing

Runs automatically after every call disconnect:

1. **Conversation completion** — Duration, status, encrypted transcript saved to DB
2. **Call analysis** — Anthropic Claude Haiku forced tool-use generates summary, engagement score (1-10), mood, and caregiver takeaways
3. **Caregiver notification** — Email/in-app updates recorded for completed calls and missed reminders; SMS is inactive
4. **Summary persistence** — Encrypted at rest; enables cross-call context and caregiver call summaries
5. **Interest discovery** — Extracts new interests, computes engagement scores
6. **Memory extraction** — OpenAI extracts facts/preferences/events, stores with embeddings
7. **Daily context save** — Topics, advice, reminders for same-day cross-call memory
8. **Reminder cleanup** — Marks unacknowledged reminders for retry
9. **Cache clearing** — Clears per-senior context and reminder caches
10. **Snapshot rebuild** — Pre-computes `call_context_snapshot_encrypted` for next call; plaintext `call_context_snapshot` is legacy fallback only

---

## Admin Dashboard

- Senior management (CRUD for core profile fields such as name, phone, timezone/location, interests, and memory context; richer caregiver settings like language, DOB, interest detail text, and topics to avoid are currently stronger in mobile/web onboarding than in admin)
- Call history with transcripts and analysis
- Reminder management (list/create/delete in current admin client; edit/PATCH is not wired in the admin UI)
- Caregiver management
- Call analysis viewer (summaries, engagement scores, caregiver takeaways)
- Manual call initiation
- JWT authentication

---

## Infrastructure

### Security
- JWT admin authentication + cofounder API keys
- Labeled service API key authentication (`DONNA_API_KEYS`; legacy `DONNA_API_KEY` only outside production)
- Telnyx webhook signature verification plus single-use `ws_token` validation for media WebSockets
- Rate limiting in both backends (`slowapi` on Pipecat, Express middleware/Redis store on Node)
- Security headers (HSTS, X-Frame-Options)
- Pydantic input validation
- PII-safe logging (phone/name masking)

### Reliability
- Circuit breakers for all external services (Groq, Gemini Director fallback, Anthropic analysis, OpenAI, Tavily/news)
- GrowthBook feature flags with safe defaults when unavailable
- Graceful shutdown with active call tracking (7s drain on SIGTERM)
- Enhanced /health endpoint (database + circuit breaker states)

### Scale Rollout
- Legacy Node scheduler/dialer remains available as the current/rollback path
- Queue architecture behind `CALL_ARCHITECTURE_MODE` supports shadow materialization, dry-run dispatch, canary queue dialing, queue-primary dialing, and legacy rollback
- Durable `call_queue` plus shared `outbound_call_guards` prevent duplicate dialing across legacy and queue paths; `call_attempts` records queue-dispatch attempts and Pipecat lifecycle updates when `queue_id` is present
- Pipecat capacity heartbeats and queue reservations coordinate outbound dispatch across replicas
- Phase 7 canary cohort membership is stored in `canary_cohort_membership`, with env allowlist as emergency fallback
- Phase 8 capacity planner/autoscaler recommends Railway replica changes for known call windows; dry-run by default
- The 10,000-user path is documented as forward work built on the queue architecture, not completed runtime support

### Deployment
- Three environments: dev, staging, production
- CI/CD: PRs run tests/checks; staging deploy and smoke tests are push-gated; production deploys are handled by the main deploy workflow
- Railway (Pipecat + Node.js), Vercel (frontends)
- Neon PostgreSQL with branch-per-environment

---

## Special Optimizations

### Call Answer Speed (~700ms)
- **Parallel DB fetches** — Senior profile, memories, news, reminders, and context all fetched concurrently via `asyncio.gather` instead of sequentially
- **Call context snapshot** — Post-call processing pre-computes an encrypted snapshot (`seniors.call_context_snapshot_encrypted`) containing last call analysis, recent summaries, recent turns, and daily context. At call time, a single column read replaces 6 separate DB queries; plaintext `call_context_snapshot` is a legacy fallback only.
- **Cached news** — News fetched at 5 AM local time and stored in `seniors.cached_news`. Call answer reads it from the snapshot instead of making a 4-10s OpenAI web search

### Predictive Context Engine (Speculative Prefetch)
Eliminates tool-call latency by pre-fetching results before Claude asks for them:

- **1st wave (0ms)** — Raw/interim utterance extraction from transcription. Fires background `memory.search()` calls → results cached in `PrefetchCache`
- **2nd wave (~70ms)** — Query Director predicts `memory_queries`. Fires anticipatory memory prefetches
- **Interim prefetch** — Debounced prefetch during user speech (1s gap, 15+ chars)
- **Proactive memory injection** — Director injects cached memory context before Claude responds. Cache hit = ~0ms vs 200-300ms memory search
- **Jaccard matching** — Cache lookup uses word-overlap similarity (memory: 0.3 threshold). No embedding calls needed for cache lookup

### Speculative Director Analysis
Starts Director analysis before the user finishes speaking:

- **Silence detection** — 250ms gap in interim transcriptions triggers speculative Groq analysis
- **Same-turn injection** — If speculative result completes before final transcription + Jaccard overlap ≥ 0.7, guidance is injected for the CURRENT turn (not one turn behind)
- **Typical hit rate** — 70-90% of turns get same-turn guidance
- **Automatic cancellation** — New interim text cancels stale speculative analysis

### Director-Driven News Injection
- News is NOT in the system prompt (saves ~300 tokens per turn)
- Director signals `should_mention_news: true` when conversation topic aligns
- Conversation Director processor injects news into guidance (one-shot per call)
- Reduces per-turn token count while keeping news contextually relevant

### Location & Date Context for Director
- Senior's city/state and local current date passed in every Director turn template
- Senior-facing system prompt includes the senior's local current date and time at call start
- Recent call summaries and transcript snippets include local prior-call labels such as "Earlier today at 3:30 PM (about 30 minutes ago)"
- Post-call memory extraction receives the call date/time and resolves relative phrases like "tomorrow" into anchored future plans
- Greeting and analysis followups avoid completion-style questions for future plans until the referenced date/time has arrived
- Improves guidance, memory query specificity, and same-day temporal grounding

### Director Provider Chain
- **Groq** (`gpt-oss-20b`) is the primary fast provider
- **Gemini Flash** (`gemini-3-flash-preview`) is the fallback for full guidance analysis
- Separate circuit breakers per provider (Groq and Gemini)
- System instruction separated from per-turn content for Gemini caching
- Trimmed system instruction: 429 → 144 tokens

### Anthropic Prompt Caching
- Enabled on Claude Haiku 4.5 for the voice LLM
- System prompt and senior context cached across turns within a call
- Reduces per-turn input token costs

### Programmatic Call Ending
- LLM tool calls for ending calls are unreliable (Claude says "goodbye" but doesn't call transition tools)
- Quick Observer detects strong goodbye patterns via regex → queues EndFrame after the configured goodbye delay
- Bypasses the LLM entirely for call termination
- `_goodbye_in_progress` flag suppresses stale Director guidance during goodbye sequence

---

*Last updated: May 2026 — current Director/provider, tool architecture, and scale rollout status*
