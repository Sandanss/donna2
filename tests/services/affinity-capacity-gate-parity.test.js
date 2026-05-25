/**
 * Parity test: `pickAffinityReplica` and `estimateAvailablePipecatCapacity`
 * must agree on whether a given replica row has free capacity.
 *
 * Both functions independently evaluate the capacity gate:
 *
 *   - `pickAffinityReplica` (services/dispatcher-affinity.js)
 *       Returns the hinted instance ID iff it has free capacity.
 *
 *   - `estimateAvailablePipecatCapacity` (services/call-queue.js)
 *       Sums free capacity across instances; an instance contributes
 *       zero iff it has no free capacity.
 *
 * These functions today share the same five gate predicates (draining,
 * healthy, ready, active vs max, max(active, inbound) + pending). If
 * one drifts (e.g. someone adds a new field to `pickAffinityReplica`
 * but not `estimateAvailablePipecatCapacity`, or vice versa), affinity
 * routing will hand a senior to a replica the dispatcher thinks is full
 * — causing surprise queue-lease rejections.
 *
 * This test pins parity so any future drift is immediately visible.
 *
 * (No xfail/it.fails — both functions exist on `main` and align today.)
 */

import { describe, expect, it } from 'vitest';
import { pickAffinityReplica } from '../../services/dispatcher-affinity.js';
import { estimateAvailablePipecatCapacity } from '../../services/call-queue.js';

const INSTANCE_ID = 'replica-A';

/**
 * For a single-instance fleet, returns whether each function considers
 * that instance to have free capacity. Both must agree.
 */
function bothFunctionsAgreeOnCapacity(instance) {
  const hinted = pickAffinityReplica({
    instances: [instance],
    affinityInstanceId: INSTANCE_ID,
  });
  const available = estimateAvailablePipecatCapacity({
    instances: [instance],
  });

  return {
    affinityPicked: hinted !== null,
    dispatcherSawCapacity: available > 0,
    available,
  };
}

function baseInstance(overrides = {}) {
  return {
    instanceId: INSTANCE_ID,
    instance_id: INSTANCE_ID,
    healthy: true,
    draining: false,
    ready: true,
    activeCalls: 10,
    active_calls: 10,
    inboundActiveCalls: 0,
    inbound_active_calls: 0,
    maxCalls: 75,
    max_calls: 75,
    pendingReservations: 0,
    pending_reservations: 0,
    ...overrides,
  };
}

describe('pickAffinityReplica vs estimateAvailablePipecatCapacity parity', () => {
  it('agree: healthy replica with headroom has capacity', () => {
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(baseInstance());
    expect(affinityPicked).toBe(true);
    expect(dispatcherSawCapacity).toBe(true);
    expect(available).toBeGreaterThan(0);
  });

  it('agree: draining replica has no capacity', () => {
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(baseInstance({ draining: true }));
    expect(affinityPicked).toBe(false);
    expect(dispatcherSawCapacity).toBe(false);
    expect(available).toBe(0);
  });

  it('agree: replica with ready=false has no capacity', () => {
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(baseInstance({ ready: false }));
    expect(affinityPicked).toBe(false);
    expect(dispatcherSawCapacity).toBe(false);
    expect(available).toBe(0);
  });

  it('agree: unhealthy replica has no capacity', () => {
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(baseInstance({ healthy: false }));
    expect(affinityPicked).toBe(false);
    expect(dispatcherSawCapacity).toBe(false);
    expect(available).toBe(0);
  });

  it('agree: replica at capacity (active >= max) has no capacity', () => {
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(
        baseInstance({ activeCalls: 75, active_calls: 75, maxCalls: 75, max_calls: 75 })
      );
    expect(affinityPicked).toBe(false);
    expect(dispatcherSawCapacity).toBe(false);
    expect(available).toBe(0);
  });

  it('agree: replica with one slot free (active == max - 1) has capacity', () => {
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(
        baseInstance({ activeCalls: 74, active_calls: 74, maxCalls: 75, max_calls: 75 })
      );
    expect(affinityPicked).toBe(true);
    expect(dispatcherSawCapacity).toBe(true);
    expect(available).toBe(1);
  });

  it('agree: inbound_active_calls > active_calls path (Math.max wins)', () => {
    // active=10, inbound=70, max=75 — Math.max = 70 → 5 slots free.
    const instance = baseInstance({
      activeCalls: 10,
      active_calls: 10,
      inboundActiveCalls: 70,
      inbound_active_calls: 70,
    });
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(instance);
    expect(affinityPicked).toBe(true);
    expect(dispatcherSawCapacity).toBe(true);
    expect(available).toBe(5);
  });

  it('agree: inbound_active_calls saturates capacity → no free slots', () => {
    // active=10, inbound=75, max=75 — Math.max = 75 → 0 slots free.
    const instance = baseInstance({
      activeCalls: 10,
      active_calls: 10,
      inboundActiveCalls: 75,
      inbound_active_calls: 75,
    });
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(instance);
    expect(affinityPicked).toBe(false);
    expect(dispatcherSawCapacity).toBe(false);
    expect(available).toBe(0);
  });

  it('agree: pendingReservations > 0 reduces free capacity equally', () => {
    // active=70, pending=4, max=75 → 1 slot free.
    const instance = baseInstance({
      activeCalls: 70,
      active_calls: 70,
      pendingReservations: 4,
      pending_reservations: 4,
    });
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(instance);
    expect(affinityPicked).toBe(true);
    expect(dispatcherSawCapacity).toBe(true);
    expect(available).toBe(1);
  });

  it('agree: pendingReservations saturates capacity → no free slots', () => {
    // active=70, pending=5, max=75 → in_use=75 → 0 slots free.
    const instance = baseInstance({
      activeCalls: 70,
      active_calls: 70,
      pendingReservations: 5,
      pending_reservations: 5,
    });
    const { affinityPicked, dispatcherSawCapacity, available } =
      bothFunctionsAgreeOnCapacity(instance);
    expect(affinityPicked).toBe(false);
    expect(dispatcherSawCapacity).toBe(false);
    expect(available).toBe(0);
  });

  it('agree across the full grid of gate dimensions', () => {
    const scenarios = [
      { name: 'healthy + headroom', overrides: {}, expectFree: true },
      { name: 'draining', overrides: { draining: true }, expectFree: false },
      { name: 'unready', overrides: { ready: false }, expectFree: false },
      { name: 'unhealthy', overrides: { healthy: false }, expectFree: false },
      {
        name: 'at capacity',
        overrides: { activeCalls: 75, active_calls: 75 },
        expectFree: false,
      },
      {
        name: 'inbound saturates',
        overrides: { inboundActiveCalls: 75, inbound_active_calls: 75 },
        expectFree: false,
      },
      {
        name: 'pending saturates',
        overrides: {
          activeCalls: 70,
          active_calls: 70,
          pendingReservations: 5,
          pending_reservations: 5,
        },
        expectFree: false,
      },
    ];

    for (const { name, overrides, expectFree } of scenarios) {
      const instance = baseInstance(overrides);
      const { affinityPicked, dispatcherSawCapacity } =
        bothFunctionsAgreeOnCapacity(instance);
      expect(
        affinityPicked,
        `[${name}] pickAffinityReplica disagreed with parity expectation`
      ).toBe(expectFree);
      expect(
        dispatcherSawCapacity,
        `[${name}] estimateAvailablePipecatCapacity disagreed with parity expectation`
      ).toBe(expectFree);
      expect(
        affinityPicked,
        `[${name}] pickAffinityReplica disagreed with estimateAvailablePipecatCapacity`
      ).toBe(dispatcherSawCapacity);
    }
  });
});
