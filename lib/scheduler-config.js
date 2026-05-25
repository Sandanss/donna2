function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function isExplicitFalse(value) {
  return ['0', 'false', 'no', 'off'].includes(normalize(value));
}

function isExplicitTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(normalize(value));
}

function isKnownNonProductionEnv(env = process.env) {
  const names = [
    env.SCHEDULER_ENVIRONMENT,
    env.RAILWAY_ENVIRONMENT_NAME,
    env.RAILWAY_ENVIRONMENT,
  ].map(normalize);

  return names.some(name => ['dev', 'development', 'preview', 'staging', 'test'].includes(name));
}

export function isSchedulerProductionEnv(env = process.env) {
  return (
    normalize(env.SCHEDULER_ENVIRONMENT) === 'production' ||
    normalize(env.RAILWAY_ENVIRONMENT_NAME) === 'production' ||
    normalize(env.RAILWAY_ENVIRONMENT) === 'production'
  );
}

export function getSchedulerStartupDecision(env = process.env) {
  if (isExplicitFalse(env.SCHEDULER_ENABLED)) {
    return {
      enabled: false,
      reason: 'SCHEDULER_ENABLED=false',
    };
  }

  if (isKnownNonProductionEnv(env) && !isExplicitTrue(env.SCHEDULER_ALLOW_NON_PROD)) {
    return {
      enabled: false,
      reason: 'non-production environment',
    };
  }

  if (isExplicitTrue(env.SCHEDULER_ENABLED)) {
    return {
      enabled: true,
      reason: 'SCHEDULER_ENABLED=true',
    };
  }

  if (isSchedulerProductionEnv(env)) {
    return {
      enabled: true,
      reason: 'production environment',
    };
  }

  return {
    enabled: false,
    reason: 'non-production default',
  };
}

/**
 * Whether the scheduler / call queue materializer should filter out seniors
 * who have not granted consent (consent_status != 'granted' OR callable = false).
 *
 * Default: OFF. Migration 014 grandfathers all existing seniors to
 * consent_status='granted' AND callable=true, so flipping this flag should
 * be a no-op for the existing population. The flag is defense-in-depth in
 * case the grandfather UPDATE silently fails OR new seniors land via a
 * path that doesn't set consent_status correctly. Flip to true after
 * verifying prod state with:
 *   SELECT consent_status, callable, COUNT(*) FROM seniors GROUP BY 1, 2;
 *
 * When false (default): scheduler queries do NOT include the consent gate.
 * When true: scheduler queries gate on (callable=true AND consent_status='granted').
 */
export function isSchedulerConsentGateEnabled(env = process.env) {
  return isExplicitTrue(env.SCHEDULER_REQUIRE_CONSENT);
}
