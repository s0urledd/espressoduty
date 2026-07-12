// The polling engine. Started once from instrumentation.ts.
//
// Espresso exposes participation as a per-epoch *rate* (0.0-1.0), not a
// per-block signed/missed stream, so the vote state machine works on
// sampled rates against absolute thresholds. When LOCAL_NODE_URL is set,
// the operator's own node is the primary read source (no public rate
// limits, fastest data); the public query nodes remain as fallback.
//
// Ground rules, same as monadoring: never alert on the first observation
// of anything; every bad alert has a matching recovery that only fires if
// the bad alert actually went out; repeated alerts respect a cooldown.

import { loadConfig, configuredChannels, shortKey, type NetworkConfig, type NetworkName } from './config';
import { EspressoClient, hexStakeToEsp, type ParticipationMap, type ValidatorInfo } from './espresso';
import { sendAlert, type AlertEvent } from './alerts';
import { getStore, publish, pushSample, type NetworkView, type ValidatorView, type EndpointView } from './state';

const cfg = loadConfig();

// A fresh epoch's rate is computed over a handful of views: one missed
// view can read as a catastrophic 0.0. Skip absolute-threshold alerts for
// the first few samples after a rollover (recoveries still fire).
const EPOCH_GRACE_SAMPLES = 3;

// ---------------------------------------------------------------------------
// Internal (non-view) state
// ---------------------------------------------------------------------------

type Level = 'ok' | 'warn' | 'crit';

interface ValidatorMachine {
  initialized: boolean;
  /** Missed slots (1 - proposal_participation): the delegator-facing metric that pages. */
  missedStatus: Level;
  missedAlerted: boolean;
  missedWorst: number | null;
  missedIncidentStart: number | null;
  /** Consecutive missed-slots critical polls, drives PagerDuty. */
  pdConsecutiveCrit: number;
  pdTriggered: boolean;
  /** Vote participation: secondary signal, chat-only. */
  voteStatus: Level;
  voteAlerted: boolean;
  voteLowest: number | null;
  voteIncidentStart: number | null;
  missingCount: number;
  missingAlerted: boolean;
  missingSince: number | null;
  missingPdTriggered: boolean;
}

interface NetworkMachine {
  client: EspressoClient;
  view: NetworkView;
  validators: Map<string, ValidatorMachine>;
  epoch: number | null;
  /** Samples left to skip for absolute-threshold alerts after a rollover. */
  epochGraceLeft: number;
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

/** Thresholds read better without trailing zeros: 0.5 -> 50%, 0.925 -> 92.5%. */
function pctClean(x: number): string {
  const v = x * 100;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
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
  // Local node first when configured (mainnet only), public nodes as fallback.
  const useLocal = net.name === 'mainnet' && cfg.localNodeUrl !== null;
  const endpoints = useLocal ? [cfg.localNodeUrl!, ...net.queryNodes] : net.queryNodes;

  const view: NetworkView = {
    name: net.name,
    epoch: null,
    height: null,
    timeSinceLastDecide: null,
    successRate: null,
    lastPollAt: null,
    endpoints: endpoints.map(
      (url, i): EndpointView => ({ url, isActive: i === 0, isLocal: useLocal && i === 0 }),
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
    client: new EspressoClient(endpoints),
    view,
    validators: new Map(
      net.validators.map((v) => [
        v.key,
        {
          initialized: false,
          missedStatus: 'ok',
          missedAlerted: false,
          missedWorst: null,
          missedIncidentStart: null,
          pdConsecutiveCrit: 0,
          pdTriggered: false,
          voteStatus: 'ok',
          voteAlerted: false,
          voteLowest: null,
          voteIncidentStart: null,
          missingCount: 0,
          missingAlerted: false,
          missingSince: null,
          missingPdTriggered: false,
        } satisfies ValidatorMachine,
      ]),
    ),
    epoch: null,
    epochGraceLeft: 0,
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

async function pollParticipation(net: NetworkConfig): Promise<void> {
  const m = machines.get(net.name)!;
  let stakeTable, voteMap: ParticipationMap, proposalMap: ParticipationMap;
  try {
    stakeTable = await m.client.currentStakeTable();
    voteMap = await m.client.voteParticipation('current');
    proposalMap = await m.client.proposalParticipation('current');
  } catch (err) {
    console.error(`[monitor] ${net.name} participation poll failed: ${err instanceof Error ? err.message : err}`);
    // Record the gap so the dashboard grid shows an honest empty cell.
    const t = Date.now();
    for (const vv of m.view.validators) pushSample(vv, { t, epoch: m.epoch, vote: null });
    publish();
    return;
  }

  const epoch = stakeTable.epoch;
  const stakeByKey = new Map(
    stakeTable.stake_table.map((e) => [e.stake_table_entry.stake_key, e.stake_table_entry.stake_amount]),
  );

  if (m.epoch !== null && epoch > m.epoch) m.epochGraceLeft = EPOCH_GRACE_SAMPLES;
  if (m.epoch !== epoch) {
    m.epoch = epoch;
    await refreshIdentity(net, m, epoch);
    m.identityLoaded = true;
  }
  m.view.epoch = epoch;
  m.view.lastPollAt = Date.now();

  const suppressed = m.epochGraceLeft > 0 || localNodeUnhealthy();
  if (m.epochGraceLeft > 0) m.epochGraceLeft -= 1;

  for (const vv of m.view.validators) {
    const vm = m.validators.get(vv.key)!;
    const vote = Object.prototype.hasOwnProperty.call(voteMap, vv.key) ? voteMap[vv.key] : null;
    const proposal = Object.prototype.hasOwnProperty.call(proposalMap, vv.key) ? proposalMap[vv.key] : null;

    vv.inActiveSet = stakeByKey.has(vv.key);
    const stakeHex = stakeByKey.get(vv.key);
    if (stakeHex) vv.stakeEsp = hexStakeToEsp(stakeHex);
    vv.vote = vote;
    vv.proposal = proposal;
    // Espresso's headline metric. null = no leader slots this epoch yet,
    // rendered as a dash like stake.espresso.network does. Not a failure.
    vv.missedSlots = proposal === null ? null : 1 - proposal;
    pushSample(vv, { t: Date.now(), epoch, vote });

    if (vote === null) {
      await onValidatorMissing(net, m, vv, vm, epoch, suppressed);
    } else {
      await onValidatorPresent(net, vv, vm, vote, epoch, suppressed);
    }
    vv.health = healthOf(vv, vm);
    vm.initialized = true;
  }

  publish();
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
  if (vv.missedSlots !== null) {
    if (vv.missedSlots > cfg.missedCritical) return 'crit';
    if (vv.missedSlots > cfg.missedWarn) return 'warn';
    return vv.vote < cfg.voteWarn ? 'warn' : 'ok';
  }
  if (vv.vote < NEAR_ZERO_VOTE && vv.inActiveSet === true) return 'crit';
  return vv.vote < cfg.voteWarn ? 'warn' : 'ok';
}

async function onValidatorPresent(
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

  const missed = vv.missedSlots;
  const missedStatus: Level | null =
    missed === null ? null : missed > cfg.missedCritical ? 'crit' : missed > cfg.missedWarn ? 'warn' : 'ok';
  const voteStatus: Level = vote < cfg.voteCritical ? 'crit' : vote < cfg.voteWarn ? 'warn' : 'ok';

  if (!vm.initialized || suppressed) {
    // Seed state silently; recoveries still pair with earlier alerts.
    vm.pdConsecutiveCrit = 0;
    if (missedStatus === 'ok' && missed !== null) await maybeMissedRecovery(net, vv, vm, missed, epoch);
    if (voteStatus === 'ok') await maybeVoteRecovery(net, vv, vm, vote, epoch);
    if (missedStatus !== null) vm.missedStatus = missedStatus;
    vm.voteStatus = voteStatus;
    return;
  }

  // --- Missed slots: the delegator-facing metric, and the one that pages.
  // Only evaluated when the key appears in the proposal map: no leader
  // slots this epoch is not a failure and never alerts.
  if (missedStatus === null) {
    vm.pdConsecutiveCrit = 0;
  } else {
    if (missedStatus === 'crit') {
      vm.pdConsecutiveCrit += 1;
    } else {
      vm.pdConsecutiveCrit = 0;
    }
    if (missedStatus !== 'ok') {
      if (vm.missedWorst === null || missed! > vm.missedWorst) vm.missedWorst = missed!;
      if (vm.missedIncidentStart === null) vm.missedIncidentStart = Date.now();
      const escalated = missedStatus === 'crit' && vm.missedStatus !== 'crit';
      if ((!vm.missedAlerted || escalated) && cooldownOk(`${net.name}:${vv.key}:missed:${missedStatus}`)) {
        vm.missedAlerted = true;
        await sendAlert({
          severity: missedStatus === 'crit' ? 'critical' : 'warning',
          title:
            missedStatus === 'crit' ? `${vv.label} missed slots critical` : `${vv.label} missed slots high`,
          lines: [
            `Epoch ${epoch} missed slots: ${pct(missed)}`,
            `Threshold: ${pctClean(missedStatus === 'crit' ? cfg.missedCritical : cfg.missedWarn)}`,
          ],
          network: net.name,
          link: explorerLink(net),
        });
      }
      if (missedStatus === 'crit' && !vm.pdTriggered && vm.pdConsecutiveCrit >= cfg.pagerdutyThreshold) {
        vm.pdTriggered = true;
        await sendAlert({
          severity: 'critical',
          title: `${vv.label} missed slots critical`,
          lines: [`${vm.pdConsecutiveCrit} critical polls in a row, missed slots ${pct(missed)}`],
          network: net.name,
          dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:missed`,
          pagerduty: 'trigger',
        });
      }
      vm.missedStatus = missedStatus;
    } else {
      await maybeMissedRecovery(net, vv, vm, missed!, epoch);
      vm.missedStatus = 'ok';
    }
  }

  // --- Vote participation: secondary signal, chat-only. A low epoch
  // average alone never pages, that is the missed-slots machine's job.
  if (voteStatus !== 'ok') {
    if (vm.voteLowest === null || vote < vm.voteLowest) vm.voteLowest = vote;
    if (vm.voteIncidentStart === null) vm.voteIncidentStart = Date.now();
    const escalated = voteStatus === 'crit' && vm.voteStatus !== 'crit';
    if ((!vm.voteAlerted || escalated) && cooldownOk(`${net.name}:${vv.key}:vote:${voteStatus}`)) {
      vm.voteAlerted = true;
      await sendAlert({
        severity: voteStatus === 'crit' ? 'critical' : 'warning',
        title:
          voteStatus === 'crit' ? `${vv.label} vote participation critical` : `${vv.label} vote participation low`,
        lines: [
          `Epoch ${epoch} vote participation: ${pct(vote)}`,
          `Threshold: ${pctClean(voteStatus === 'crit' ? cfg.voteCritical : cfg.voteWarn)}`,
        ],
        network: net.name,
        link: explorerLink(net),
      });
    }
    vm.voteStatus = voteStatus;
  } else {
    await maybeVoteRecovery(net, vv, vm, vote, epoch);
    vm.voteStatus = 'ok';
  }
}

async function maybeMissedRecovery(
  net: NetworkConfig,
  vv: ValidatorView,
  vm: ValidatorMachine,
  missed: number,
  epoch: number,
): Promise<void> {
  if (!vm.missedAlerted) return;
  vm.missedAlerted = false;
  await sendAlert({
    severity: 'recovered',
    title: `${vv.label} missed slots recovered`,
    lines: [
      `Back to ${pct(missed)} in epoch ${epoch}`,
      `Worst: ${pct(vm.missedWorst)}${vm.missedIncidentStart ? `, elevated for ${dur(vm.missedIncidentStart)}` : ''}`,
    ],
    network: net.name,
  });
  if (vm.pdTriggered) {
    vm.pdTriggered = false;
    await sendAlert({
      severity: 'recovered',
      title: `${vv.label} missed slots recovered`,
      lines: [`Missed slots back to ${pct(missed)}`],
      network: net.name,
      dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:missed`,
      pagerduty: 'resolve',
    });
  }
  vm.missedWorst = null;
  vm.missedIncidentStart = null;
}

async function maybeVoteRecovery(
  net: NetworkConfig,
  vv: ValidatorView,
  vm: ValidatorMachine,
  vote: number,
  epoch: number,
): Promise<void> {
  if (!vm.voteAlerted) return;
  vm.voteAlerted = false;
  await sendAlert({
    severity: 'recovered',
    title: `${vv.label} vote participation recovered`,
    lines: [
      `Back to ${pct(vote)} in epoch ${epoch}`,
      `Lowest: ${pct(vm.voteLowest)}${vm.voteIncidentStart ? `, down for ${dur(vm.voteIncidentStart)}` : ''}`,
    ],
    network: net.name,
  });
  vm.voteLowest = null;
  vm.voteIncidentStart = null;
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
    const info = await m.client.findInAllValidators(epoch, vv.key);
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
    byAccount = await m.client.validators(epoch);
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
    const [height, tsld] = await Promise.all([m.client.blockHeight(), m.client.timeSinceLastDecide()]);
    m.view.height = height;
    m.view.timeSinceLastDecide = tsld;
    m.client.successRate().then((r) => (m.view.successRate = r)).catch(() => {});

    await checkStall(net, m, tsld);
  } catch (err) {
    console.error(`[monitor] ${net.name} status poll failed: ${err instanceof Error ? err.message : err}`);
  }
  for (const [i, ev] of m.view.endpoints.entries()) ev.isActive = i === m.client.activeIndex;
  publish();
}

async function checkStall(net: NetworkConfig, m: NetworkMachine, tsld: number): Promise<void> {
  if (tsld > cfg.decideStallSec) {
    if (m.stallSince === null) m.stallSince = Date.now();

    // Cross-check against the other endpoints before blaming the network:
    // if any other endpoint sees recent decides, the problem is this
    // endpoint (or our config/rate limit), not consensus.
    let secondarySeesProgress = false;
    for (let i = 0; i < m.client.endpoints.length; i++) {
      if (i === m.client.activeIndex) continue;
      try {
        const other = await EspressoClient.getFrom<number>(m.client.endpoints[i], 'status/time-since-last-decide', 6000);
        if (other <= cfg.decideStallSec) {
          secondarySeesProgress = true;
          m.client.activeIndex = i; // read from the endpoint that is seeing progress
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
    const height = await EspressoClient.getFrom<number>(cfg.localNodeUrl, 'status/block-height', 8000);
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
        remoteHeight = await EspressoClient.getFrom<number>(lm.remoteBase, 'status/block-height', 8000);
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
    if (lm.failCount >= 2) {
      view.reachable = false;
      view.lagBlocks = null;
      if (lm.initialized && !lm.downAlerted && cooldownOk('local:down')) {
        lm.downAlerted = true;
        lm.downSince = Date.now();
        await sendAlert({
          severity: 'critical',
          title: 'Local node unreachable',
          lines: [`${cfg.localNodeUrl} is not responding`],
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

  for (const net of cfg.networks) {
    initNetwork(net);
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
      `Poll: ${cfg.pollIntervalSec}s, status: ${cfg.statusPollIntervalSec}s`,
      `Channels: ${store.channels.join(', ') || 'none'}`,
      cfg.localNodeUrl ? 'Source: local node, public fallback' : 'Source: public query service',
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
