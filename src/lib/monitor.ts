// The polling engine. Started once from instrumentation.ts.
//
// Missed slots and votes come from Espresso's staking API
// (staking/nodes/active): per-validator leader-slot and vote counts for
// the current epoch, derived from the chain itself — the exact numbers
// stake.espresso.network shows. Deliberately NOT the node-subjective
// participation map (a backend that never saw your missed view reports a
// clean rate) and NOT the node's own timeouts_as_leader counter (a leader
// whose proposal never reached quorum may never see its own timer fire —
// verified live: chain said 1/56 missed, both other sources said 0). The
// chain is the only neutral witness. The local node's counters stay as a
// display backup for when the staking API is unreachable.
//
// Ground rules, same as monadoring: never alert on the first observation
// of anything; every bad alert has a matching recovery that only fires if
// the bad alert actually went out; repeated alerts respect a cooldown.

import { loadConfig, configuredChannels, shortKey, type NetworkConfig, type NetworkName } from './config';
import { EspressoClient, hexStakeToEsp, type ValidatorInfo } from './espresso';
import { sendAlert, type AlertEvent } from './alerts';
import { getStore, publish, pushSample, type NetworkView, type ValidatorView, type EndpointView } from './state';
import { loadPersisted, savePersisted, stateFilePath, type PersistedState } from './persist';

const cfg = loadConfig();

// ---------------------------------------------------------------------------
// Internal (non-view) state
// ---------------------------------------------------------------------------

interface ValidatorMachine {
  initialized: boolean;
  lastEpoch: number | null;
  /** Consecutive missed leader slots (chain-counted between polls). */
  missStreak: number;
  trendAlerted: boolean;
  trendPaged: boolean;
  trendSince: number | null;
  missingCount: number;
  missingAlerted: boolean;
  missingSince: number | null;
  missingPdTriggered: boolean;
  /** Chain counters at the previous poll; the deltas are the events. */
  prevProposals: number | null;
  prevMissed: number | null;
}

interface NetworkMachine {
  /** Identity reads (validators/:epoch, all-validators): the query service. */
  partClient: EspressoClient;
  /**
   * Status reads (height, time-since-last-decide). Local node first when
   * configured: for liveness, your own node's view is the one you want.
   */
  statusClient: EspressoClient;
  view: NetworkView;
  validators: Map<string, ValidatorMachine>;
  epoch: number | null;
  /** Base URL that served the last successful staking poll. */
  lastPartSource: string | null;
  /** When the staking API last answered; gates the local-metrics backup. */
  lastStakingOkAt: number | null;
  stallAlerted: boolean;
  stallSince: number | null;
  stallPdTriggered: boolean;
  identityLoaded: boolean;
}

interface LocalMachine {
  failCount: number;
  downAlerted: boolean;
  downSince: number | null;
  lagAlerted: boolean;
  initialized: boolean;
  /** Public query node used as the reference height for the lag check. */
  remoteBase: string | null;
  lastDecidedView: number | null;
  stuckAlerted: boolean;
  stuckSince: number | null;
  stuckPdTriggered: boolean;
  downPdTriggered: boolean;
}

const machines = new Map<NetworkName, NetworkMachine>();
let bootPersisted: PersistedState = {};
let localMachine: LocalMachine | null = null;
const cooldowns = new Map<string, number>();
const timers: NodeJS.Timeout[] = [];

function cooldownOk(key: string): boolean {
  const last = cooldowns.get(key) ?? 0;
  if (Date.now() - last < cfg.alertCooldownMin * 60_000) return false;
  cooldowns.set(key, Date.now());
  return true;
}

function dur(fromMs: number): string {
  const s = Math.max(1, Math.round((Date.now() - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * While the operator's node is down or lagging, participation alerts are
 * suppressed: the local-node alert is the root cause and a syncing node's
 * participation data is stale anyway. Recoveries still fire.
 */
function localNodeUnhealthy(): boolean {
  const ln = getStore().localNode;
  if (!ln) return false;
  return ln.reachable === false || (ln.lagBlocks !== null && ln.lagBlocks > cfg.heightLagBlocks);
}

function explorerLink(net: NetworkConfig): AlertEvent['link'] {
  return { label: 'Explorer', url: net.explorerUrl };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function initNetwork(net: NetworkConfig): NetworkMachine {
  const useLocal = net.name === 'mainnet' && cfg.localNodeUrl !== null;
  // Identity reads (validators, all-validators): public first, local last resort.
  const partEndpoints = useLocal ? [...net.queryNodes, cfg.localNodeUrl!] : net.queryNodes;
  // Status: local first, it is your node's liveness that matters.
  const statusEndpoints = useLocal ? [cfg.localNodeUrl!, ...net.queryNodes] : net.queryNodes;
  // The main poll reads the staking API; the dashboard's "src" tracks it.
  const displayEndpoints = useLocal ? [cfg.localNodeUrl!, ...net.stakingApis] : [...net.stakingApis];

  const view: NetworkView = {
    name: net.name,
    epoch: null,
    height: null,
    timeSinceLastDecide: null,
    lastPollAt: null,
    endpoints: displayEndpoints.map(
      (url): EndpointView => ({ url, isActive: false, isLocal: url === cfg.localNodeUrl }),
    ),
    validators: net.validators.map(
      (v): ValidatorView => ({
        key: v.key,
        label: v.label,
        account: null,
        stakeEsp: null,
        commission: null,
        delegatorCount: null,
        inActiveSet: null,
        vote: null,
        proposal: null,
        missedSlots: null,
        leaderSlots: null,
        missedLeaderSlots: null,
        epochMissCount: 0,
        health: 'unknown',
        samples: [],
      }),
    ),
  };
  const m: NetworkMachine = {
    partClient: new EspressoClient(partEndpoints),
    statusClient: new EspressoClient(statusEndpoints),
    view,
    validators: new Map(
      net.validators.map((v) => [
        v.key,
        {
          initialized: false,
          lastEpoch: null,
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
        } satisfies ValidatorMachine,
      ]),
    ),
    epoch: null,
    lastPartSource: null,
    lastStakingOkAt: null,
    stallAlerted: false,
    stallSince: null,
    stallPdTriggered: false,
    identityLoaded: false,
  };
  getStore().networks.set(net.name, view);
  machines.set(net.name, m);
  return m;
}

// ---------------------------------------------------------------------------
// Staking poll (the main signal)
// ---------------------------------------------------------------------------

interface ActiveNode {
  address: string;
  votes: number;
  eligible_votes: number;
  proposals: number;
  slots: number;
}

interface NodesActive {
  espresso_block: { epoch: number; block: number; timestamp: number };
  nodes: ActiveNode[];
}

/** Chain-derived per-validator counts for the current epoch. */
async function fetchNodesActive(net: NetworkConfig): Promise<{ data: NodesActive; source: string }> {
  let lastErr: unknown;
  for (const base of net.stakingApis) {
    try {
      const data = await EspressoClient.getFrom<NodesActive>(base, 'nodes/active');
      return { data, source: base };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function pollStaking(net: NetworkConfig): Promise<void> {
  const m = machines.get(net.name)!;
  let data: NodesActive;
  let source: string;
  try {
    ({ data, source } = await fetchNodesActive(net));
  } catch (err) {
    console.error(`[monitor] ${net.name} staking poll failed: ${err instanceof Error ? err.message : err}`);
    // Record the gap so the dashboard grid shows an honest empty cell.
    const t = Date.now();
    for (const vv of m.view.validators) pushSample(vv, { t, epoch: m.epoch, vote: null, proposal: null });
    publish();
    return;
  }
  m.lastPartSource = source;
  m.lastStakingOkAt = Date.now();
  for (const ev of m.view.endpoints) ev.isActive = ev.url === source;

  const epoch = data.espresso_block.epoch;
  if (m.epoch !== epoch) {
    m.epoch = epoch;
    // Also resolves 0x entries to their BLS key and fills in accounts.
    await refreshIdentity(net, m, epoch);
    m.identityLoaded = true;
  }
  m.view.epoch = epoch;
  m.view.lastPollAt = Date.now();

  const byAddress = new Map(data.nodes.map((n) => [n.address.toLowerCase(), n]));

  // Root-cause suppression: while the local node is down or lagging, its
  // outage is the alert; missed slots are the symptom. The chain still
  // counts them (the card stays honest), they are just not re-alerted.
  const suppressed = localNodeUnhealthy();

  for (const vv of m.view.validators) {
    const vm = m.validators.get(vv.key)!;
    // The staking API is keyed by L1 account: address entries match before
    // identity resolution, BLS entries right after it.
    const addr = (vv.account ?? (vv.key.startsWith('0x') ? vv.key : null))?.toLowerCase() ?? null;
    const entry = addr ? byAddress.get(addr) : undefined;

    if (!entry) {
      if (addr !== null) vv.inActiveSet = false;
      vv.vote = null;
      vv.proposal = null;
      pushSample(vv, { t: Date.now(), epoch, vote: null, proposal: null });
      await onValidatorMissing(net, m, vv, vm, epoch, suppressed);
    } else {
      vv.inActiveSet = true;
      // Raw counts, this epoch: nothing to hold, probe or reconstruct.
      const vote = entry.eligible_votes > 0 ? entry.votes / entry.eligible_votes : null;
      const proposal = entry.slots > 0 ? entry.proposals / entry.slots : null;
      vv.vote = vote;
      vv.proposal = proposal;
      vv.missedSlots = proposal === null ? null : 1 - proposal;
      vv.leaderSlots = entry.slots;
      vv.missedLeaderSlots = entry.slots - entry.proposals;
      vv.epochMissCount = vv.missedLeaderSlots;
      pushSample(vv, { t: Date.now(), epoch, vote, proposal });
      await evaluateLeaderDuty(net, vv, vm, entry, epoch, suppressed);
    }
    vv.health = healthOf(vv, vm);
    vm.lastEpoch = epoch;
    vm.initialized = true;
  }

  persistAll();
  publish();
  pingHeartbeat();
}

/**
 * Dead man's switch: a fire-and-forget GET after every successful poll
 * cycle. The receiving service (healthchecks.io, Uptime Kuma, ...) alerts
 * when the pings stop — the one failure espressoduty can't report itself.
 */
function pingHeartbeat(): void {
  if (!cfg.heartbeatUrl) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  fetch(cfg.heartbeatUrl, { signal: ctrl.signal, cache: 'no-store' })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/** Write every validator's counter + recent samples to STATE_FILE. */
function persistAll(): void {
  const out: PersistedState = {};
  for (const [name, m] of machines) {
    for (const vv of m.view.validators) {
      const vm = m.validators.get(vv.key)!;
      if (vm.lastEpoch === null) continue;
      out[`${name}:${vv.key}`] = {
        epoch: vm.lastEpoch,
        missCount: vm.missStreak,
        warnSent: vm.trendAlerted,
        critSent: vm.trendPaged,
        since: vm.trendSince,
        prevProposals: vm.prevProposals,
        prevMissed: vm.prevMissed,
        samples: vv.samples.slice(-50),
      };
    }
  }
  savePersisted(out);
}

/** A vote rate this low, while in the active set, means the node isn't really participating. */
const NEAR_ZERO_VOTE = 0.05;

/**
 * Health is leader-duty: missed slots drives it whenever proposal data
 * exists. Vote participation is informational only (it measures the QC
 * quorum race, i.e. latency, not node health).
 */
function healthOf(vv: ValidatorView, vm: ValidatorMachine): ValidatorView['health'] {
  if (vm.missingAlerted || (vm.missingCount >= 2 && vm.initialized)) return 'missing';
  if (vv.vote === null) return 'unknown';
  if (vv.proposal !== null) {
    const missed = 1 - vv.proposal;
    if (missed > cfg.missedCritical) return 'crit';
    if (missed > cfg.missedWarn) return 'warn';
    return 'ok';
  }
  // No leader-duty data yet: only a barely-voting active node is alarming.
  if (vv.vote < NEAR_ZERO_VOTE && vv.inActiveSet === true) return 'crit';
  return 'ok';
}

/**
 * Leader-duty state machine, driven by the chain's own counters: between
 * two polls, the missed count going up means missed leader slot(s), the
 * proposal count going up means successful proposal(s). Vote participation
 * is deliberately not alerted on: a non-leader vote is not on the critical
 * path (the QC closes at ~2/3 quorum without it), so it measures network
 * latency more than node health.
 *
 * consecutiveMissesWarn missed slots in a row notify the chat channels;
 * consecutiveMissesCrit pages PagerDuty; a successful proposal clears the
 * streak and sends the paired recovery. Baselines persist to STATE_FILE,
 * so even a miss that lands while espressoduty is restarting is caught.
 * An epoch rollover resets everything cleanly (counters restart with the
 * epoch by design — that is not an alert).
 */
async function evaluateLeaderDuty(
  net: NetworkConfig,
  vv: ValidatorView,
  vm: ValidatorMachine,
  entry: ActiveNode,
  epoch: number,
  suppressed: boolean,
): Promise<void> {
  const missed = entry.slots - entry.proposals;

  // Return from "not in the active set".
  if (vm.missingAlerted) {
    vm.missingAlerted = false;
    await sendAlert({
      severity: 'recovered',
      title: 'Back in the active set',
      lines: [`📍 ${vv.label}`, `⏱ gone ${vm.missingSince ? dur(vm.missingSince) : '?'}`],
      network: net.name,
      link: explorerLink(net),
    });
    if (vm.missingPdTriggered) {
      vm.missingPdTriggered = false;
      await sendAlert({
        severity: 'recovered',
        title: 'Back in the active set',
        lines: [`📍 ${vv.label}`],
        network: net.name,
        dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:missing`,
        pagerduty: 'resolve',
      });
    }
  }
  vm.missingCount = 0;
  vm.missingSince = null;

  if (vm.lastEpoch !== epoch) {
    // Rollover: the chain's counters restart with the epoch. Clean reset,
    // and close any incident left open so PagerDuty is not left dangling.
    if (vm.trendPaged) {
      vm.trendPaged = false;
      await sendAlert({
        severity: 'recovered',
        title: 'Epoch rollover',
        lines: [`📍 ${vv.label}`, `🔄 epoch ${epoch} · counters reset`],
        network: net.name,
        dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:trend`,
        pagerduty: 'resolve',
      });
    }
    if (vm.trendAlerted) {
      vm.trendAlerted = false;
      await sendAlert({
        severity: 'recovered',
        title: 'Epoch rollover',
        lines: [`📍 ${vv.label}`, `🔄 epoch ${epoch} · counters reset`],
        network: net.name,
      });
    }
    vm.missStreak = 0;
    vm.trendSince = null;
    vm.prevProposals = entry.proposals;
    vm.prevMissed = missed;
    vm.lastEpoch = epoch;
    return; // the first reading of a fresh epoch is a baseline, not an event
  }

  // First observation seeds the baseline silently: the card already shows
  // the exact count; alerts are about NEW misses on espressoduty's watch.
  if (vm.prevProposals === null || vm.prevMissed === null) {
    vm.prevProposals = entry.proposals;
    vm.prevMissed = missed;
    return;
  }

  const dProposed = entry.proposals - vm.prevProposals;
  const dMissed = missed - vm.prevMissed;
  vm.prevProposals = entry.proposals;
  vm.prevMissed = missed;

  // Failover between staking backends can serve momentarily stale counts;
  // a negative delta is a re-seed, never an event.
  if (dMissed < 0 || dProposed < 0) return;

  // Root cause (local node down or lagging) is already alerting; keep the
  // baseline moving but do not stack symptom alerts on top.
  if (suppressed) return;

  if (dMissed > 0 && dProposed === 0) {
    vm.missStreak += dMissed;
    if (vm.trendSince === null) vm.trendSince = Date.now();
    if (!vm.trendAlerted && vm.missStreak >= cfg.consecutiveMissesWarn && cooldownOk(`${net.name}:${vv.key}:trend`)) {
      vm.trendAlerted = true;
      await sendAlert({
        severity: 'warning',
        title: 'Missed leader slot',
        lines: [`📍 ${vv.label}`, `📉 ${vm.missStreak} in a row · ${missed}/${entry.slots} this epoch`],
        network: net.name,
        link: explorerLink(net),
      });
    }
    if (!vm.trendPaged && vm.missStreak >= cfg.consecutiveMissesCrit) {
      vm.trendPaged = true;
      await sendAlert({
        severity: 'critical',
        title: 'Missing leader slots',
        lines: [`📍 ${vv.label}`, `📉 ${vm.missStreak} in a row · ${missed}/${entry.slots} this epoch`],
        network: net.name,
        dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:trend`,
        pagerduty: 'trigger',
      });
    }
  } else if (dProposed > 0) {
    // Proposing again — even alongside a miss inside the same window, the
    // duty is currently being met, so the consecutive streak is broken.
    const wasAlerted = vm.trendAlerted;
    const wasPaged = vm.trendPaged;
    const since = vm.trendSince;
    vm.missStreak = 0;
    vm.trendAlerted = false;
    vm.trendPaged = false;
    vm.trendSince = null;
    if (wasAlerted) {
      await sendAlert({
        severity: 'recovered',
        title: 'Proposed a block',
        lines: [`📍 ${vv.label}`, `📈 ${entry.proposals}/${entry.slots} this epoch${since ? ` · ⏱ after ${dur(since)}` : ''}`],
        network: net.name,
      });
    }
    if (wasPaged) {
      await sendAlert({
        severity: 'recovered',
        title: 'Proposed a block',
        lines: [`📍 ${vv.label}`, `📈 ${entry.proposals}/${entry.slots} this epoch`],
        network: net.name,
        dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:trend`,
        pagerduty: 'resolve',
      });
    }
  }
  // both zero: no leader slot landed in this window, nothing to judge
}

async function onValidatorMissing(
  net: NetworkConfig,
  m: NetworkMachine,
  vv: ValidatorView,
  vm: ValidatorMachine,
  epoch: number,
  suppressed: boolean,
): Promise<void> {
  vm.missingCount += 1;
  if (!vm.initialized || suppressed) return;
  if (vm.missingCount < 2 || vm.missingAlerted) return; // require 2 consecutive polls to avoid flapping

  let classification = 'not in registry — check the configured key';
  try {
    const info = await m.partClient.findInAllValidators(epoch, vv.key);
    if (info) {
      classification = 'registered but inactive';
      vv.account = info.account;
    }
  } catch {
    classification = 'registry lookup failed';
  }

  vm.missingAlerted = true;
  vm.missingSince = Date.now();
  if (cooldownOk(`${net.name}:${vv.key}:missing`)) {
    await sendAlert({
      severity: 'critical',
      title: 'Not in the active set',
      lines: [`📍 ${vv.label}`, `🔎 ${classification}`],
      network: net.name,
      link: explorerLink(net),
    });
    // Dropping out of the set entirely pages, like a critical missed-slots streak.
    if (!vm.missingPdTriggered) {
      vm.missingPdTriggered = true;
      await sendAlert({
        severity: 'critical',
        title: 'Not in the active set',
        lines: [`📍 ${vv.label}`, `🔎 ${classification}`],
        network: net.name,
        dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:missing`,
        pagerduty: 'trigger',
      });
    }
  }
}

/** Resolve account / stake / commission / delegators for the watched keys (display only). */
async function refreshIdentity(net: NetworkConfig, m: NetworkMachine, epoch: number): Promise<void> {
  let byAccount: Record<string, ValidatorInfo>;
  try {
    byAccount = await m.partClient.validators(epoch);
  } catch (err) {
    console.error(`[monitor] ${net.name} validators(${epoch}) failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  // Entries given as an L1 address resolve to their BLS key here, once.
  for (const vv of m.view.validators) {
    if (!vv.key.startsWith('0x')) continue;
    const info = byAccount[vv.key];
    if (!info) continue;
    const oldKey = vv.key;
    vv.key = info.stake_table_key;
    const vm = m.validators.get(oldKey);
    if (vm) {
      m.validators.delete(oldKey);
      m.validators.set(vv.key, vm);
      // Counters persisted under the resolved key from a previous run.
      const p = bootPersisted[`${net.name}:${vv.key}`];
      if (p && !vm.initialized) {
        vm.lastEpoch = p.epoch;
        vm.missStreak = p.missCount ?? 0;
        vm.trendAlerted = !!p.warnSent;
        vm.trendPaged = !!p.critSent;
        vm.trendSince = p.since ?? null;
        vm.prevProposals = typeof p.prevProposals === 'number' ? p.prevProposals : null;
        vm.prevMissed = typeof p.prevMissed === 'number' ? p.prevMissed : null;
        if (vv.samples.length === 0 && Array.isArray(p.samples)) vv.samples.push(...p.samples.slice(-50));
      }
    }
    console.log(`[monitor] resolved ${oldKey} -> ${shortKey(vv.key)}`);
  }

  const byKey = new Map(Object.values(byAccount).map((v) => [v.stake_table_key, v]));
  for (const vv of m.view.validators) {
    const info = byKey.get(vv.key);
    if (!info) continue;
    vv.account = info.account;
    vv.commission = info.commission;
    vv.stakeEsp = hexStakeToEsp(info.stake);
    vv.delegatorCount = Object.keys(info.delegators).length;
  }
}

// ---------------------------------------------------------------------------
// Status poll (fast loop → live dashboard + chain liveness)
// ---------------------------------------------------------------------------

async function pollStatus(net: NetworkConfig): Promise<void> {
  const m = machines.get(net.name)!;
  try {
    const [height, tsld] = await Promise.all([m.statusClient.blockHeight(), m.statusClient.timeSinceLastDecide()]);
    m.view.height = height;
    m.view.timeSinceLastDecide = tsld;

    await checkStall(net, m, tsld);
  } catch (err) {
    console.error(`[monitor] ${net.name} status poll failed: ${err instanceof Error ? err.message : err}`);
  }
  publish();
}

async function checkStall(net: NetworkConfig, m: NetworkMachine, tsld: number): Promise<void> {
  if (tsld > cfg.decideStallSec) {
    if (m.stallSince === null) m.stallSince = Date.now();

    // Cross-check against the other endpoints before blaming the network:
    // if any other endpoint sees recent decides, the problem is this
    // endpoint (or our config/rate limit), not consensus.
    let secondarySeesProgress = false;
    for (let i = 0; i < m.statusClient.endpoints.length; i++) {
      if (i === m.statusClient.activeIndex) continue;
      try {
        const other = await EspressoClient.getFrom<number>(m.statusClient.endpoints[i], 'status/time-since-last-decide', 6000);
        if (other <= cfg.decideStallSec) {
          secondarySeesProgress = true;
          m.statusClient.activeIndex = i; // read from the endpoint that is seeing progress
          break;
        }
      } catch {
        /* endpoint also unreachable */
      }
    }

    if (!m.stallAlerted && cooldownOk(`${net.name}:stall`)) {
      m.stallAlerted = true;
      await sendAlert({
        severity: secondarySeesProgress ? 'warning' : 'critical',
        title: secondarySeesProgress ? 'Query endpoint stale' : 'Chain stalled',
        lines: secondarySeesProgress
          ? [`⏱ no decide for ${Math.round(tsld)}s`, '🔁 switched to a healthy endpoint']
          : [`⏱ no decide for ${Math.round(tsld)}s`, '🌐 no endpoint sees progress'],
        network: net.name,
        link: explorerLink(net),
      });
      if (!secondarySeesProgress && !m.stallPdTriggered) {
        m.stallPdTriggered = true;
        await sendAlert({
          severity: 'critical',
          title: 'Chain stalled',
          lines: [`⏱ no decide for ${Math.round(tsld)}s`],
          network: net.name,
          dedupKey: `espressoduty:${net.name}:stall`,
          pagerduty: 'trigger',
        });
      }
    }
  } else {
    if (m.stallAlerted) {
      m.stallAlerted = false;
      await sendAlert({
        severity: 'recovered',
        title: 'Decides resumed',
        lines: [`⏱ last decide ${Math.round(tsld)}s ago${m.stallSince ? ` · stalled ${dur(m.stallSince)}` : ''}`],
        network: net.name,
      });
      if (m.stallPdTriggered) {
        m.stallPdTriggered = false;
        await sendAlert({
          severity: 'recovered',
          title: 'Decides resumed',
          lines: [`⏱ last decide ${Math.round(tsld)}s ago`],
          network: net.name,
          dedupKey: `espressoduty:${net.name}:stall`,
          pagerduty: 'resolve',
        });
      }
    }
    m.stallSince = null;
  }
}

// ---------------------------------------------------------------------------
// Local node loop (LOCAL_NODE_URL)
// ---------------------------------------------------------------------------

interface NodeMetrics {
  lastDecidedView: number | null;
  leaderSlots: number | null;
  timeoutsAsLeader: number | null;
}

/**
 * The node's own Prometheus counters. The view counter proves consensus is
 * advancing (the stuck check); the leader counters are only a DISPLAY
 * BACKUP for when the staking API is unreachable — they are since node
 * start and can miss slots the node never knew it led (a leader whose
 * proposal never reached quorum may not see its own timer fire), so the
 * chain-derived counts always win while available.
 */
async function fetchNodeMetrics(): Promise<NodeMetrics | null> {
  if (!cfg.localNodeUrl) return null;
  const url = `${cfg.localNodeUrl.replace(/\/$/, '')}/status/metrics`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.statusPollTimeoutSec * 1000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    const grab = (name: string): number | null => {
      const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.eE+]+)$`, 'm'));
      return m ? Number(m[1]) : null;
    };
    return {
      lastDecidedView: grab('consensus_last_decided_view'),
      leaderSlots: grab('consensus_view_duration_as_leader_count'),
      timeoutsAsLeader: grab('consensus_number_of_timeouts_as_leader'),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pollLocalNode(): Promise<void> {
  if (!cfg.localNodeUrl || !localMachine) return;
  const store = getStore();
  const lm = localMachine;
  const view = store.localNode!;

  try {
    // Generous timeout: a node busy with consensus or an epoch rollover can
    // answer slowly without being down.
    const height = await EspressoClient.getFrom<number>(
      cfg.localNodeUrl,
      'status/block-height',
      cfg.statusPollTimeoutSec * 1000,
    );
    view.reachable = true;
    view.height = height;
    lm.failCount = 0;

    if (lm.downAlerted) {
      lm.downAlerted = false;
      await sendAlert({
        severity: 'recovered',
        title: 'Local node back',
        lines: [lm.downSince ? `⏱ down ${dur(lm.downSince)}` : '🔌 reachable again'],
      });
      if (lm.downPdTriggered) {
        lm.downPdTriggered = false;
        await sendAlert({
          severity: 'recovered',
          title: 'Local node back',
          lines: ['🔌 reachable again'],
          dedupKey: 'espressoduty:local:down',
          pagerduty: 'resolve',
        });
      }
    }
    lm.downSince = null;

    // Lag is measured against a public query node, not our own view of the
    // height — the main client may itself be reading from the local node.
    if (lm.remoteBase) {
      let remoteHeight: number | null = null;
      try {
        remoteHeight = await EspressoClient.getFrom<number>(
          lm.remoteBase,
          'status/block-height',
          cfg.statusPollTimeoutSec * 1000,
        );
      } catch {
        /* public node unreachable; skip the lag check this round */
      }
      if (remoteHeight !== null) {
        const lag = remoteHeight - height;
        view.lagBlocks = lag;
        if (lag > cfg.heightLagBlocks) {
          if (lm.initialized && !lm.lagAlerted && cooldownOk('local:lag')) {
            lm.lagAlerted = true;
            await sendAlert({
              severity: 'warning',
              title: 'Local node behind',
              lines: [`🐢 ${lag} blocks behind (local ${height} / network ${remoteHeight})`],
            });
          }
        } else if (lm.lagAlerted) {
          lm.lagAlerted = false;
          await sendAlert({
            severity: 'recovered',
            title: 'Local node caught up',
            lines: [`✅ height ${height}`],
          });
        }
      }
    }
    // --- Node metrics: the view counter as an instant liveness signal (no
    // need to wait for a leader slot to find out the node died), and the
    // leader counters as a card backup while the staking API is down.
    const metrics = await fetchNodeMetrics();
    if (metrics) {
      view.lastDecidedView = metrics.lastDecidedView;
      const mainnetM = machines.get('mainnet');
      const stakingFresh =
        mainnetM?.lastStakingOkAt !== null &&
        mainnetM !== undefined &&
        Date.now() - mainnetM.lastStakingOkAt! < cfg.pollIntervalSec * 3 * 1000;
      const firstVv = mainnetM?.view.validators[0];
      if (!stakingFresh && firstVv && metrics.leaderSlots !== null) {
        firstVv.leaderSlots = metrics.leaderSlots;
        firstVv.missedLeaderSlots = metrics.timeoutsAsLeader ?? 0;
      }

      if (metrics.lastDecidedView !== null) {
        const advanced = lm.lastDecidedView === null || metrics.lastDecidedView > lm.lastDecidedView;
        // Only count "stuck" while the network itself is progressing;
        // a chain halt is the stall alert's job, not this one's.
        const networkOk =
          mainnetM?.view.timeSinceLastDecide !== null &&
          mainnetM !== undefined &&
          mainnetM.view.timeSinceLastDecide! <= cfg.decideStallSec;
        if (advanced) {
          if (lm.stuckAlerted) {
            lm.stuckAlerted = false;
            await sendAlert({
              severity: 'recovered',
              title: 'Node moving again',
              lines: [
                `👁 view ${metrics.lastDecidedView}${lm.stuckSince ? ` · ⏱ stuck ${dur(lm.stuckSince)}` : ''}`,
              ],
            });
            if (lm.stuckPdTriggered) {
              lm.stuckPdTriggered = false;
              await sendAlert({
                severity: 'recovered',
                title: 'Node moving again',
                lines: [`👁 view ${metrics.lastDecidedView}`],
                dedupKey: 'espressoduty:local:stuck',
                pagerduty: 'resolve',
              });
            }
          }
          lm.stuckSince = null;
          view.stuck = false;
        } else if (networkOk) {
          if (lm.stuckSince === null) lm.stuckSince = Date.now();
          const stuckFor = Date.now() - lm.stuckSince;
          // A view pausing for seconds is routine; only a sustained freeze
          // while the network progresses is worth waking anyone for.
          if (stuckFor >= cfg.stuckAfterMin * 60_000) {
            view.stuck = true;
            if (lm.initialized && !lm.stuckAlerted && cooldownOk('local:stuck')) {
              lm.stuckAlerted = true;
              await sendAlert({
                severity: 'critical',
                title: 'Node stuck',
                lines: [
                  `👁 view frozen at ${metrics.lastDecidedView} for ${dur(lm.stuckSince)}`,
                  '🌐 network is progressing, your node is not',
                ],
              });
            }
            if (lm.stuckAlerted && !lm.stuckPdTriggered && stuckFor >= cfg.localDownPageMin * 60_000) {
              lm.stuckPdTriggered = true;
              await sendAlert({
                severity: 'critical',
                title: 'Node stuck',
                lines: [`👁 view frozen at ${metrics.lastDecidedView} for ${dur(lm.stuckSince)}`],
                dedupKey: 'espressoduty:local:stuck',
                pagerduty: 'trigger',
              });
            }
          }
        }
        lm.lastDecidedView = metrics.lastDecidedView;
      }
    }

    lm.initialized = true;
  } catch {
    lm.failCount += 1;
    // One slow or dropped response never counts as down: a busy node can
    // miss a probe. Declare down only after N consecutive failures.
    if (lm.failCount >= cfg.localDownFails) {
      view.reachable = false;
      view.lagBlocks = null;
      if (lm.downSince === null) lm.downSince = Date.now();
      if (lm.initialized && !lm.downAlerted && cooldownOk('local:down')) {
        lm.downAlerted = true;
        await sendAlert({
          severity: 'critical',
          title: 'Local node down',
          lines: [`🔌 ${cfg.localNodeUrl}`, `📉 ${lm.failCount} failed checks`],
        });
      }
      // Chat hears about it once, immediately; PagerDuty only if the node
      // has not come back within the escalation window.
      if (
        lm.downAlerted &&
        !lm.downPdTriggered &&
        Date.now() - lm.downSince >= cfg.localDownPageMin * 60_000
      ) {
        lm.downPdTriggered = true;
        await sendAlert({
          severity: 'critical',
          title: 'Local node down',
          lines: [`⏱ down ${dur(lm.downSince)}`],
          dedupKey: 'espressoduty:local:down',
          pagerduty: 'trigger',
        });
      }
    }
  }
  publish();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let started = false;

export function startMonitoring(): void {
  if (started) return;
  started = true;

  const store = getStore();
  store.channels = configuredChannels(cfg);

  if (cfg.networks.length === 0) {
    console.warn('[monitor] no validators configured — set MAINNET_VALIDATORS (see .env.example)');
  }

  // Continue where the last run left off: counters and grid samples come
  // back from STATE_FILE, so a restart cannot reset a drop streak.
  console.log(`[persist] state file: ${stateFilePath()}`);
  const persisted = loadPersisted();
  bootPersisted = persisted;
  for (const net of cfg.networks) {
    const m = initNetwork(net);
    for (const vv of m.view.validators) {
      const p = persisted[`${net.name}:${vv.key}`];
      if (!p) continue;
      const vm = m.validators.get(vv.key)!;
      vm.lastEpoch = p.epoch;
      vm.missStreak = p.missCount ?? 0;
      vm.trendAlerted = !!p.warnSent;
      vm.trendPaged = !!p.critSent;
      vm.trendSince = p.since ?? null;
      // Epoch-scoped: the first poll's rollover branch clears them if stale.
      vm.prevProposals = typeof p.prevProposals === 'number' ? p.prevProposals : null;
      vm.prevMissed = typeof p.prevMissed === 'number' ? p.prevMissed : null;
      if (Array.isArray(p.samples)) vv.samples.push(...p.samples.slice(-50));
    }
    void pollStaking(net);
    void pollStatus(net);
    timers.push(setInterval(() => void pollStaking(net), cfg.pollIntervalSec * 1000));
    timers.push(setInterval(() => void pollStatus(net), cfg.statusPollIntervalSec * 1000));
  }

  if (cfg.localNodeUrl) {
    const mainnet = cfg.networks.find((n) => n.name === 'mainnet');
    localMachine = {
      failCount: 0,
      downAlerted: false,
      downSince: null,
      lagAlerted: false,
      initialized: false,
      remoteBase: mainnet?.queryNodes[0] ?? null,
      lastDecidedView: null,
      stuckAlerted: false,
      stuckSince: null,
      stuckPdTriggered: false,
      downPdTriggered: false,
    };
    store.localNode = {
      url: cfg.localNodeUrl,
      reachable: null,
      height: null,
      lagBlocks: null,
      lastDecidedView: null,
      stuck: false,
    };
    void pollLocalNode();
    timers.push(setInterval(() => void pollLocalNode(), Math.max(cfg.statusPollIntervalSec, 15) * 1000));
  }

  const watched = cfg.networks
    .map((n) => `${n.validators.map((v) => v.label).join(', ')} (${n.name})`)
    .join(', ');
  void sendAlert({
    severity: 'info',
    title: 'espressoduty started',
    lines: [
      watched ? `📡 ${watched}` : '📡 no validators configured',
      `⚙️ poll ${cfg.pollIntervalSec}s · warn ${cfg.consecutiveMissesWarn} · page ${cfg.consecutiveMissesCrit}${cfg.localNodeUrl ? ' · local node' : ''}`,
      `🔔 ${store.channels.join(', ') || 'none'}`,
    ],
  });
}

export async function stopMonitoring(reason: string): Promise<void> {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  // Shutdown notification races a 5s timeout so signals can't hang the exit.
  await Promise.race([
    sendAlert({
      severity: 'warning',
      title: 'espressoduty stopped',
      lines: [`🛑 received ${reason}`],
    }),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}
