/**
 * Route Aggregator
 *
 * Mounts all route modules onto the Express app.
 */

import healthRoutes from './health.js';
import callRoutes from './calls.js';
import seniorRoutes from './seniors.js';
import memoryRoutes from './memories.js';
import conversationRoutes from './conversations.js';
import reminderRoutes from './reminders.js';
import onboardingRoutes from './onboarding.js';
import caregiverRoutes from './caregivers.js';
import statsRoutes from './stats.js';
import observabilityRoutes from './observability.js';
import adminAuthRoutes from './admin-auth.js';
import callAnalysesRoutes from './call-analyses.js';
import dailyContextRoutes from './daily-context.js';
import notificationRoutes from './notifications.js';
import waitlistRoutes from './waitlist.js';
import chatRoutes from './chat.js';

export function mountRoutes(app) {
  app.use(healthRoutes);
  app.use(waitlistRoutes);
  app.use(callRoutes);
  app.use(seniorRoutes);
  app.use(memoryRoutes);
  app.use(conversationRoutes);
  app.use(reminderRoutes);
  app.use(onboardingRoutes);
  app.use(caregiverRoutes);
  app.use(statsRoutes);
  app.use(observabilityRoutes);
  app.use(adminAuthRoutes);
  app.use(callAnalysesRoutes);
  app.use(dailyContextRoutes);
  app.use(notificationRoutes);
  app.use(chatRoutes);
}
