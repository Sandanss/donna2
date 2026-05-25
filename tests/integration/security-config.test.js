import { describe, expect, it } from 'vitest';
import {
  getPipecatPublicUrl,
  getServiceApiKey,
  isValidFieldEncryptionKey,
  parseServiceApiKeys,
  validateNodeSecurityConfig,
} from '../../lib/security-config.js';
import crypto from 'crypto';

function fieldKey() {
  return crypto.randomBytes(32).toString('base64url');
}

describe('security config', () => {
  it('ignores legacy DONNA_API_KEY in production', () => {
    const env = {
      ENVIRONMENT: 'production',
      DONNA_API_KEY: 'legacy-key',
    };

    expect(parseServiceApiKeys(env).size).toBe(0);
  });

  it('allows legacy DONNA_API_KEY outside production', () => {
    const env = {
      DONNA_API_KEY: 'legacy-key',
    };

    expect(getServiceApiKey('legacy', env)).toBe('legacy-key');
  });

  it('parses labeled DONNA_API_KEYS', () => {
    const env = {
      DONNA_API_KEYS: 'pipecat:key-one,scheduler:key-two',
    };

    expect(getServiceApiKey('pipecat', env)).toBe('key-one');
    expect(getServiceApiKey('scheduler', env)).toBe('key-two');
  });

  it('requires production security env vars', () => {
    const errors = validateNodeSecurityConfig({ ENVIRONMENT: 'production' });

    expect(errors.some(err => err.includes('JWT_SECRET'))).toBe(true);
    expect(errors.some(err => err.includes('DONNA_API_KEYS'))).toBe(true);
    expect(errors.some(err => err.includes('FIELD_ENCRYPTION_KEY'))).toBe(true);
    expect(errors.some(err => err.includes('CLERK_SECRET_KEY'))).toBe(true);
    expect(errors.some(err => err.includes('PIPECAT_PUBLIC_URL'))).toBe(true);
  });

  it('accepts required production security env vars', () => {
    const errors = validateNodeSecurityConfig({
      ENVIRONMENT: 'production',
      JWT_SECRET: 'not-the-default-secret',
      DONNA_API_KEYS: 'pipecat:key-one',
      FIELD_ENCRYPTION_KEY: fieldKey(),
      CLERK_SECRET_KEY: 'clerk-secret',
      PIPECAT_PUBLIC_URL: 'https://pipecat.example.com',
    });

    expect(errors).toEqual([]);
  });

  it('accepts Upstash shared state when Pipecat Redis is required', () => {
    const errors = validateNodeSecurityConfig({
      ENVIRONMENT: 'production',
      JWT_SECRET: 'not-the-default-secret',
      DONNA_API_KEYS: 'pipecat:key-one',
      FIELD_ENCRYPTION_KEY: fieldKey(),
      CLERK_SECRET_KEY: 'clerk-secret',
      PIPECAT_PUBLIC_URL: 'https://pipecat.example.com',
      PIPECAT_REQUIRE_REDIS: 'true',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });

    expect(errors).toEqual([]);
  });

  it('requires shared state when Redis rate limits are enabled in production', () => {
    const errors = validateNodeSecurityConfig({
      ENVIRONMENT: 'production',
      JWT_SECRET: 'not-the-default-secret',
      DONNA_API_KEYS: 'pipecat:key-one',
      FIELD_ENCRYPTION_KEY: fieldKey(),
      CLERK_SECRET_KEY: 'clerk-secret',
      PIPECAT_PUBLIC_URL: 'https://pipecat.example.com',
      REDIS_RATE_LIMITS_ENABLED: 'true',
    });

    expect(errors).toContain('REDIS_URL or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN is required when REDIS_RATE_LIMITS_ENABLED=true');
  });

  it('validates 32-byte base64url field encryption keys', () => {
    expect(isValidFieldEncryptionKey(fieldKey())).toBe(true);
    expect(isValidFieldEncryptionKey('too-short')).toBe(false);
  });

  it('prefers PIPECAT_PUBLIC_URL over legacy local PIPECAT_BASE_URL', () => {
    expect(getPipecatPublicUrl({
      PIPECAT_PUBLIC_URL: 'https://pipecat.example.com',
      PIPECAT_BASE_URL: 'https://legacy.example.com',
    })).toBe('https://pipecat.example.com');
  });
});
