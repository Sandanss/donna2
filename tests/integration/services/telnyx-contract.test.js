import { readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initiateTelnyxOutboundCall,
  prewarmTelnyxOutboundContext,
} from '../../../services/telnyx.js';

const originalEnv = { ...process.env };

function loadFixture(name) {
  const path = new URL(`../../fixtures/telnyx-outbound/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function mockPipecatResponse(payload = {}) {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

describe('Telnyx service Node to Pipecat contract', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DONNA_API_KEYS: 'pipecat:test-pipecat-key,node:test-node-key,dispatcher:test-dispatcher-key',
      PIPECAT_PUBLIC_URL: '',
      PIPECAT_BASE_URL: '',
    };
    vi.stubGlobal('fetch', mockPipecatResponse({
      callSid: 'call-contract-1',
      callControlId: 'control-contract-1',
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('posts the shared check-in payload to Pipecat /telnyx/outbound', async () => {
    const fixture = loadFixture('check-in');

    const result = await initiateTelnyxOutboundCall({
      ...fixture,
      baseUrl: 'https://pipecat.example.test/',
    });

    expect(result).toEqual({
      callSid: 'call-contract-1',
      callControlId: 'control-contract-1',
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://pipecat.example.test/telnyx/outbound');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      'content-type': 'application/json',
      'x-api-key': 'test-pipecat-key',
    });
    expect(JSON.parse(options.body)).toEqual(fixture);
  });

  it('preserves reminder and prewarmed-context fields sent to Pipecat', async () => {
    const fixture = loadFixture('reminder-prewarmed');

    await initiateTelnyxOutboundCall({
      ...fixture,
      baseUrl: 'https://pipecat.example.test',
    });

    const [, options] = fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual(fixture);
  });

  it('preserves queue reservation fields sent to Pipecat', async () => {
    const fixture = {
      ...loadFixture('check-in'),
      queueId: 'queue-1',
      reservationId: 'reservation-1',
    };

    await initiateTelnyxOutboundCall({
      ...fixture,
      baseUrl: 'https://pipecat.example.test',
    });

    const [, options] = fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual(fixture);
  });

  it('uses the dispatcher service key for queue dispatcher calls without sending the label to Pipecat', async () => {
    const fixture = {
      ...loadFixture('check-in'),
      queueId: 'queue-1',
      reservationId: 'reservation-1',
      serviceLabel: 'dispatcher',
    };

    await initiateTelnyxOutboundCall({
      ...fixture,
      baseUrl: 'https://pipecat.example.test',
    });

    const [, options] = fetch.mock.calls[0];
    expect(options.headers).toMatchObject({
      'x-api-key': 'test-dispatcher-key',
    });
    expect(JSON.parse(options.body)).toEqual({
      seniorId: fixture.seniorId,
      callType: fixture.callType,
      queueId: 'queue-1',
      reservationId: 'reservation-1',
    });
  });

  it('posts the prewarm payload subset Pipecat expects before reminder calls', async () => {
    const fixture = loadFixture('reminder-prewarmed');

    await prewarmTelnyxOutboundContext({
      seniorId: fixture.seniorId,
      callType: fixture.callType,
      reminderId: fixture.reminderId,
      scheduledFor: fixture.scheduledFor,
      baseUrl: 'https://pipecat.example.test',
    });

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://pipecat.example.test/telnyx/prewarm');
    expect(JSON.parse(options.body)).toEqual({
      seniorId: fixture.seniorId,
      callType: fixture.callType,
      reminderId: fixture.reminderId,
      scheduledFor: fixture.scheduledFor,
    });
  });
});
