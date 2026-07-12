// In-memory monitoring state shared between the polling engine (instrumentation)
// and the app's API routes. No database: process restart starts clean, which is
// also why the engine never alerts on the first poll of anything.
//
// The store lives on globalThis because Next.js can evaluate this module in
// more than one bundle (instrumentation vs route handlers).

import type { NetworkName } from './config';

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
  /** Shown on the dashboard only; proposal misses never page. */
  proposal: number | null;
  health: ValidatorHealth;
}

export interface EndpointView {
  url: string;
  isActive: boolean;
  isLocal: boolean;
}

export interface NetworkView {
  name: NetworkName;
  epoch: number | null;
  height: number | null;
  timeSinceLastDecide: number | null;
  successRate: number | null;
  validators: ValidatorView[];
  endpoints: EndpointView[];
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
