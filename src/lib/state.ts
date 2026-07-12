// In-memory monitoring state shared between the polling engine (instrumentation)
// and the app's API routes. No database: process restart starts clean, which is
// also why the engine never alerts on the first poll of anything.
//
// The store lives on globalThis because Next.js can evaluate this module in
// more than one bundle (instrumentation vs route handlers).

import type { NetworkName } from './config';

export interface ParticipationSample {
  /** Unix ms of the poll. */
  t: number;
  epoch: number;
  vote: number | null;
  /** null = not in the proposal map yet (no leader slots this epoch). */
  proposal: number | null;
}

export type ValidatorHealth = 'ok' | 'warn' | 'crit' | 'missing' | 'unknown';

export interface ValidatorView {
  key: string;
  label: string;
  account: string | null;
  /** Whole ESP, display only. */
  stakeEsp: number | null;
  /** Basis points. */
  commission: number | null;
  delegatorCount: number | null;
  inActiveSet: boolean | null;
  vote: number | null;
  proposal: number | null;
  health: ValidatorHealth;
  samples: ParticipationSample[];
}

export interface EndpointView {
  url: string;
  healthy: boolean | null;
  lastHeight: number | null;
  isPrimary: boolean;
  isActive: boolean;
}

export interface EpochSummary {
  epoch: number;
  /** Per watched validator: final rates at rollover. */
  finals: { key: string; label: string; vote: number | null; proposal: number | null; stakeEsp: number | null }[];
}

export interface NetworkView {
  name: NetworkName;
  epoch: number | null;
  height: number | null;
  timeSinceLastDecide: number | null;
  successRate: number | null;
  suppressedUntil: number | null;
  validators: ValidatorView[];
  endpoints: EndpointView[];
  epochHistory: EpochSummary[];
  lastPollAt: number | null;
}

export interface LocalNodeView {
  url: string;
  reachable: boolean | null;
  height: number | null;
  lagBlocks: number | null;
}

export interface Snapshot {
  startedAt: number;
  now: number;
  networks: NetworkView[];
  localNode: LocalNodeView | null;
  channels: string[];
}

type Listener = (snapshot: Snapshot) => void;

export interface Store {
  startedAt: number;
  channels: string[];
  networks: Map<NetworkName, NetworkView>;
  localNode: LocalNodeView | null;
  listeners: Set<Listener>;
  maxSamples: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __espressoduty: Store | undefined;
}

export function getStore(): Store {
  if (!globalThis.__espressoduty) {
    globalThis.__espressoduty = {
      startedAt: Date.now(),
      channels: [],
      networks: new Map(),
      localNode: null,
      listeners: new Set(),
      maxSamples: 1440,
    };
  }
  return globalThis.__espressoduty;
}

export function snapshot(): Snapshot {
  const s = getStore();
  return {
    startedAt: s.startedAt,
    now: Date.now(),
    networks: [...s.networks.values()],
    localNode: s.localNode,
    channels: s.channels,
  };
}

/** Push the current snapshot to every connected SSE client. */
export function publish(): void {
  const s = getStore();
  if (s.listeners.size === 0) return;
  const snap = snapshot();
  for (const fn of s.listeners) {
    try {
      fn(snap);
    } catch {
      s.listeners.delete(fn);
    }
  }
}

export function subscribe(fn: Listener): () => void {
  const s = getStore();
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

export function pushSample(view: ValidatorView, sample: ParticipationSample, max: number): void {
  view.samples.push(sample);
  if (view.samples.length > max) view.samples.splice(0, view.samples.length - max);
}
