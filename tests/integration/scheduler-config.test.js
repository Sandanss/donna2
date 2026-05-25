import { describe, expect, it } from 'vitest';
import {
  getSchedulerStartupDecision,
  isSchedulerConsentGateEnabled,
  isSchedulerProductionEnv,
} from '../../lib/scheduler-config.js';

describe('scheduler startup config', () => {
  it('does not treat a Railway public domain as permission to place scheduled calls', () => {
    const env = {
      RAILWAY_PUBLIC_DOMAIN: 'donna-api-dev.up.railway.app',
    };

    expect(isSchedulerProductionEnv(env)).toBe(false);
    expect(getSchedulerStartupDecision(env)).toEqual({
      enabled: false,
      reason: 'non-production default',
    });
  });

  it('enables scheduler by default only for production environment names', () => {
    expect(getSchedulerStartupDecision({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toEqual({
      enabled: true,
      reason: 'production environment',
    });
    expect(getSchedulerStartupDecision({ SCHEDULER_ENVIRONMENT: 'production' })).toEqual({
      enabled: true,
      reason: 'production environment',
    });
  });

  it('does not treat security production mode as permission to place scheduled calls', () => {
    expect(isSchedulerProductionEnv({ ENVIRONMENT: 'production' })).toBe(false);
    expect(getSchedulerStartupDecision({ ENVIRONMENT: 'production' })).toEqual({
      enabled: false,
      reason: 'non-production default',
    });
  });

  it('keeps non-production Railway schedulers disabled even when old env vars opt in', () => {
    expect(getSchedulerStartupDecision({
      ENVIRONMENT: 'production',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      SCHEDULER_ENABLED: 'true',
    })).toEqual({
      enabled: false,
      reason: 'non-production environment',
    });
  });

  it('allows explicit scheduler opt-in for dev smoke testing', () => {
    expect(getSchedulerStartupDecision({ SCHEDULER_ENABLED: 'true' })).toEqual({
      enabled: true,
      reason: 'SCHEDULER_ENABLED=true',
    });
  });

  it('requires an explicit non-production override for Railway smoke testing', () => {
    expect(getSchedulerStartupDecision({
      RAILWAY_ENVIRONMENT_NAME: 'dev',
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_ALLOW_NON_PROD: 'true',
    })).toEqual({
      enabled: true,
      reason: 'SCHEDULER_ENABLED=true',
    });
  });

  it('allows explicit scheduler opt-out even in production', () => {
    expect(getSchedulerStartupDecision({
      RAILWAY_ENVIRONMENT_NAME: 'production',
      SCHEDULER_ENABLED: 'false',
    })).toEqual({
      enabled: false,
      reason: 'SCHEDULER_ENABLED=false',
    });
  });
});

describe('isSchedulerConsentGateEnabled', () => {
  it('defaults to false when env var is missing', () => {
    expect(isSchedulerConsentGateEnabled({})).toBe(false);
  });

  it('defaults to false even in production', () => {
    expect(isSchedulerConsentGateEnabled({
      RAILWAY_ENVIRONMENT_NAME: 'production',
    })).toBe(false);
  });

  it('returns true only for explicit truthy values', () => {
    expect(isSchedulerConsentGateEnabled({ SCHEDULER_REQUIRE_CONSENT: 'true' })).toBe(true);
    expect(isSchedulerConsentGateEnabled({ SCHEDULER_REQUIRE_CONSENT: '1' })).toBe(true);
    expect(isSchedulerConsentGateEnabled({ SCHEDULER_REQUIRE_CONSENT: 'yes' })).toBe(true);
    expect(isSchedulerConsentGateEnabled({ SCHEDULER_REQUIRE_CONSENT: 'on' })).toBe(true);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(isSchedulerConsentGateEnabled({ SCHEDULER_REQUIRE_CONSENT: ' TRUE ' })).toBe(true);
    expect(isSchedulerConsentGateEnabled({ SCHEDULER_REQUIRE_CONSENT: 'YES' })).toBe(true);
  });

  it('treats unrelated strings as false (fail-safe)', () => {
    expect(isSchedulerConsentGateEnabled({ SCHEDULER_REQUIRE_CONSENT: 'maybe' })).toBe(false);
    expect(isSchedulerConsentGateEnabled({ SCHEDULER_REQUIRE_CONSENT: '' })).toBe(false);
  });
});
