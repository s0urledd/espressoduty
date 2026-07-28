// In-memory monitoring state shared between the polling engine (instrumentation)
// and the app's API routes. No database: process restart starts clean, which is
// also why the engine never alerts on the first poll of anything.
//
// The store lives on globalThis because Next.js can evaluate this module in
// more than one bundle (instrumentation vs route handlers).

import type { NetworkName } from './config';

export type ValidatorHealth = 'ok' | 'warn' | 'crit' | 'missing' | 'unknown';

/**
 * One participation poll (POLL_INTERVAL_SEC apart). Both fields null =
 * the poll produced no data at all. proposal is the cumulative leader-duty
 * rate; the grid colors each poll window by how it CHANGED (rose = you
 * proposed, fell = you missed a slot, flat = no leader slot observed).
 * Espresso has no per-slot event stream, so this per-poll derivative is
 * the honest closest thing.
 */
export interface PollSample {
  t: number;
  epoch: number | null;
  vote: number | null;
  proposal: number | null;
  /** Chain counters for the epoch; absent on samples written before 2026-07. */
  missed?: number;
  slots?: number;
}

export type SampleKind = 'ok' | 'missed' | 'idle' | 'nodata';

/**
 * How one grid cell reads. Red only when the chain's integer miss counter
 * ACTUALLY grew since the previous poll of the same epoch — the staking
 * API is a cache over backends at different blocks (block numbers observed
 * going backwards between consecutive requests), so a dip in the
 * proposals/slots ratio proves nothing on its own. Counters that only go
 * up are the same source of truth the card and the alerts use.
 */
export function sampleKind(prev: PollSample | undefined, s: PollSample): SampleKind {
  if (s.vote === null && s.proposal === null) return 'nodata';
  if (s.proposal === null) return 'idle';
  const sameEpoch = prev !== undefined && prev.epoch === s.epoch;
  if (sameEpoch && typeof prev.missed === 'number' && typeof s.missed === 'number') {
    return s.missed > prev.missed ? 'missed' : 'ok';
  }
  // No comparable counter (first poll of an epoch, or a sample from an
  // older build): a baseline, never an event.
  return 'ok';
}

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
  /** Secondary/technical signal. */
  vote: number | null;
  /** Raw proposal participation rate, 0.0-1.0. */
  proposal: number | null;
  /**
   * The delegator-facing headline: 1 - proposals/slots, the same number
   * stake.espresso.network shows (both read the chain-derived staking API).
   */
  missedSlots: number | null;
  /**
   * Chain-derived counts for this epoch (staking API). While the staking
   * API is unreachable, the local node's own counters fill in as a backup.
   */
  leaderSlots: number | null;
  missedLeaderSlots: number | null;
  /** Missed slots this epoch (same as missedLeaderSlots; kept for the API). */
  epochMissCount: number;
  health: ValidatorHealth;
  /** Ring buffer of recent polls for the dashboard grid. */
  samples: PollSample[];
}

export const MAX_SAMPLES = 50;

export function pushSample(view: ValidatorView, sample: PollSample): void {
  view.samples.push(sample);
  if (view.samples.length > MAX_SAMPLES) view.samples.splice(0, view.samples.length - MAX_SAMPLES);
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
  validators: ValidatorView[];
  endpoints: EndpointView[];
  lastPollAt: number | null;
}

export interface LocalNodeView {
  url: string;
  reachable: boolean | null;
  height: number | null;
  lagBlocks: number | null;
  /** consensus_last_decided_view from the node's metrics, when available. */
  lastDecidedView: number | null;
  /** True while the node responds but its view number is not advancing. */
  stuck: boolean;
  /** The node's build tag (consensus_version desc, e.g. "20260722"). */
  version: string | null;
  /** The build tag Espresso's own public infra runs — the reference. */
  refVersion: string | null;
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
  // The operator's node address is internal topology; the browser only
  // needs to know that a local source exists, so LOCAL_NODE_URL never
  // leaves the server.
  return {
    startedAt: s.startedAt,
    now: Date.now(),
    networks: [...s.networks.values()].map((n) => ({
      ...n,
      endpoints: n.endpoints.map((e) => (e.isLocal ? { ...e, url: 'local' } : e)),
    })),
    localNode: s.localNode ? { ...s.localNode, url: 'local' } : null,
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
