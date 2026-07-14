// Restart-durable alert counters. Only the last value per validator is
// kept, in one tiny JSON file, so a bot restart continues the
// consecutive-drop streak instead of starting over. Everything else
// (samples, identity, health) is fine to rebuild in memory.

import type { PollSample } from './state';

// Required via eval so webpack's edge bundle of instrumentation.ts does not
// try to resolve a node builtin it will never execute (the monitor only
// runs in the nodejs runtime).
const { readFileSync, writeFileSync, renameSync } = eval('require')('fs') as typeof import('fs');
const { resolve } = eval('require')('path') as typeof import('path');

export interface PersistedCounter {
  epoch: number;
  /** Consecutive missed leader slots. */
  missCount: number;
  warnSent: boolean;
  critSent: boolean;
  /** Unix ms when the current miss streak started, for recovery durations. */
  since: number | null;
  /**
   * The chain's counters at the last poll: a miss that lands while
   * espressoduty is restarting still shows up as a delta on the next poll.
   */
  prevProposals?: number | null;
  prevMissed?: number | null;
  /** Last ~50 polls so the dashboard grid survives restarts too. */
  samples: PollSample[];
}

/** Keyed `${network}:${blsKey}`. */
export type PersistedState = Record<string, PersistedCounter>;

// Anchor relative paths to the directory the process was LAUNCHED from
// (PWD), not the runtime cwd: Next's standalone server chdirs into
// .next/standalone, which is wiped on every build — the one place a
// restart-durable file must not live.
const file = resolve(process.env.PWD || process.cwd(), process.env.STATE_FILE?.trim() || 'state.json');

export function stateFilePath(): string {
  return file;
}

export function loadPersisted(): PersistedState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as PersistedState) : {};
  } catch {
    return {}; // first run, unreadable, or corrupt: start clean
  }
}

export function savePersisted(state: PersistedState): void {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, file); // atomic on the same filesystem
  } catch (err) {
    console.error(`[persist] could not write ${file}: ${err instanceof Error ? err.message : err}`);
  }
}
