import * as Sentry from '@sentry/node';
import 'dotenv/config';
import { createHash } from 'crypto';

// Initialize Sentry before all other imports for auto-instrumentation
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    environment: isProductionEnv() ? 'production' : 'development',
    beforeSend(event) {
      // Hash senior_id tags to prevent direct identification
      const sid = event.tags?.senior_id;
      if (sid && sid !== 'unknown' && sid !== 'None') {
        event.tags.senior_id = createHash('sha256').update(String(sid)).digest('hex').slice(0, 8);
      }
      // Truncate exception values to prevent conversation context leaks
      for (const exc of event.exception?.values || []) {
        if (exc.value && exc.value.length > 200) {
          exc.value = exc.value.slice(0, 200) + '...[truncated]';
        }
      }
      return event;
    },
  });
}

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { apiLimiter } from './middleware/rate-limit.js';
import { clerkMiddleware } from './middleware/auth.js';
import { mountRoutes } from './routes/index.js';
import { startScheduler } from './services/scheduler.js';
import { initGrowthBook, closeGrowthBook } from './lib/growthbook.js';
import { assertNodeSecurityConfig, getPipecatPublicUrl, isProductionEnv } from './lib/security-config.js';
import { getSchedulerStartupDecision } from './lib/scheduler-config.js';

// Security middleware
import { securityHeaders, requestId } from './middleware/security.js';
import { requireApiKey } from './middleware/api-auth.js';
import { errorHandler } from './middleware/error-handler.js';

const app = express();

// Trust proxy for Railway/Vercel (needed for rate limiting and X-Forwarded-For)
app.set('trust proxy', 1);

// Security: request ID tracking + security headers
app.use(requestId());
app.use(securityHeaders());

// CORS - allow admin dashboard, consumer app, observability, and local development
const CORS_ORIGINS = [
  'https://admin-v2-liart.vercel.app',
  'https://consumer-ruddy.vercel.app',
  'https://observability-five.vercel.app',
  'https://calldonna.co',
  'https://www.calldonna.co',
  'https://www.call-donna.com',
  'https://call-donna.com',
];
// Only allow localhost origins in non-production environments.
if (!isProductionEnv()) {
  CORS_ORIGINS.push(
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',  // Observability dashboard (local)
    'http://localhost:5173',  // Admin dashboard (React)
    'http://localhost:5174',  // Consumer app (React)
    'http://localhost:5175',  // Admin v2 (React)
  );
}
app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
}));

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// Security: API key auth + rate limiting for /api/* routes
app.use('/api', requireApiKey, apiLimiter);

// Clerk authentication middleware (initializes auth state)
app.use(clerkMiddleware());

const PORT = process.env.PORT || 3001;

// Pipecat handles all voice calls — webhook URLs must point there
assertNodeSecurityConfig();
const PIPECAT_BASE_URL = getPipecatPublicUrl() || (
  isProductionEnv()
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:7860`
);

// Make shared state available to route handlers via app.get()
app.set('baseUrl', PIPECAT_BASE_URL);

// Mount all routes
mountRoutes(app);

// Sentry error handler - must be before custom error handler
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Centralized error handler - MUST be last middleware
app.use(errorHandler);

// Create HTTP server
const server = createServer(app);

server.listen(PORT, async () => {
  console.log(`Donna v4.0 listening on port ${PORT}`);
  console.log(`Pipecat Telnyx webhook: ${PIPECAT_BASE_URL}/telnyx/events`);
  console.log(`Features: Admin APIs, Reminder scheduler, Call initiation`);

  // Initialize GrowthBook feature flags
  await initGrowthBook();

  // Start the reminder scheduler (check every minute).
  // Scheduled calls are live telephony; only production runs them by default.
  const schedulerDecision = getSchedulerStartupDecision();
  if (!schedulerDecision.enabled) {
    console.log(`Scheduler disabled (${schedulerDecision.reason})`);
  } else {
    console.log(`Scheduler enabled (${schedulerDecision.reason})`);
    startScheduler(PIPECAT_BASE_URL, 60000);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  closeGrowthBook();
  server.close(() => process.exit(0));
});
