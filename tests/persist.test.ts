// STATE_FILE round-trip: what a restart reads back must be what the last
// poll wrote, and a corrupt or missing file must mean a clean start, never
// a crash.

import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'espressoduty-test-'));
process.env.STATE_FILE = join(dir, 'state.json');
process.env.PWD = dir;
const { savePersisted, loadPersisted, stateFilePath } = await import('../src/lib/persist');

const counters = {
  'mainnet:BLS_VER_KEY~abc': {
    epoch: 471,
    missCount: 2,
    warnSent: true,
    critSent: false,
    since: 1784000000000,
    prevProposals: 60,
    prevMissed: 1,
    samples: [{ t: 1784000000000, epoch: 471, vote: 0.67, proposal: 0.98 }],
  },
};

describe('persist', () => {
  it('anchors the file to STATE_FILE', () => {
    expect(stateFilePath()).toBe(join(dir, 'state.json'));
  });

  it('round-trips counters and samples', () => {
    savePersisted(counters);
    expect(loadPersisted()).toEqual(counters);
  });

  it('leaves no tmp file behind (atomic write)', () => {
    savePersisted(counters);
    expect(existsSync(`${stateFilePath()}.tmp`)).toBe(false);
  });

  it('returns a clean slate for a corrupt file', () => {
    writeFileSync(stateFilePath(), '{not json');
    expect(loadPersisted()).toEqual({});
  });
});
