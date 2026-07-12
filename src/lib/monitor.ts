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
import { getStore, publish, type NetworkView, type ValidatorView, type EndpointView } from './state';

const cfg = loadConfig();

// A fresh epoch's rate is computed over a handful of views: one missed
// view can read as a catastrophic 0.0. Skip absolute-threshold alerts for
// the first few samples after a rollover (recoveries still fire).
const EPOCH_GRACE_SAMPLES = 3;

// ---------------------------------------------------------------------------
// Internal (non-view) state
// ---------------------------------------------------------------------------

interface ValidatorMachine {
  initialized: boolean;
  voteStatus: 'ok' | 'warn' | 'crit';
  voteAlerted: boolean;
  voteLowest: number | null;
  voteIncidentStart: number | null;
  pdConsecutiveCrit: number;
  pdTriggered: boolean;
  missingCount: number;
  missingAlerted: boolean;
  missingSince: number | null;
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
        health: 'unknown',
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
          voteStatus: 'ok',
          voteAlerted: false,
          voteLowest: null,
          voteIncidentStart: null,
          pdConsecutiveCrit: 0,
          pdTriggered: false,
          missingCount: 0,
          missingAlerted: false,
          missingSince: null,
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

  const inGrace = m.epochGraceLeft > 0;
  if (m.epochGraceLeft > 0) m.epochGraceLeft -= 1;

  for (const vv of m.view.validators) {
    const vm = m.validators.get(vv.key)!;
    const vote = Object.prototype.hasOwnProperty.call(voteMap, vv.key) ? voteMap[vv.key] : null;

    vv.inActiveSet = stakeByKey.has(vv.key);
    const stakeHex = stakeByKey.get(vv.key);
    if (stakeHex) vv.stakeEsp = hexStakeToEsp(stakeHex);
    vv.vote = vote;
    // Dashboard-only; a validator with rare leader slots should never page.
    vv.proposal = Object.prototype.hasOwnProperty.call(proposalMap, vv.key) ? proposalMap[vv.key] : null;

    if (vote === null) {
      await onValidatorMissing(net, m, vv, vm, epoch);
    } else {
      await onValidatorPresent(net, vv, vm, vote, epoch, inGrace);
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
  vv: ValidatorView,
  vm: ValidatorMachine,
  vote: number,
  epoch: number,
  inGrace: boolean,
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

  const status: ValidatorMachine['voteStatus'] =
    vote < cfg.voteCritical ? 'crit' : vote < cfg.voteWarn ? 'warn' : 'ok';

  if (status === 'crit') {
    vm.pdConsecutiveCrit += 1;
  } else {
    vm.pdConsecutiveCrit = 0;
  }

  if (!vm.initialized || inGrace) {
    // Seed state silently; recoveries still pair with earlier alerts.
    if (status === 'ok') await maybeVoteRecovery(net, vv, vm, vote, epoch);
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

  await maybeVoteRecovery(net, vv, vm, vote, epoch);
  vm.voteStatus = 'ok';
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
  if (!vm.initialized) return;
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
          ? `Query endpoint is stale on ${net.name}`
          : `No decide for ${Math.round(tsld)}s on ${net.name}`,
        lines: secondarySeesProgress
          ? [
              `The active query endpoint reports ${Math.round(tsld)}s since the last decide, but another endpoint sees the chain advancing.`,
              `This points at the endpoint (or a rate limit), not the network. Switched to the healthy endpoint.`,
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
        lines: [`${cfg.localNodeUrl} is reachable again${lm.downSince ? ` after ${mins(lm.downSince)}` : ''}.`],
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
    .map((n) => `${n.name}: ${n.validators.map((v) => v.label).join(', ')}`)
    .join(' | ');
  void sendAlert({
    severity: 'info',
    title: 'espressoduty started',
    lines: [
      watched ? `Watching — ${watched}` : 'No validators configured yet.',
      `Poll interval: ${cfg.pollIntervalSec}s, status: ${cfg.statusPollIntervalSec}s.`,
      `Channels: ${store.channels.join(', ') || 'none'}.`,
      cfg.localNodeUrl
        ? `Reading from local node first (${cfg.localNodeUrl}), public query nodes as fallback.`
        : 'Reading from the public query service.',
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
