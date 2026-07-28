// Grid cell classification. The card, the alerts and the grid must all
// read the same chain counters — a cell may only go red for a real miss.

import { describe, it, expect } from 'vitest';
import { sampleKind, type PollSample } from '../src/lib/state';

function sample(over: Partial<PollSample> = {}): PollSample {
  return { t: 1, epoch: 496, vote: 0.3, proposal: 0.98, missed: 1, slots: 54, ...over };
}

describe('sampleKind', () => {
  it('is red when the miss counter grew', () => {
    expect(sampleKind(sample({ missed: 1, slots: 53 }), sample({ missed: 2, slots: 54 }))).toBe('missed');
  });

  it('is green while the counter holds, even if the ratio dipped', () => {
    // Live cause of "3 reds but 1/54 on the card": the staking cache serves
    // backends at different blocks, so a later poll can report an EARLIER
    // state (54/55 -> 53/54). The ratio falls; nothing was missed.
    const prev = sample({ missed: 1, slots: 55, proposal: 54 / 55 });
    const now = sample({ missed: 1, slots: 54, proposal: 53 / 54 });
    expect(now.proposal! < prev.proposal!).toBe(true); // the ratio really did dip
    expect(sampleKind(prev, now)).toBe('ok');
  });

  it('is green on a successful proposal', () => {
    expect(sampleKind(sample({ missed: 1, slots: 54 }), sample({ missed: 1, slots: 55 }))).toBe('ok');
  });

  it('treats the first poll of an epoch as a baseline, not a miss', () => {
    expect(sampleKind(sample({ epoch: 495, missed: 4 }), sample({ epoch: 496, missed: 0 }))).toBe('ok');
    expect(sampleKind(undefined, sample({ missed: 3 }))).toBe('ok');
  });

  it('keeps the empty and idle states', () => {
    expect(sampleKind(sample(), sample({ vote: null, proposal: null }))).toBe('nodata');
    expect(sampleKind(sample(), sample({ proposal: null }))).toBe('idle');
  });

  it('never colors a miss from samples written before the counters existed', () => {
    const legacy = { t: 1, epoch: 496, vote: 0.3, proposal: 0.99 };
    expect(sampleKind(legacy, sample({ proposal: 0.5, missed: undefined }))).toBe('ok');
  });
});
