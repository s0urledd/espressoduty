// Prometheus exposition of the same store the dashboard reads. Optional by
// nature: point a scraper at GET /metrics if you run Prometheus/Grafana,
// ignore it otherwise — nothing else references this endpoint. Read-only,
// zero dependencies (the text format is just lines).

import { getStore } from '@/lib/state';

export const dynamic = 'force-dynamic';

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(pairs: Record<string, string>): string {
  const body = Object.entries(pairs)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(',');
  return body ? `{${body}}` : '';
}

export function GET() {
  const s = getStore();
  const out: string[] = [];
  // A metric is emitted only when the value is known; absence means the
  // poller has not learned it yet (standard Prometheus practice).
  const gauge = (name: string, help: string, rows: Array<[Record<string, string>, number | null]>) => {
    const known = rows.filter((r): r is [Record<string, string>, number] => r[1] !== null && Number.isFinite(r[1]));
    if (known.length === 0) return;
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [lb, v] of known) out.push(`${name}${labels(lb)} ${v}`);
  };

  gauge('espressoduty_start_time_seconds', 'Unix time the monitor started', [[{}, s.startedAt / 1000]]);

  for (const net of s.networks.values()) {
    const nl = { network: net.name };
    gauge('espressoduty_block_height', 'Network block height', [[nl, net.height]]);
    gauge('espressoduty_epoch', 'Current epoch', [[nl, net.epoch]]);
    gauge('espressoduty_seconds_since_decide', 'Seconds since the network finalized a block', [
      [nl, net.timeSinceLastDecide],
    ]);

    for (const v of net.validators) {
      const vl = { network: net.name, validator: v.label };
      gauge('espressoduty_proposal_participation_ratio', 'Leader-duty uptime this epoch (0-1, chain-derived)', [
        [vl, v.proposal],
      ]);
      gauge('espressoduty_vote_participation_ratio', 'Vote participation this epoch (0-1, informational)', [
        [vl, v.vote],
      ]);
      gauge('espressoduty_epoch_miss_events', 'Missed leader slots this epoch', [[vl, v.epochMissCount]]);
      gauge('espressoduty_leader_slots_total', 'Leader slots this epoch (chain-derived)', [[vl, v.leaderSlots]]);
      gauge('espressoduty_missed_leader_slots_total', 'Missed leader slots this epoch (chain-derived)', [
        [vl, v.missedLeaderSlots],
      ]);
      gauge('espressoduty_in_active_set', 'Validator is in the active set (0/1)', [
        [vl, v.inActiveSet === null ? null : v.inActiveSet ? 1 : 0],
      ]);
      gauge('espressoduty_validator_ok', 'Leader-duty health is ok (0/1)', [[vl, v.health === 'ok' ? 1 : 0]]);
      gauge('espressoduty_stake_esp', 'Stake in ESP', [[vl, v.stakeEsp]]);
      gauge('espressoduty_delegators', 'Delegator count', [[vl, v.delegatorCount]]);
    }
  }

  const ln = s.localNode;
  if (ln) {
    gauge('espressoduty_local_node_up', 'Local node reachable (0/1)', [
      [{}, ln.reachable === null ? null : ln.reachable ? 1 : 0],
    ]);
    gauge('espressoduty_local_node_height', 'Local node block height', [[{}, ln.height]]);
    gauge('espressoduty_local_node_lag_blocks', 'Blocks behind the network', [[{}, ln.lagBlocks]]);
    gauge('espressoduty_local_node_stuck', 'Local consensus stuck while the network progresses (0/1)', [
      [{}, ln.stuck ? 1 : 0],
    ]);
  }

  return new Response(out.join('\n') + '\n', {
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}
