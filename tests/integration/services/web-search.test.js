import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeQuery, search } from '../../../services/web-search.js';

const originalFetch = global.fetch;

describe('web search privacy and latency guardrails', () => {
  afterEach(() => {
    delete process.env.TAVILY_API_KEY;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sanitizes contact details before sending queries externally', async () => {
    process.env.TAVILY_API_KEY = 'test-tavily-key';
    global.fetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.query).not.toContain('555-123-4567');
      expect(body.query).not.toContain('caregiver@example.test');
      expect(options.signal).toBeTruthy();
      return {
        ok: true,
        json: async () => ({ results: [{ title: 'Game time', url: 'https://example.test', content: '7 PM' }] }),
      };
    });

    const result = await search(
      'Astros schedule 555-123-4567 caregiver@example.test',
      { timeoutMs: 25 }
    );

    expect(result.results).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns an empty result set when Tavily times out', async () => {
    process.env.TAVILY_API_KEY = 'test-tavily-key';
    global.fetch = vi.fn(async () => {
      const error = new Error('operation timed out');
      error.name = 'TimeoutError';
      throw error;
    });

    const result = await search('Astros schedule', { timeoutMs: 1 });

    expect(result).toEqual({ results: [] });
  });

  it('exposes a deterministic query sanitizer for tool callers', () => {
    expect(sanitizeQuery('Call me at +1 (555) 123-4567 or a@b.test')).toBe('Call me at  or');
  });
});
