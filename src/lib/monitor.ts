// The polling engine. Started once from instrumentation.ts.
//
// Espresso exposes participation as a per-epoch *rate* (0.0-1.0), not a
// per-block signed/missed stream, and each node reports its own subjective
// view of it. Participation is therefore read from the PUBLIC query nodes
// (closest to what delegators see); the local node, when configured, is
// used for status and liveness, and only as a last-resort fallback for
// participation.
//
// Ground rules, same as monadoring: never alert on the first observation
// of anything; every bad alert has a matching recovery that only fires if
// the bad alert actually went out; repeated alerts respect a cooldown.

import { loadConfig, configuredChannels, shortKey, type NetworkConfig, type NetworkName } from './config';
import { EspressoClient, hexStakeToEsp, type ParticipationMap, type ValidatorInfo } from './espresso';
import { sendAlert, type AlertEvent } from './alerts';
import { getStore, publish, pushSample, type NetworkView, type ValidatorView, type EndpointView } from './state';
import { loadPersisted, savePersisted, stateFilePath, type PersistedState } from './persist';

const cfg = loadConfig();

// ---------------------------------------------------------------------------
// Internal (non-view) state
// ---------------------------------------------------------------------------

interface ValidatorMachine {
  initialized: boolean;
  /** Last same-epoch vote sample, for the red/green poll judgement. */
  lastVote: number | null;
  lastEpoch: number | null;
  /** Consecutive red polls: the epoch average failed to climb. */
  redStreak: number;
  trendAlerted: boolean;
  trendPaged: boolean;
  trendSince: number | null;
  missingCount: number;
  missingAlerted: boolean;
  missingSince: number | null;
  missingPdTriggered: boolean;
  /**
   * Last proposal rate observed in the current epoch. Once a real value has
   * been seen, a single poll whose map momentarily lacks the key must not
   * flip the card back to a dash. Reset at epoch rollover.
   */
  heldProposal: number | null;
}

interface NetworkMachine {
  /**
   * Participation and identity reads. Public query nodes FIRST: the
   * participation maps are subjective to the serving node, and an
   * operator's own node (especially after a restart) reports a view of
   * itself that can diverge wildly from what delegators see. The local
   * node is only the last-resort fallback here.
   */
  partClient: EspressoClient;
  /**
   * Status reads (height, time-since-last-decide). Local node first when
   * configured: for liveness, your own node's view is the one you want.
   */
  statusClient: EspressoClient;
  view: NetworkView;
  validators: Map<string, ValidatorMachine>;
  epoch: number | null;
  /** Base URL that served the last successful participation poll. */
  lastPartSource: string | null;
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
}

const machines = new Map<NetworkName, NetworkMachine>();
let localMachine: LocalMachine | null = null;
const cooldowns = new Map<string, number>();
const timers: NodeJS.Timeout[] = [];

function cooldownOk(key: string): boolean {
  const last = cooldowns.get(key) ?? 0;
  if (Date.now() - last < cfg.alertCooldownMin * 60_000) return false;
  cooldowns.set(key, Date.now());
  return true;
}

function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(2)}%`;
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
  // Participation itself is fetched per poll from ONE source picked by
  // participationSources(); the dashboard's "src" tracks that choice.
  const displayEndpoints = useLocal ? [cfg.localNodeUrl!, ...net.queryNodes] : net.queryNodes;

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
          lastVote: null,
          lastEpoch: null,
          redStreak: 0,
          trendAlerted: false,
          trendPaged: false,
          trendSince: null,
          missingCount: 0,
          missingAlerted: false,
          missingSince: null,
          missingPdTriggered: false,
          heldProposal: null,
        } satisfies ValidatorMachine,
      ]),
    ),
    epoch: null,
    lastPartSource: null,
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
// Participation poll (the main signal)
// ---------------------------------------------------------------------------

/**
 * Source order for one participation poll. The whole poll is served by a
 * single base URL so vote and proposal can never come from two different
 * nodes' subjective maps (that mismatch is what made proposal values flick
 * between a dash and a number). Prefer the local node when it is confirmed
 * reachable and in sync; otherwise the public query nodes, in order. An
 * out-of-sync local node is excluded entirely: its maps are stale.
 */
function participationSources(net: NetworkConfig): string[] {
  if (net.name === 'mainnet' && cfg.localNodeUrl) {
    const ln = getStore().localNode;
    const localInSync =
      ln?.reachable === true && ln.lagBlocks !== null && ln.lagBlocks <= cfg.heightLagBlocks;
    if (localInSync) return [cfg.localNodeUrl, ...net.queryNodes];
  }
  return [...net.queryNodes];
}

interface ParticipationBatch {
  stakeTable: Awaited<ReturnType<EspressoClient['currentStakeTable']>>;
  voteMap: ParticipationMap;
  proposalMap: ParticipationMap;
  source: string;
}

async function fetchParticipation(net: NetworkConfig): Promise<ParticipationBatch> {
  let lastErr: unknown;
  for (const base of participationSources(net)) {
    try {
      const [stakeTable, voteMap, proposalMap] = await Promise.all([
        EspressoClient.getFrom<ParticipationBatch['stakeTable']>(base, 'node/stake-table/current'),
        EspressoClient.getFrom<ParticipationMap>(base, 'node/participation/vote/current'),
        EspressoClient.getFrom<ParticipationMap>(base, 'node/participation/proposal/current'),
      ]);
      return { stakeTable, voteMap, proposalMap, source: base };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * The public query URL is a load balancer over nodes with differing
 * subjective state: proposal tracking is live-only, so some backends serve
 * an EMPTY proposal map for an epoch that others have fully tracked
 * (observed live: map sizes 0,0,0,96,96,0 across six consecutive requests
 * to the same URL). When the pinned source has no proposal data, probe the
 * other sources (re-hitting the balancer too) for a backend that does.
 * Vote stays from the pinned source; only proposal is taken from the probe
 * and it feeds the per-epoch hold, so the value appears once and sticks.
 */
async function probeProposal(net: NetworkConfig): Promise<ParticipationMap | null> {
  const bases = participationSources(net);
  const attempts = bases.flatMap((b) => (b === cfg.localNodeUrl ? [b] : [b, b]));
  for (const base of attempts) {
    try {
      const map = await EspressoClient.getFrom<ParticipationMap>(
        base,
        'node/participation/proposal/current',
        8000,
      );
      if (Object.keys(map).length > 0) return map;
    } catch {
      /* try the next backend */
    }
  }
  return null;
}

async function pollParticipation(net: NetworkConfig): Promise<void> {
  const m = machines.get(net.name)!;
  let batch: ParticipationBatch;
  try {
    batch = await fetchParticipation(net);
  } catch (err) {
    console.error(`[monitor] ${net.name} participation poll failed: ${err instanceof Error ? err.message : err}`);
    // Record the gap so the dashboard grid shows an honest empty cell.
    const t = Date.now();
    for (const vv of m.view.validators) pushSample(vv, { t, epoch: m.epoch, vote: null });
    publish();
    return;
  }
  const { stakeTable, voteMap, source } = batch;
  let { proposalMap } = batch;
  m.lastPartSource = source;
  for (const ev of m.view.endpoints) ev.isActive = ev.url === source;

  // Pinned source has no proposal tracking for this epoch: look for a
  // backend that does, but only while a watched key still lacks a held
  // value (once held, the probe would add nothing).
  if (Object.keys(proposalMap).length === 0) {
    const needProposal = m.view.validators.some((vv) => m.validators.get(vv.key)!.heldProposal === null);
    if (needProposal) {
      const probed = await probeProposal(net);
      if (probed) proposalMap = probed;
    }
  }

  const epoch = stakeTable.epoch;
  const stakeByKey = new Map(
    stakeTable.stake_table.map((e) => [e.stake_table_entry.stake_key, e.stake_table_entry.stake_amount]),
  );

  if (m.epoch !== null && epoch > m.epoch) {
    // Rollover: rates reset, per-epoch state goes with them. The red-poll
    // streak deliberately survives: a node missing views across a rollover
    // is still missing views. The boundary poll itself is neutral (no
    // same-epoch trend to judge).
    for (const vm of m.validators.values()) vm.heldProposal = null;
  }
  if (m.epoch !== epoch) {
    m.epoch = epoch;
    await refreshIdentity(net, m, epoch);
    m.identityLoaded = true;
  }
  m.view.epoch = epoch;
  m.view.lastPollAt = Date.now();

  // Root-cause suppression: while the local node is down or lagging, its
  // outage is the alert; participation dips are the symptom.
  const suppressed = localNodeUnhealthy();

  for (const vv of m.view.validators) {
    const vm = m.validators.get(vv.key)!;
    const vote = Object.prototype.hasOwnProperty.call(voteMap, vv.key) ? voteMap[vv.key] : null;
    const inProposalMap = Object.prototype.hasOwnProperty.call(proposalMap, vv.key);
    // Key-in-map presence is the source of truth for dash vs number, but a
    // value seen earlier this epoch is held so one poll without the key
    // cannot flip the card back to a dash.
    if (inProposalMap) vm.heldProposal = proposalMap[vv.key];
    const proposal = inProposalMap ? proposalMap[vv.key] : vm.heldProposal;

    vv.inActiveSet = stakeByKey.has(vv.key);
    const stakeHex = stakeByKey.get(vv.key);
    if (stakeHex) vv.stakeEsp = hexStakeToEsp(stakeHex);
    vv.vote = vote;
    vv.proposal = proposal;
    // Espresso's headline metric, always numeric: with no proposal data for
    // the key this epoch there are no known missed slots, which is 0%.
    // Alerting still keys off real proposal data only (vv.proposal).
    vv.missedSlots = proposal === null ? 0 : 1 - proposal;
    pushSample(vv, { t: Date.now(), epoch, vote });

    if (vote === null) {
      await onValidatorMissing(net, m, vv, vm, epoch, suppressed);
    } else {
      await evaluateTrend(net, vv, vm, vote, epoch, suppressed);
    }
    vv.health = healthOf(vv, vm);
    vm.initialized = true;
  }

  persistAll();
  publish();
}

/** Write every validator's counter + recent samples to STATE_FILE. */
function persistAll(): void {
  const out: PersistedState = {};
  for (const [name, m] of machines) {
    for (const vv of m.view.validators) {
      const vm = m.validators.get(vv.key)!;
      if (vm.lastVote === null || vm.lastEpoch === null) continue;
      out[`${name}:${vv.key}`] = {
        epoch: vm.lastEpoch,
        lastVote: vm.lastVote,
        dropCount: vm.redStreak,
        warnSent: vm.trendAlerted,
        critSent: vm.trendPaged,
        since: vm.trendSince,
        samples: vv.samples.slice(-50),
      };
    }
  }
  savePersisted(out);
}

/** A vote rate this low, while in the active set, means the node isn't really participating. */
const NEAR_ZERO_VOTE = 0.05;

/**
 * Health follows Espresso's delegator-facing model: missed slots drives it
 * whenever proposal data exists; vote participation is secondary and never
 * forces crit on its own (it is a slow-moving epoch average). With no leader
 * slots yet, vote is informational unless the node is in the active set and
 * barely voting at all.
 */
function healthOf(vv: ValidatorView, vm: ValidatorMachine): ValidatorView['health'] {
  if (vm.missingAlerted || (vm.missingCount >= 2 && vm.initialized)) return 'missing';
  if (vv.vote === null) return 'unknown';
  // Branch on real proposal data, not the displayed missed value: with no
  // data, missed shows an assumed 0% which must not drive health.
  if (vv.proposal !== null) {
    const missed = 1 - vv.proposal;
    if (missed > cfg.missedCritical) return 'crit';
    if (missed > cfg.missedWarn) return 'warn';
    return vv.vote < cfg.voteWarn ? 'warn' : 'ok';
  }
  if (vv.vote < NEAR_ZERO_VOTE && vv.inActiveSet === true) return 'crit';
  return vv.vote < cfg.voteWarn ? 'warn' : 'ok';
}

/**
 * The alert rule, exactly as the operator runs it: polls are ~1 minute
 * apart, and a dropping epoch average means views were missed in that
 * window. CONSECUTIVE_DROPS_WARN drops in a row notify the chat channels;
 * CONSECUTIVE_DROPS_CRIT pages PagerDuty. A rising (or equal) poll clears
 * the streak and sends the paired recovery. Counters persist to
 * STATE_FILE, so a bot restart continues the streak instead of forgetting
 * it; an epoch rollover resets it cleanly (rates restart near zero, that
 * is expected, not an alert).
 */
async function evaluateTrend(
  net: NetworkConfig,
  vv: ValidatorView,
  vm: ValidatorMachine,
  vote: number,
  epoch: number,
  suppressed: boolean,
): Promise<void> {
  // Return from "missing from the participation map".
  if (vm.missingAlerted) {
    vm.missingAlerted = false;
    await sendAlert({
      severity: 'recovered',
      title: `${vv.label} back in the participation map`,
      lines: [
        `Gone for ${vm.missingSince ? dur(vm.missingSince) : '?'}`,
        `Vote participation: ${pct(vote)} (epoch ${epoch})`,
      ],
      network: net.name,
      link: explorerLink(net),
    });
    if (vm.missingPdTriggered) {
      vm.missingPdTriggered = false;
      await sendAlert({
        severity: 'recovered',
        title: `${vv.label} back in the participation map`,
        lines: ['Validator reappeared'],
        network: net.name,
        dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:missing`,
        pagerduty: 'resolve',
      });
    }
  }
  vm.missingCount = 0;
  vm.missingSince = null;

  // Root cause (local node down or lagging) is already alerting; freeze
  // the counter rather than stacking symptom alerts on top.
  if (suppressed) return;

  if (vm.lastEpoch !== epoch) {
    // Rollover: rates reset to ~0 by design. Clean reset, and close any
    // incident left open so PagerDuty is not left dangling.
    if (vm.trendPaged) {
      vm.trendPaged = false;
      await sendAlert({
        severity: 'recovered',
        title: `${vv.label} epoch rolled over`,
        lines: [`Epoch ${epoch} started, drop counters reset`],
        network: net.name,
        dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:trend`,
        pagerduty: 'resolve',
      });
    }
    if (vm.trendAlerted) {
      vm.trendAlerted = false;
      await sendAlert({
        severity: 'recovered',
        title: `${vv.label} epoch rolled over`,
        lines: [`Epoch ${epoch} started, drop counters reset`],
        network: net.name,
      });
    }
    vm.redStreak = 0;
    vm.trendSince = null;
  } else if (vm.lastVote !== null) {
    if (vote < vm.lastVote - 1e-9) {
      vm.redStreak += 1;
      if (vm.trendSince === null) vm.trendSince = Date.now();
      if (!vm.trendAlerted && vm.redStreak >= cfg.consecutiveDropsWarn && cooldownOk(`${net.name}:${vv.key}:trend`)) {
        vm.trendAlerted = true;
        await sendAlert({
          severity: 'warning',
          title: `${vv.label} is missing views`,
          lines: [
            `Vote dropped ${vm.redStreak} polls in a row`,
            `Epoch ${epoch} vote participation: ${pct(vote)}`,
          ],
          network: net.name,
          link: explorerLink(net),
        });
      }
      if (!vm.trendPaged && vm.redStreak >= cfg.consecutiveDropsCrit) {
        vm.trendPaged = true;
        await sendAlert({
          severity: 'critical',
          title: `${vv.label} is missing views`,
          lines: [`${vm.redStreak} consecutive dropping polls, vote ${pct(vote)}`],
          network: net.name,
          dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:trend`,
          pagerduty: 'trigger',
        });
      }
    } else {
      const wasAlerted = vm.trendAlerted;
      const wasPaged = vm.trendPaged;
      const since = vm.trendSince;
      vm.redStreak = 0;
      vm.trendAlerted = false;
      vm.trendPaged = false;
      vm.trendSince = null;
      if (wasAlerted) {
        await sendAlert({
          severity: 'recovered',
          title: `${vv.label} is voting again`,
          lines: [
            `Missed views for ${since ? dur(since) : '?'}`,
            `Epoch ${epoch} vote participation: ${pct(vote)}`,
          ],
          network: net.name,
        });
      }
      if (wasPaged) {
        await sendAlert({
          severity: 'recovered',
          title: `${vv.label} is voting again`,
          lines: [`Vote climbing, ${pct(vote)}`],
          network: net.name,
          dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:trend`,
          pagerduty: 'resolve',
        });
      }
    }
  }
  vm.lastVote = vote;
  vm.lastEpoch = epoch;
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

  let classification = 'not in the validator registry, check the configured key';
  try {
    const info = await m.partClient.findInAllValidators(epoch, vv.key);
    if (info) {
      classification = `registered but inactive (account ${info.account})`;
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
      title: `${vv.label} missing from the participation map`,
      lines: [`Not in the epoch ${epoch} vote participation map`, `Status: ${classification}`],
      network: net.name,
      link: explorerLink(net),
    });
    // Dropping out of the set entirely pages, like a critical missed-slots streak.
    if (!vm.missingPdTriggered) {
      vm.missingPdTriggered = true;
      await sendAlert({
        severity: 'critical',
        title: `${vv.label} missing from the participation map`,
        lines: [`Status: ${classification}`],
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
        title: secondarySeesProgress
          ? `Query endpoint stale on ${net.name}`
          : `No decide for ${Math.round(tsld)}s on ${net.name}`,
        lines: secondarySeesProgress
          ? [
              `Active endpoint reports ${Math.round(tsld)}s since the last decide, another endpoint is advancing`,
              `Switched endpoints. Likely a rate limit or endpoint issue, not the network`,
            ]
          : [`Threshold: ${cfg.decideStallSec}s`, `No configured endpoint sees progress, consensus may be stalled`],
        network: net.name,
        link: explorerLink(net),
      });
      if (!secondarySeesProgress && !m.stallPdTriggered) {
        m.stallPdTriggered = true;
        await sendAlert({
          severity: 'critical',
          title: `Chain stall on ${net.name}`,
          lines: [`No decide for ${Math.round(tsld)}s`],
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
        title: `Decides resumed on ${net.name}`,
        lines: [`Last decide ${Math.round(tsld)}s ago${m.stallSince ? `, stalled for ${dur(m.stallSince)}` : ''}`],
        network: net.name,
      });
      if (m.stallPdTriggered) {
        m.stallPdTriggered = false;
        await sendAlert({
          severity: 'recovered',
          title: `Chain stall resolved on ${net.name}`,
          lines: ['Decides resumed'],
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
        title: 'Local node back online',
        lines: [`Reachable again${lm.downSince ? `, down for ${dur(lm.downSince)}` : ''}`],
      });
      lm.downSince = null;
    }

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
              title: 'Local node falling behind',
              lines: [`${lag} blocks behind (local ${height}, network ${remoteHeight})`, `Threshold: ${cfg.heightLagBlocks} blocks`],
            });
          }
        } else if (lm.lagAlerted) {
          lm.lagAlerted = false;
          await sendAlert({
            severity: 'recovered',
            title: 'Local node caught up',
            lines: [`${Math.max(lag, 0)} blocks behind at height ${height}`],
          });
        }
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
      if (lm.initialized && !lm.downAlerted && cooldownOk('local:down')) {
        lm.downAlerted = true;
        lm.downSince = Date.now();
        await sendAlert({
          severity: 'critical',
          title: 'Local node unreachable',
          lines: [`${cfg.localNodeUrl} failed ${lm.failCount} consecutive checks`],
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
  for (const net of cfg.networks) {
    const m = initNetwork(net);
    for (const vv of m.view.validators) {
      const p = persisted[`${net.name}:${vv.key}`];
      if (!p) continue;
      const vm = m.validators.get(vv.key)!;
      vm.lastEpoch = p.epoch;
      vm.lastVote = p.lastVote;
      vm.redStreak = p.dropCount ?? 0;
      vm.trendAlerted = !!p.warnSent;
      vm.trendPaged = !!p.critSent;
      vm.trendSince = p.since ?? null;
      if (Array.isArray(p.samples)) vv.samples.push(...p.samples.slice(-50));
    }
    void pollParticipation(net);
    void pollStatus(net);
    timers.push(setInterval(() => void pollParticipation(net), cfg.pollIntervalSec * 1000));
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
    };
    store.localNode = { url: cfg.localNodeUrl, reachable: null, height: null, lagBlocks: null };
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
      watched ? `Watching: ${watched}` : 'No validators configured yet',
      `Poll: ${cfg.pollIntervalSec}s. Warn after ${cfg.consecutiveDropsWarn} drops, page after ${cfg.consecutiveDropsCrit}`,
      `Channels: ${store.channels.join(', ') || 'none'}`,
      cfg.localNodeUrl ? 'Local node checks enabled' : 'Local node checks disabled',
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
      title: 'espressoduty shutting down',
      lines: [`Received ${reason}, monitoring stops until restart`],
    }),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}
