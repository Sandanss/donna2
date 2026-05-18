# Donna Website

React/Vite public website and caregiver web surface for Donna. The app uses Clerk for authenticated caregiver flows and talks only to the repo-root Node API; it does not call Pipecat directly.

## Active Surface

- Public marketing and legal pages
- Caregiver-facing onboarding and dashboard routes
- Waitlist and app-download callouts
- Clerk-authenticated API calls through `src/lib/api.js`

## Local Development

```bash
cd apps/website
npm install
npm run dev
```

The local Vite server runs on the port configured in `vite.config.js` and should point at an explicit dev or mock API. Do not silently fall back to production Railway APIs during local development or tests.

## Validation

```bash
cd apps/website
npm run build
```

Run website/browser E2E from the repo root:

```bash
npm run test:e2e:website
# legacy project/script name still used by Playwright:
npm run test:e2e:consumer
```

## Docs

- Repo map: [`../../DIRECTORY.md`](../../DIRECTORY.md)
- Frontend E2E guide: [`../../docs/guides/FRONTEND_TESTING.md`](../../docs/guides/FRONTEND_TESTING.md)
- System architecture: [`../../docs/architecture/OVERVIEW.md`](../../docs/architecture/OVERVIEW.md)
