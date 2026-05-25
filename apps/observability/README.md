# Donna Observability

Internal-only operations dashboard for Donna operators. It has History, Live,
and Infra views for call review, active-call monitoring, and scale/queue
health.

## Data Environments

The dashboard can read either Railway dev or production API data. It does not embed service keys or bypass credentials in the browser.

- `Dev` uses `VITE_API_URL_DEV`, defaulting to `https://donna-api-dev.up.railway.app`.
- `Prod` uses `VITE_API_URL_PROD`, falling back to `VITE_API_URL`, then `https://donna-api-production-2450.up.railway.app`.
- Admin tokens are stored per environment as `donna_obs_token_dev` and `donna_obs_token_prod`.

Switching environments clears the selected call and requires a valid token for the selected environment. This prevents a dev token from being reused against production data.

## Local Development

```bash
npm --prefix apps/observability run dev -- --host localhost --port 3002
```

Use the environment toggle on the login screen or dashboard header to choose the data source.

In local Vite development, the default API roots are proxy paths:

- `Dev` calls `/dev-api`, proxied to Railway dev.
- `Prod` calls `/prod-api`, proxied to Railway prod.

This avoids browser CORS failures while still keeping credentials in the browser scoped to the selected environment. Production builds use the real `VITE_API_URL_DEV` and `VITE_API_URL_PROD` URLs.

## LLM Context Flow

The Context tab is the main debugging surface for what Donna sent into the LLM path during a call. New calls capture:

- base system and flow task prompts
- senior profile, local time, interests, profile context, caregiver notes, and reminder prompt context
- previous-call summaries, same-day context, initial memory context, and last-call analysis follow-up context
- Director guidance, prefetched memory injections, web search/tool calls, tool results, and latency

Context trace content can contain PHI. Pipecat writes it to `call_metrics.context_trace_encrypted` using the shared field encryption format. The Node observability API decrypts it only after admin auth and audit logging.

Apply `db/migrations/003_call_context_trace.sql` or `pipecat/db/migrations/010_call_context_trace.sql` before expecting new context traces in a database. Runtime code tolerates the column being absent during a rolling deploy, but calls made before the migration will not have a trace.
