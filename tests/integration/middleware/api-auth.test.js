import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isApiKeyExemptPath,
  requireApiKey,
} from '../../../middleware/api-auth.js';

const originalDonnaApiKey = process.env.DONNA_API_KEY;

afterEach(() => {
  if (originalDonnaApiKey === undefined) {
    delete process.env.DONNA_API_KEY;
  } else {
    process.env.DONNA_API_KEY = originalDonnaApiKey;
  }
});

function runRequireApiKey(path, authorization = 'Bearer clerk-session-token') {
  const req = {
    path,
    headers: authorization ? { authorization } : {},
  };
  const res = {
    status: vi.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function json(body) {
      this.body = body;
      return this;
    }),
  };
  const next = vi.fn();

  requireApiKey(req, res, next);

  return { res, next };
}

describe('requireApiKey', () => {
  it('lets Clerk/JWT-owned collection routes through without comparing them to DONNA_API_KEY', () => {
    process.env.DONNA_API_KEY = 'service-api-key';

    for (const path of ['/reminders', '/seniors', '/stats', '/chat']) {
      const { res, next } = runRequireApiKey(path);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('lets nested Clerk/JWT-owned routes through', () => {
    process.env.DONNA_API_KEY = 'service-api-key';

    for (const path of [
      '/reminders/reminder-123',
      '/seniors/senior-123/schedule',
      '/notifications/preferences',
      '/call-analyses',
      '/daily-context',
      '/calls/call-123/end',
      '/chat/stream',
    ]) {
      const { res, next } = runRequireApiKey(path);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('does not exempt unrelated routes that merely share a prefix', () => {
    process.env.DONNA_API_KEY = 'service-api-key';

    for (const path of ['/reminders-extra', '/call-analyses-admin', '/chatty']) {
      const { res, next } = runRequireApiKey(path);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    }
  });

  it('still requires the service API key for non-exempt /api routes', () => {
    process.env.DONNA_API_KEY = 'service-api-key';

    const denied = runRequireApiKey('/internal-job', 'Bearer clerk-session-token');
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.res.status).toHaveBeenCalledWith(403);

    const allowed = runRequireApiKey('/internal-job', 'Bearer service-api-key');
    expect(allowed.next).toHaveBeenCalledOnce();
    expect(allowed.res.status).not.toHaveBeenCalled();
  });

  it('skips API key auth when DONNA_API_KEY is unset for local development', () => {
    delete process.env.DONNA_API_KEY;

    const { res, next } = runRequireApiKey('/internal-job', undefined);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('isApiKeyExemptPath', () => {
  it('matches exact collection paths and nested paths', () => {
    expect(isApiKeyExemptPath('/reminders')).toBe(true);
    expect(isApiKeyExemptPath('/reminders/')).toBe(true);
    expect(isApiKeyExemptPath('/reminders/abc')).toBe(true);
  });

  it('uses path segment boundaries', () => {
    expect(isApiKeyExemptPath('/reminders-extra')).toBe(false);
    expect(isApiKeyExemptPath('/call-analyses-admin')).toBe(false);
  });
});
