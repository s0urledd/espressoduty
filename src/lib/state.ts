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
   * The delegator-facing headline: 1 - proposal_participation, same formula
   * as stake.espresso.network. Always numeric after the first poll: with no
   * proposal data for the epoch (proposal === null) nothing is known to be
   * missed, so it reads 0. Alerting keys off real proposal data only.
   */
  missedSlots: number | null;
  /** Exact counts from the node's own metrics (since node start); null without a local node. */
  leaderSlots: number | null;
  missedLeaderSlots: number | null;
  /** Miss events observed this epoch (either data path). */
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
