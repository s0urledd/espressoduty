// The leader-duty state machine — the part whose silent breakage would
// defeat the product. Alerts are captured through a mocked sender; the
// chain is simulated as {proposals, slots} sequences.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ValidatorView } from '../src/lib/state';

const alerts: Array<{ severity: string; title: string; pagerduty?: string; dedupKey?: string }> = [];
vi.mock('../src/lib/alerts', () => ({
  sendAlert: vi.fn(async (ev: unknown) => {
    alerts.push(ev as (typeof alerts)[number]);
    return true; // a channel took the message
  }),
}));

const { sendAlert } = await import('../src/lib/alerts');
const { evaluateLeaderDuty } = await import('../src/lib/monitor');
type Vm = import('../src/lib/monitor').ValidatorMachine;
type Entry = import('../src/lib/monitor').ActiveNode;

const net = {
  name: 'mainnet' as const,
  validators: [],
  queryNodes: [],
  stakingApis: [],
  explorerUrl: 'https://explorer.example',
};

function vm(over: Partial<Vm> = {}): Vm {
  return {
    initialized: true,
    lastEpoch: 471,
    missStreak: 0,
    trendAlerted: false,
    trendPaged: false,
    trendSince: null,
    missingCount: 0,
    missingAlerted: false,
    missingSince: null,
    missingPdTriggered: false,
    prevProposals: null,
    prevMissed: null,
    ...over,
  };
}

// Unique keys per test: the real cooldown map is keyed by validator.
let seq = 0;
function vv(): ValidatorView {
  seq += 1;
  return {
    key: `BLS_VER_KEY~test${seq}`,
    label: `test${seq}`,
    account: null,
    stakeEsp: null,
    commission: null,
    delegatorCount: null,
    inActiveSet: true,
    vote: null,
    proposal: null,
    missedSlots: null,
    leaderSlots: null,
    missedLeaderSlots: null,
    epochMissCount: 0,
    health: 'ok',
    samples: [],
  };
}

function entry(proposals: number, slots: number): Entry {
  return { address: '0xabc', votes: 0, eligible_votes: 0, proposals, slots };
}

beforeEach(() => {
  alerts.length = 0;
});

describe('leader-duty state machine', () => {
  it('never alerts on the first observation, even mid-streak', async () => {
    const m = vm();
    await evaluateLeaderDuty(net, vv(), m, entry(50, 55), 471, false);
    expect(alerts).toEqual([]);
    expect(m.prevProposals).toBe(50);
    expect(m.prevMissed).toBe(5);
    expect(m.missStreak).toBe(0);
  });

  it('warns at 3 in a row and pages at 5, exactly once each', async () => {
    const m = vm({ prevProposals: 55, prevMissed: 0 });
    const v = vv();
    await evaluateLeaderDuty(net, v, m, entry(55, 56), 471, false); // miss 1
    await evaluateLeaderDuty(net, v, m, entry(55, 57), 471, false); // miss 2
    expect(alerts).toEqual([]);
    await evaluateLeaderDuty(net, v, m, entry(55, 58), 471, false); // miss 3 -> warn
    expect(alerts.map((a) => a.severity)).toEqual(['warning']);
    await evaluateLeaderDuty(net, v, m, entry(55, 59), 471, false); // miss 4
    await evaluateLeaderDuty(net, v, m, entry(55, 60), 471, false); // miss 5 -> page
    expect(alerts.map((a) => [a.severity, a.pagerduty ?? null])).toEqual([
      ['warning', null],
      ['critical', 'trigger'],
    ]);
    expect(m.missStreak).toBe(5);
  });

  it('counts several misses inside one poll window slot-exactly', async () => {
    const m = vm({ prevProposals: 60, prevMissed: 1 });
    await evaluateLeaderDuty(net, vv(), m, entry(60, 65), 471, false); // 4 misses at once
    expect(m.missStreak).toBe(4);
    expect(alerts.map((a) => a.severity)).toEqual(['warning']); // >= 3 immediately
  });

  it('a successful proposal breaks the streak and resolves what was open', async () => {
    const m = vm({ prevProposals: 55, prevMissed: 5, missStreak: 5, trendAlerted: true, trendPaged: true });
    await evaluateLeaderDuty(net, vv(), m, entry(56, 61), 471, false);
    expect(m.missStreak).toBe(0);
    expect(alerts.map((a) => [a.severity, a.pagerduty ?? null])).toEqual([
      ['recovered', null],
      ['recovered', 'resolve'],
    ]);
    // trigger and resolve must pair on the same dedup key shape
    expect(alerts[1].dedupKey).toMatch(/^espressoduty:mainnet:.*:trend$/);
  });

  it('epoch rollover resets counters and closes open incidents without alarming', async () => {
    const m = vm({ lastEpoch: 470, missStreak: 4, trendAlerted: true, trendPaged: true, prevProposals: 1, prevMissed: 4 });
    await evaluateLeaderDuty(net, vv(), m, entry(10, 10), 471, false);
    expect(m.missStreak).toBe(0);
    expect(m.lastEpoch).toBe(471);
    expect(m.prevMissed).toBe(0);
    expect(alerts.every((a) => a.severity === 'recovered')).toBe(true);
    expect(alerts.some((a) => a.pagerduty === 'resolve')).toBe(true);
  });

  it('treats a backwards counter (stale failover backend) as a re-seed, not an event', async () => {
    const m = vm({ prevProposals: 60, prevMissed: 1 });
    await evaluateLeaderDuty(net, vv(), m, entry(55, 55), 471, false);
    expect(alerts).toEqual([]);
    expect(m.missStreak).toBe(0);
    expect(m.prevProposals).toBe(55);
  });

  it('stays quiet while the local node is the root cause, but keeps the baseline moving', async () => {
    const m = vm({ prevProposals: 55, prevMissed: 0 });
    await evaluateLeaderDuty(net, vv(), m, entry(55, 58), 471, true); // 3 misses, suppressed
    expect(alerts).toEqual([]);
    expect(m.missStreak).toBe(0);
    expect(m.prevMissed).toBe(3); // no catch-up alert after recovery
  });

  it('retries an alert whose delivery failed instead of counting it as sent', async () => {
    vi.mocked(sendAlert).mockImplementationOnce(async (ev: unknown) => {
      alerts.push(ev as (typeof alerts)[number]);
      return false; // webhook 500 etc.
    });
    const m = vm({ prevProposals: 55, prevMissed: 2, missStreak: 2 });
    const v = vv();
    await evaluateLeaderDuty(net, v, m, entry(55, 58), 471, false); // miss 3 -> send fails
    expect(m.trendAlerted).toBe(false);
    await evaluateLeaderDuty(net, v, m, entry(55, 59), 471, false); // miss 4 -> retried, delivered
    expect(m.trendAlerted).toBe(true);
    expect(alerts.filter((a) => a.severity === 'warning')).toHaveLength(2);
  });

  it('pairs the back-in-set recovery with the missing incident', async () => {
    const m = vm({ missingAlerted: true, missingPdTriggered: true, missingSince: Date.now() - 60000, prevProposals: 10, prevMissed: 0 });
    await evaluateLeaderDuty(net, vv(), m, entry(10, 10), 471, false);
    expect(m.missingAlerted).toBe(false);
    expect(m.missingPdTriggered).toBe(false);
    expect(alerts.map((a) => [a.severity, a.pagerduty ?? null])).toEqual([
      ['recovered', null],
      ['recovered', 'resolve'],
    ]);
    expect(alerts[1].dedupKey).toMatch(/:missing$/);
  });
});
