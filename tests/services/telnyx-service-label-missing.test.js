import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initiateTelnyxOutboundCall } from '../../services/telnyx.js';

// `services/telnyx.js` does not export `getPipecatServiceKey` (it is module-
// internal). We exercise the same code path via `initiateTelnyxOutboundCall`,
// which is the only public consumer and the path the dispatcher actually
// takes. The contract under test: when `serviceLabel='dispatcher'` is
// requested but DONNA_API_KEYS contains no `dispatcher:` entry, the call must
// throw an error that NAMES the missing service label. A silent fallback to
// some other service's key would let unrelated buckets share rate-limit
// counters and would mask misconfiguration in production.

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Isolate env per test.
  process.env = { ...ORIGINAL_ENV };
  process.env.NODE_ENV = 'production';
  process.env.PIPECAT_PUBLIC_URL = 'https://pipecat.example.test';
  delete process.env.DONNA_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('dispatcher dial fails loudly when dispatcher key missing from DONNA_API_KEYS', () => {
  it('initiateTelnyxOutboundCall throws naming the missing dispatcher label', async () => {
    process.env.DONNA_API_KEYS = 'other:keyvalue-xyz';

    // fetch should never be called — error must throw before the HTTP layer.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await expect(
      initiateTelnyxOutboundCall({
        seniorId: 'senior-1',
        callType: 'check-in',
        serviceLabel: 'dispatcher',
      }),
    ).rejects.toThrow(/dispatcher/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not silently fall back to a different service key when dispatcher is requested', async () => {
    // pipecat label is present, dispatcher is NOT. The error message must
    // still surface the missing label rather than dialing as `pipecat`.
    process.env.DONNA_API_KEYS = 'pipecat:pipecat-key-9001,scheduler:scheduler-key-abc';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await expect(
      initiateTelnyxOutboundCall({
        seniorId: 'senior-1',
        callType: 'reminder',
        serviceLabel: 'dispatcher',
      }),
    ).rejects.toThrow(/dispatcher/);

    // Critical: no HTTP request fired against the pipecat key.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('succeeds when the dispatcher label IS present (control case)', async () => {
    process.env.DONNA_API_KEYS = 'dispatcher:dispatch-key-xyz';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      // Confirm the dispatcher key is what's wired up — i.e. no fallback path.
      expect(init.headers['x-api-key']).toBe('dispatch-key-xyz');
      return {
        ok: true,
        json: async () => ({ callControlId: 'v3:CA-control' }),
      };
    });

    const result = await initiateTelnyxOutboundCall({
      seniorId: 'senior-1',
      callType: 'check-in',
      serviceLabel: 'dispatcher',
    });

    expect(result).toEqual({ callControlId: 'v3:CA-control' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
