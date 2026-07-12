// The polling engine. Started once from instrumentation.ts.
//
// Espresso exposes participation as a per-epoch *rate* (0.0-1.0), not a
// per-block signed/missed stream, so every state machine here works on
// sampled rates: absolute thresholds, a consecutive-sample trend detector
// that catches a node starting to miss views mid-epoch, and an
// epoch-rollover handler that snapshots finals and suppresses absolute
// alerts while the young epoch has too few samples to be meaningful.
//
// Ground rules, same as monadoring: never alert on the first observation
// of anything; every bad alert has a matching recovery that only fires if
// the bad alert actually went out; repeated alerts respect a cooldown.

import { loadConfig, configuredChannels, shortKey, type NetworkConfig, type NetworkName } from './config';
import { EspressoClient, hexStakeToEsp, type ParticipationMap, type ValidatorInfo } from './espresso';
import { sendAlert, type AlertEvent } from './alerts';
import {
  getStore,
  publish,
  pushSample,
  type NetworkView,
  type ValidatorView,
  type EndpointView,
  type EpochSummary,
} from './state';

const cfg = loadConfig();

// ---------------------------------------------------------------------------
// Internal (non-view) state
// ---------------------------------------------------------------------------

interface ValidatorMachine {
  initialized: boolean;
  /** 'ok' | 'warn' | 'crit' for the absolute vote rate. */
  voteStatus: 'ok' | 'warn' | 'crit';
  voteAlerted: boolean;
  voteLowest: number | null;
  voteIncidentStart: number | null;
  pdConsecutiveCrit: number;
  pdTriggered: boolean;
  /** Last vote sample of the current epoch, for the trend detector. */
  prevVote: number | null;
  trendAlertedEpoch: number | null;
  proposalAlerted: boolean;
  proposalLowest: number | null;
  missingCount: number;
  missingAlerted: boolean;
  missingSince: number | null;
  lastStakeEsp: number | null;
  lastDelegatorCount: number | null;
}

interface EndpointMachine {
  failCount: number;
  staleCount: number;
  lastHeight: number | null;
  unhealthy: boolean;
  alerted: boolean;
  downSince: number | null;
}

interface NetworkMachine {
  client: EspressoClient;
  view: NetworkView;
  validators: Map<string, ValidatorMachine>;
  endpoints: EndpointMachine[];
  epoch: number | null;
  stallAlerted: boolean;
  stallSince: number | null;
  stallPdCount: number;
  stallPdTriggered: boolean;
  allOffline: { isOffline: boolean; since: number | null; alertSent: boolean };
  lastActiveIndex: number;
  identityLoaded: boolean;
}

interface LocalMachine {
  failCount: number;
  downAlerted: boolean;
  downSince: number | null;
  lagAlerted: boolean;
  initialized: boolean;
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

function mins(fromMs: number): string {
  const m = Math.round((Date.now() - fromMs) / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function explorerLink(net: NetworkConfig): AlertEvent['link'] {
  return { label: 'Explorer', url: net.explorerUrl };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function initNetwork(net: NetworkConfig): NetworkMachine {
  const view: NetworkView = {
    name: net.name,
    epoch: null,
    height: null,
    timeSinceLastDecide: null,
    successRate: null,
    suppressedUntil: null,
    lastPollAt: null,
    epochHistory: [],
    endpoints: net.queryNodes.map(
      (url, i): EndpointView => ({ url, healthy: null, lastHeight: null, isPrimary: i === 0, isActive: i === 0 }),
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
        health: 'unknown',
        samples: [],
      }),
    ),
  };
  const m: NetworkMachine = {
    client: new EspressoClient(net.queryNodes),
    view,
    validators: new Map(
      net.validators.map((v) => [
        v.key,
        {
          initialized: false,
          voteStatus: 'ok',
          voteAlerted: false,
          voteLowest: null,
          voteIncidentStart: null,
          pdConsecutiveCrit: 0,
          pdTriggered: false,
          prevVote: null,
          trendAlertedEpoch: null,
          proposalAlerted: false,
          proposalLowest: null,
          missingCount: 0,
          missingAlerted: false,
          missingSince: null,
          lastStakeEsp: null,
          lastDelegatorCount: null,
        } satisfies ValidatorMachine,
      ]),
    ),
    endpoints: net.queryNodes.map(
      (): EndpointMachine => ({ failCount: 0, staleCount: 0, lastHeight: null, unhealthy: false, alerted: false, downSince: null }),
    ),
    epoch: null,
    stallAlerted: false,
    stallSince: null,
    stallPdCount: 0,
    stallPdTriggered: false,
    allOffline: { isOffline: false, since: null, alertSent: false },
    lastActiveIndex: 0,
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
  const now = Date.now();
  let stakeTable, voteMap: ParticipationMap, proposalMap: ParticipationMap;
  try {
    stakeTable = await m.client.currentStakeTable();
    voteMap = await m.client.voteParticipation('current');
    proposalMap = await m.client.proposalParticipation('current');
  } catch (err) {
    console.error(`[monitor] ${net.name} participation poll failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const epoch = stakeTable.epoch;
  const stakeByKey = new Map(
    stakeTable.stake_table.map((e) => [e.stake_table_entry.stake_key, e.stake_table_entry.stake_amount]),
  );

  if (m.epoch !== null && epoch > m.epoch) await onEpochRollover(net, m, m.epoch, epoch);
  if (m.epoch !== epoch) {
    m.epoch = epoch;
    if (!m.identityLoaded) {
      await refreshIdentity(net, m, epoch, true);
      m.identityLoaded = true;
    }
  }
  m.view.epoch = epoch;
  m.view.lastPollAt = now;

  const suppressed = m.view.suppressedUntil !== null && now < m.view.suppressedUntil;
  if (m.view.suppressedUntil !== null && now >= m.view.suppressedUntil) m.view.suppressedUntil = null;

  for (const vv of m.view.validators) {
    const vm = m.validators.get(vv.key)!;
    const vote = Object.prototype.hasOwnProperty.call(voteMap, vv.key) ? voteMap[vv.key] : null;
    const proposal = Object.prototype.hasOwnProperty.call(proposalMap, vv.key) ? proposalMap[vv.key] : null;
    const stakeHex = stakeByKey.get(vv.key);

    vv.inActiveSet = stakeByKey.has(vv.key);
    if (stakeHex) vv.stakeEsp = hexStakeToEsp(stakeHex);
    vv.vote = vote;
    vv.proposal = proposal;
    pushSample(vv, { t: now, epoch, vote, proposal }, getStore().maxSamples);

    if (vote === null) {
      await onValidatorMissing(net, m, vv, vm, epoch);
    } else {
      await onValidatorPresent(net, m, vv, vm, vote, proposal, epoch, suppressed);
    }
    vv.health = healthOf(vv, vm);
    vm.initialized = true;
  }

  publish();
}

function healthOf(vv: ValidatorView, vm: ValidatorMachine): ValidatorView['health'] {
  if (vm.missingAlerted || (vm.missingCount >= 2 && vm.initialized)) return 'missing';
  if (vv.vote === null) return 'unknown';
  if (vv.vote < cfg.voteCritical) return 'crit';
  if (vv.vote < cfg.voteWarn) return 'warn';
  return 'ok';
}

async function onValidatorPresent(
  net: NetworkConfig,
  m: NetworkMachine,
  vv: ValidatorView,
  vm: ValidatorMachine,
  vote: number,
  proposal: number | null,
  epoch: number,
  suppressed: boolean,
): Promise<void> {
  // Return from "missing from the participation map".
  if (vm.missingAlerted) {
    vm.missingAlerted = false;
    await sendAlert({
      severity: 'recovered',
      title: `${vv.label} is back in the participation map`,
      lines: [
        `Validator reappeared after ${vm.missingSince ? mins(vm.missingSince) : '?'}.`,
        `Current vote participation: ${pct(vote)} (epoch ${epoch})`,
      ],
      network: net.name,
      link: explorerLink(net),
    });
  }
  vm.missingCount = 0;
  vm.missingSince = null;

  const firstObservation = !vm.initialized;

  // --- Trend detector: mid-epoch drop between consecutive samples, fires
  // even while the absolute rate is still above the warn threshold.
  if (!firstObservation && vm.prevVote !== null && !suppressed) {
    const drop = vm.prevVote - vote;
    if (drop > cfg.trendDropThreshold && vote >= cfg.voteWarn && vm.trendAlertedEpoch !== epoch) {
      vm.trendAlertedEpoch = epoch;
      if (cooldownOk(`${net.name}:${vv.key}:trend`)) {
        await sendAlert({
          severity: 'warning',
          title: `${vv.label} participation is dropping`,
          lines: [
            `Vote participation fell ${pct(drop)} between polls (${pct(vm.prevVote)} → ${pct(vote)}).`,
            `Still above the warn threshold, but the node has likely started missing views right now.`,
            `Epoch ${epoch}`,
          ],
          network: net.name,
          link: explorerLink(net),
        });
      }
    }
  }
  vm.prevVote = vote;

  // --- Absolute thresholds (suppressed early in a fresh epoch).
  const status: ValidatorMachine['voteStatus'] =
    vote < cfg.voteCritical ? 'crit' : vote < cfg.voteWarn ? 'warn' : 'ok';

  if (status === 'crit') {
    vm.pdConsecutiveCrit += 1;
  } else {
    vm.pdConsecutiveCrit = 0;
  }

  if (firstObservation || suppressed) {
    // Seed state silently; recoveries still pair with earlier alerts.
    if (status === 'ok') await maybeVoteRecovery(net, m, vv, vm, vote, epoch);
    vm.voteStatus = status;
    return;
  }

  if (status !== 'ok') {
    if (vm.voteLowest === null || vote < vm.voteLowest) vm.voteLowest = vote;
    if (vm.voteIncidentStart === null) vm.voteIncidentStart = Date.now();
    const escalated = status === 'crit' && vm.voteStatus !== 'crit';
    if ((!vm.voteAlerted || escalated) && cooldownOk(`${net.name}:${vv.key}:vote:${status}`)) {
      vm.voteAlerted = true;
      await sendAlert({
        severity: status === 'crit' ? 'critical' : 'warning',
        title:
          status === 'crit'
            ? `${vv.label} vote participation critical`
            : `${vv.label} vote participation low`,
        lines: [
          `Vote participation is ${pct(vote)} in epoch ${epoch} (threshold: ${pct(
            status === 'crit' ? cfg.voteCritical : cfg.voteWarn,
          )}).`,
          `Downtime costs rewards and delegator confidence — check the node.`,
        ],
        network: net.name,
        link: explorerLink(net),
      });
    }
    if (status === 'crit' && !vm.pdTriggered && vm.pdConsecutiveCrit >= cfg.pagerdutyThreshold) {
      vm.pdTriggered = true;
      await sendAlert({
        severity: 'critical',
        title: `${vv.label} vote participation critical`,
        lines: [`${vm.pdConsecutiveCrit} consecutive critical polls, participation ${pct(vote)}.`],
        network: net.name,
        dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:vote`,
        pagerduty: 'trigger',
      });
    }
    vm.voteStatus = status;
    return;
  }

  await maybeVoteRecovery(net, m, vv, vm, vote, epoch);
  vm.voteStatus = 'ok';

  // --- Proposal participation: warn-only, lower stakes by design.
  if (proposal !== null && !suppressed) {
    if (proposal < cfg.proposalWarn) {
      if (vm.proposalLowest === null || proposal < vm.proposalLowest) vm.proposalLowest = proposal;
      if (!vm.proposalAlerted && cooldownOk(`${net.name}:${vv.key}:proposal`)) {
        vm.proposalAlerted = true;
        await sendAlert({
          severity: 'warning',
          title: `${vv.label} proposal participation low`,
          lines: [
            `Proposal participation is ${pct(proposal)} in epoch ${epoch} (threshold: ${pct(cfg.proposalWarn)}).`,
            `The node is missing proposals in its leader slots.`,
          ],
          network: net.name,
          link: explorerLink(net),
        });
      }
    } else if (vm.proposalAlerted) {
      vm.proposalAlerted = false;
      await sendAlert({
        severity: 'recovered',
        title: `${vv.label} proposal participation recovered`,
        lines: [`Back to ${pct(proposal)} (lowest during incident: ${pct(vm.proposalLowest)}).`],
        network: net.name,
      });
      vm.proposalLowest = null;
    }
  }
}

async function maybeVoteRecovery(
  net: NetworkConfig,
  m: NetworkMachine,
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
      `Back to ${pct(vote)} in epoch ${epoch}.`,
      `Lowest during incident: ${pct(vm.voteLowest)}${
        vm.voteIncidentStart ? `, duration ${mins(vm.voteIncidentStart)}` : ''
      }.`,
    ],
    network: net.name,
  });
  if (vm.pdTriggered) {
    vm.pdTriggered = false;
    await sendAlert({
      severity: 'recovered',
      title: `${vv.label} vote participation recovered`,
      lines: [`Participation back to ${pct(vote)}.`],
      network: net.name,
      dedupKey: `espressoduty:${net.name}:${shortKey(vv.key)}:vote`,
      pagerduty: 'resolve',
    });
  }
  vm.voteLowest = null;
  vm.voteIncidentStart = null;
}

async function onValidatorMissing(
  net: NetworkConfig,
  m: NetworkMachine,
  vv: ValidatorView,
  vm: ValidatorMachine,
  epoch: number,
): Promise<void> {
  vm.missingCount += 1;
  vm.prevVote = null;
  if (!vm.initialized) return; // key was never seen: report once below on the 2nd poll too
  if (vm.missingCount < 2 || vm.missingAlerted) return; // require 2 consecutive polls to avoid flapping

  let classification = 'not found in the validator registry — double-check the configured key';
  try {
    const info = await m.client.findInAllValidators(epoch, vv.key);
    if (info) {
      classification = `registered but inactive (account ${info.account})`;
      vv.account = info.account;
    }
  } catch {
    classification = 'classification lookup failed; the key is absent from the current participation map';
  }

  vm.missingAlerted = true;
  vm.missingSince = Date.now();
  if (cooldownOk(`${net.name}:${vv.key}:missing`)) {
    await sendAlert({
      severity: 'critical',
      title: `${vv.label} missing from the participation map`,
      lines: [
        `The key is not present in epoch ${epoch}'s vote participation map.`,
        `Status: ${classification}.`,
        `Possible causes: dropped from the active set, deregistered, or a wrong key in the config.`,
      ],
      network: net.name,
      link: explorerLink(net),
    });
  }
}

// ---------------------------------------------------------------------------
// Epoch rollover
// ---------------------------------------------------------------------------

async function onEpochRollover(net: NetworkConfig, m: NetworkMachine, prevEpoch: number, epoch: number): Promise<void> {
  // Absolute-rate alerts are meaningless on a couple of samples: one missed
  // view at the very start of an epoch reads as a catastrophic rate.
  m.view.suppressedUntil = Date.now() + cfg.epochMinSampleMin * 60_000;

  // Snapshot the finished epoch's finals.
  let finals: EpochSummary['finals'] = [];
  try {
    const [vote, proposal] = await Promise.all([
      m.client.voteParticipation(prevEpoch),
      m.client.proposalParticipation(prevEpoch),
    ]);
    finals = m.view.validators.map((vv) => ({
      key: vv.key,
      label: vv.label,
      vote: Object.prototype.hasOwnProperty.call(vote, vv.key) ? vote[vv.key] : null,
      proposal: Object.prototype.hasOwnProperty.call(proposal, vv.key) ? proposal[vv.key] : null,
      stakeEsp: vv.stakeEsp,
    }));
    m.view.epochHistory.unshift({ epoch: prevEpoch, finals });
    if (m.view.epochHistory.length > cfg.epochHistoryLength) m.view.epochHistory.length = cfg.epochHistoryLength;
  } catch (err) {
    console.error(`[monitor] ${net.name} epoch ${prevEpoch} snapshot failed: ${err instanceof Error ? err.message : err}`);
  }

  // Reset per-epoch machinery.
  for (const vm of m.validators.values()) {
    vm.prevVote = null;
    vm.trendAlertedEpoch = null;
  }

  if (finals.length > 0) {
    await sendAlert({
      severity: 'info',
      title: `Epoch ${prevEpoch} finished`,
      lines: finals.map(
        (f) => `${f.label}: vote ${pct(f.vote)}, proposal ${f.proposal === null ? 'no leader slots' : pct(f.proposal)}`,
      ),
      network: net.name,
      link: { label: 'Staking dashboard', url: 'https://stake.espresso.network' },
    });
  }

  await refreshIdentity(net, m, epoch, false);
}

/** Resolve account / stake / commission / delegators for the watched keys. */
async function refreshIdentity(net: NetworkConfig, m: NetworkMachine, epoch: number, silent: boolean): Promise<void> {
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
    const vm = m.validators.get(vv.key)!;
    const stakeEsp = hexStakeToEsp(info.stake);
    const delegatorCount = Object.keys(info.delegators).length;
    vv.account = info.account;
    vv.commission = info.commission;
    vv.stakeEsp = stakeEsp;
    vv.delegatorCount = delegatorCount;

    // Delegation changes are informational, mirrored from monadoring's
    // status-change notifications.
    if (!silent && vm.lastStakeEsp !== null) {
      const delta = stakeEsp - vm.lastStakeEsp;
      const changed = Math.abs(delta) > Math.max(vm.lastStakeEsp * 0.001, 1);
      const delegatorsChanged = vm.lastDelegatorCount !== null && delegatorCount !== vm.lastDelegatorCount;
      if ((changed || delegatorsChanged) && cooldownOk(`${net.name}:${vv.key}:stake`)) {
        await sendAlert({
          severity: 'info',
          title: `${vv.label} delegation changed`,
          lines: [
            `Stake: ${vm.lastStakeEsp.toLocaleString('en-US', { maximumFractionDigits: 0 })} → ${stakeEsp.toLocaleString('en-US', { maximumFractionDigits: 0 })} ESP (${delta >= 0 ? '+' : ''}${delta.toLocaleString('en-US', { maximumFractionDigits: 0 })}).`,
            `Delegators: ${vm.lastDelegatorCount ?? '?'} → ${delegatorCount}.`,
            `Epoch ${epoch}`,
          ],
          network: net.name,
          link: { label: 'Staking dashboard', url: 'https://stake.espresso.network' },
        });
      }
    }
    vm.lastStakeEsp = stakeEsp;
    vm.lastDelegatorCount = delegatorCount;
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
    await checkFailoverAnnouncement(net, m);
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
          m.client.activeIndex = i; // fail over to the endpoint that is seeing progress
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
          ? `Query endpoint is stale on ${net.name}`
          : `No decide for ${Math.round(tsld)}s on ${net.name}`,
        lines: secondarySeesProgress
          ? [
              `The active query endpoint reports ${Math.round(tsld)}s since the last decide, but another endpoint sees the chain advancing.`,
              `This points at the endpoint (or a rate limit), not the network. Failed over automatically.`,
            ]
          : [
              `time-since-last-decide is ${Math.round(tsld)}s (threshold ${cfg.decideStallSec}s) and no configured endpoint sees progress.`,
              `HotShot consensus may be stalled.`,
            ],
        network: net.name,
        link: explorerLink(net),
      });
      if (!secondarySeesProgress && !m.stallPdTriggered) {
        m.stallPdTriggered = true;
        await sendAlert({
          severity: 'critical',
          title: `Chain stall on ${net.name}`,
          lines: [`No decide for ${Math.round(tsld)}s.`],
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
        lines: [
          `time-since-last-decide is back to ${Math.round(tsld)}s${m.stallSince ? ` after ${mins(m.stallSince)}` : ''}.`,
        ],
        network: net.name,
      });
      if (m.stallPdTriggered) {
        m.stallPdTriggered = false;
        await sendAlert({
          severity: 'recovered',
          title: `Chain stall resolved on ${net.name}`,
          lines: ['Decides resumed.'],
          network: net.name,
          dedupKey: `espressoduty:${net.name}:stall`,
          pagerduty: 'resolve',
        });
      }
    }
    m.stallSince = null;
  }
}

async function checkFailoverAnnouncement(net: NetworkConfig, m: NetworkMachine): Promise<void> {
  if (m.client.activeIndex !== m.lastActiveIndex) {
    const from = m.client.endpoints[m.lastActiveIndex];
    const to = m.client.activeEndpoint;
    m.lastActiveIndex = m.client.activeIndex;
    if (cfg.queryHealthAlerts && cooldownOk(`${net.name}:failover:${to}`)) {
      await sendAlert({
        severity: 'info',
        title: `Query endpoint failover on ${net.name}`,
        lines: [`Switched from ${from} to ${to}.`],
        network: net.name,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Query endpoint health loop (QUERY_HEALTH_ALERTS=on)
// ---------------------------------------------------------------------------

async function pollEndpointHealth(net: NetworkConfig): Promise<void> {
  const m = machines.get(net.name)!;

  for (let i = 0; i < m.client.endpoints.length; i++) {
    const url = m.client.endpoints[i];
    const em = m.endpoints[i];
    const ev = m.view.endpoints[i];
    try {
      const height = await EspressoClient.getFrom<number>(url, 'status/block-height', 8000);
      em.failCount = 0;
      // A responding endpoint whose height doesn't advance across two
      // consecutive checks is as useless as a dead one.
      if (em.lastHeight !== null && height <= em.lastHeight) {
        em.staleCount += 1;
      } else {
        em.staleCount = 0;
      }
      em.lastHeight = height;
      ev.lastHeight = height;
      const nowHealthy = em.staleCount < 2;
      if (!nowHealthy && !em.unhealthy) {
        em.unhealthy = true;
        em.downSince = Date.now();
        if (cfg.queryHealthAlerts && cooldownOk(`${net.name}:ep:${url}:stale`)) {
          em.alerted = true;
          await sendAlert({
            severity: 'warning',
            title: `Query endpoint height is stuck`,
            lines: [`${url} responds but its block height hasn't advanced for 2 consecutive checks (${height}).`],
            network: net.name,
          });
        }
      } else if (nowHealthy && em.unhealthy) {
        await endpointRecovered(net, em, url);
      }
      ev.healthy = nowHealthy;
    } catch {
      em.failCount += 1;
      if (em.failCount >= 2 && !em.unhealthy) {
        em.unhealthy = true;
        em.downSince = Date.now();
        if (cfg.queryHealthAlerts && cooldownOk(`${net.name}:ep:${url}:down`)) {
          em.alerted = true;
          await sendAlert({
            severity: 'warning',
            title: `Query endpoint offline`,
            lines: [`${url} failed ${em.failCount} consecutive health checks.`],
            network: net.name,
          });
        }
      }
      if (em.failCount >= 2) ev.healthy = false;
    }
  }

  await checkAllOffline(net, m);
  publish();
}

async function endpointRecovered(net: NetworkConfig, em: EndpointMachine, url: string): Promise<void> {
  const wasAlerted = em.alerted;
  const since = em.downSince;
  em.unhealthy = false;
  em.alerted = false;
  em.downSince = null;
  em.staleCount = 0;
  if (cfg.queryHealthAlerts && wasAlerted) {
    await sendAlert({
      severity: 'recovered',
      title: `Query endpoint back online`,
      lines: [`${url} is healthy again${since ? ` after ${mins(since)}` : ''}.`],
      network: net.name,
    });
  }
}

async function checkAllOffline(net: NetworkConfig, m: NetworkMachine): Promise<void> {
  const allDown = m.endpoints.every((e) => e.unhealthy);
  const ao = m.allOffline;
  if (allDown) {
    if (!ao.isOffline) {
      ao.isOffline = true;
      ao.since = Date.now();
      ao.alertSent = false;
    }
    // Damping: only alert after 3 minutes of uninterrupted all-down.
    if (!ao.alertSent && ao.since !== null && Date.now() - ao.since >= 3 * 60_000) {
      ao.alertSent = true;
      // Cross-check chain progress through an independent source (the
      // local node, if configured) so the alert can say whether the
      // network is fine and the problem is local.
      let context = 'No independent source available to cross-check chain progress.';
      if (cfg.localNodeUrl) {
        try {
          const h1 = await EspressoClient.getFrom<number>(cfg.localNodeUrl, 'status/block-height', 6000);
          await new Promise((r) => setTimeout(r, 4000));
          const h2 = await EspressoClient.getFrom<number>(cfg.localNodeUrl, 'status/block-height', 6000);
          context =
            h2 > h1
              ? 'Your local node is still advancing — the chain is fine, check your connectivity/rate limits to the query endpoints.'
              : 'Your local node is not advancing either — this may be a network-wide issue.';
        } catch {
          context = 'Local node is also unreachable.';
        }
      }
      if (cfg.queryHealthAlerts) {
        await sendAlert({
          severity: 'critical',
          title: `All query endpoints offline on ${net.name}`,
          lines: [`All ${m.endpoints.length} configured endpoint(s) have been down for 3+ minutes.`, context],
          network: net.name,
        });
      }
    }
  } else if (ao.isOffline) {
    const wasAlerted = ao.alertSent;
    const since = ao.since;
    ao.isOffline = false;
    ao.since = null;
    ao.alertSent = false;
    if (cfg.queryHealthAlerts && wasAlerted) {
      await sendAlert({
        severity: 'recovered',
        title: `Query endpoints recovered on ${net.name}`,
        lines: [`At least one endpoint is healthy again${since ? ` after ${mins(since)}` : ''}.`],
        network: net.name,
      });
    }
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
  const mainnet = machines.get('mainnet') ?? [...machines.values()][0];

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
        lines: [`${cfg.localNodeUrl} is reachable again${lm.downSince ? ` after ${mins(lm.downSince)}` : ''}.`],
      });
      lm.downSince = null;
    }

    const remoteHeight = mainnet?.view.height ?? null;
    if (remoteHeight !== null) {
      const lag = remoteHeight - height;
      view.lagBlocks = lag;
      if (lag > cfg.heightLagBlocks) {
        if (lm.initialized && !lm.lagAlerted && cooldownOk('local:lag')) {
          lm.lagAlerted = true;
          await sendAlert({
            severity: 'warning',
            title: 'Local node is falling behind',
            lines: [`Local height ${height} vs network ${remoteHeight} — ${lag} blocks behind (threshold ${cfg.heightLagBlocks}).`],
          });
        }
      } else if (lm.lagAlerted) {
        lm.lagAlerted = false;
        await sendAlert({
          severity: 'recovered',
          title: 'Local node caught up',
          lines: [`Local height ${height}, ${Math.max(lag, 0)} blocks behind the network.`],
        });
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
          lines: [`${cfg.localNodeUrl} failed ${lm.failCount} consecutive checks.`],
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
    timers.push(setInterval(() => void pollEndpointHealth(net), Math.max(cfg.pollIntervalSec, 30) * 1000));
  }

  if (cfg.localNodeUrl) {
    localMachine = { failCount: 0, downAlerted: false, downSince: null, lagAlerted: false, initialized: false };
    store.localNode = { url: cfg.localNodeUrl, reachable: null, height: null, lagBlocks: null };
    void pollLocalNode();
    timers.push(setInterval(() => void pollLocalNode(), Math.max(cfg.statusPollIntervalSec, 15) * 1000));
  }

  const watched = cfg.networks
    .map((n) => `${n.name}: ${n.validators.map((v) => v.label).join(', ')}`)
    .join(' | ');
  void sendAlert({
    severity: 'info',
    title: 'espressoduty started',
    lines: [
      watched ? `Watching — ${watched}` : 'No validators configured yet.',
      `Poll interval: ${cfg.pollIntervalSec}s, status: ${cfg.statusPollIntervalSec}s.`,
      `Channels: ${store.channels.join(', ') || 'none'}.`,
      cfg.localNodeUrl ? `Local node checks enabled (${cfg.localNodeUrl}).` : 'Local node checks disabled.',
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
      lines: [`Received ${reason}. Monitoring and alerting stop until the process is back.`],
    }),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}
