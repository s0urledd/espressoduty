# espressoduty

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-14-black)

Uptime monitoring and alerting for [Espresso Network](https://espressosys.com/)
validators. Watches leader duty (missed slots) poll by poll, alerts on
consecutive missed leader slots, checks your node's liveness, and pages you
over Telegram, Discord, Slack or PagerDuty. The dashboard on port 3030 updates live over server-sent
events.

<img width="906" height="576" alt="image" src="https://github.com/user-attachments/assets/cab41479-a8d8-4050-8a71-924d8e0696f1" />


## The alert rule: leader duty

A validator is only on the critical path when it is the **leader**: miss
your slot and the view times out; miss a vote as a non-leader and the QC
closes at ~2/3 quorum without you. Vote participation therefore mostly
measures the quorum race (network latency, geography), not node health —
which is why Espresso's own dashboard leads with missed slots and so does
espressoduty.

The cumulative proposal rate only moves when your validator is leader, so
its per-poll change is a real event:

- rate fell = **missed leader slot**. `CONSECUTIVE_MISSES_WARN` (3) in a
  row → Telegram / Slack / Discord; `CONSECUTIVE_MISSES_CRIT` (5) in a
  row → PagerDuty. A streak means the node is failing its critical duty;
  a successful proposal clears it.
- rate rose = **successful proposal** → streak resets, recovery sent,
  PagerDuty incident resolved.
- rate flat = no leader slot in that window (slots are sparse, that is
  normal).

Counters persist to `STATE_FILE`, so a bot restart continues the streak
instead of forgetting it. An epoch rollover resets counters cleanly (rates
restart by design — that is not an alert) and resolves anything left open.

Also watched:

| Alert | Severity |
|---|---|
| Validator missing from the participation map (dropped from set / wrong key) | critical, pages |
| No decide for 60s, cross-checked against other endpoints first | critical (warning if only the endpoint is stale) |
| Local node unreachable (`LOCAL_DOWN_FAILS` consecutive fails): chat immediately, PagerDuty if still down after `LOCAL_DOWN_PAGE_MIN` (10m) | critical |
| Local node lagging (`HEIGHT_LAG_BLOCKS`) | warning |
| Node consensus stuck: reachable but `last_decided_view` frozen for `STUCK_AFTER_MIN` (5m) while the network progresses; PagerDuty after `LOCAL_DOWN_PAGE_MIN` (needs a local node with metrics) | critical |
| Start / shutdown | info |

While the local node is down or lagging, the miss counter freezes: the
local-node alert is the root cause, participation dips are its symptom.
Every alert has a paired recovery and repeats respect a cooldown.

And for the one failure espressoduty cannot report itself — its own death —
set `HEARTBEAT_URL`: a GET fires after every successful poll, and a service
like [healthchecks.io](https://healthchecks.io) or
[Uptime Kuma](https://github.com/louislam/uptime-kuma) alerts you when the
pings stop.

## Local vs public mode

- **Local mode** (`LOCAL_NODE_URL` set): exact missed-slot counts from your
  node's Prometheus counters (`0 / 35`), instant stuck detection via the
  decide-view counter, plus the node-down and sync-lag alerts.
- **Public-only mode**: the missed count is derived from the proposal rate,
  and a dead node only shows up as a participation drop — delayed, but no
  node-side setup needed.

## Quick start

```bash
git clone https://github.com/s0urledd/espressoduty.git
cd espressoduty
cp .env.example .env   # add your validator and channels
npm install
npm run build
pm2 start ecosystem.config.js   # or: docker compose up -d --build
```

Dashboard: `http://localhost:3030`. Test alert:
`curl -X POST http://localhost:3030/api/alert`

A validator can be given as its L1 address instead of the BLS key —
`MAINNET_VALIDATORS=Huginn=0xyouraddress` — and espressoduty resolves it
to the BLS key from the registry on the first poll.

## Configuration

Everything lives in `.env` ([.env.example](.env.example) is the full list):

| Variable | Default | Purpose |
|---|---|---|
| `MAINNET_VALIDATORS` | — | `Label=0xaddress` or `Label=BLS_VER_KEY~...`, comma separated |
| `QUERY_NODE` | public query service | Data source; comma-separate extras for failover |
| `LOCAL_NODE_URL` | — | Your node's query service: local checks, instant stuck detection, exact slot counts |
| `CONSECUTIVE_MISSES_WARN` / `CONSECUTIVE_MISSES_CRIT` | `3` / `5` | Missed leader slots: chat / PagerDuty |
| `LOCAL_DOWN_FAILS` / `HEIGHT_LAG_BLOCKS` | `5` / `50` | Local node monitoring |
| `LOCAL_DOWN_PAGE_MIN` / `STUCK_AFTER_MIN` | `10` / `5` | Minutes before down pages / stuck alerts |
| `POLL_INTERVAL_SEC` | `60` | Poll cadence |
| `HEARTBEAT_URL` | — | Dead man's switch: GET after every successful poll |
| `STATE_FILE` | `./state.json` | Restart-durable counters and grid |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `PAGERDUTY_ROUTING_KEY` | — | Channels |

## Dashboard

Each validator card shows uptime (proposal participation, the positive
pole of missed slots) and, beside it, the raw missed-slot count: exact
numbers from your node's metrics when a local node is configured
(`0 / 35`, since node start) or the miss events observed this epoch
otherwise. Vote participation sits as a small neutral figure in the stats
row. Below, a 50-slot leader-duty grid: one cell per poll, red when
the rate fell in that window (missed leader slot), green when it rose or
held steady (duty intact), faint until the epoch has proposal data, empty
when the poll returned no data. Thin lines mark epoch boundaries. The grid
and counters survive restarts via `STATE_FILE`.

Missed slots is Espresso's own headline metric (`1 - proposal_participation`,
as on stake.espresso.network). Proposal tracking is live-only per node and
the public endpoint balances over backends with differing state, so sources
are probed until one has the data. A value seen once is held for the epoch
and survives restarts; 0% only ever means the data really says 0%, and
"no data" means no source has reported proposal data for the epoch yet.

## Data sources

Espresso query service (`/v1`), semantics verified against the node's own
API reference:

- `node/participation/vote/current`: fraction of views properly voted
- `node/participation/proposal/current`: fraction of leader slots proposed
  properly; missed slots = 1 - value
- `node/stake-table/current`: epoch number, set membership, stake
- `node/validators/:epoch`: account, commission, delegators
- `status/block-height`, `status/time-since-last-decide`: chain height and
  network liveness (the chain-stall check)
- `status/metrics` (local node only): Prometheus counters — exact
  leader-slot counts and `last_decided_view`, the instant stuck check

Each poll is served by a single source (local node when in sync, public
otherwise) so subjective per-node views are never mixed.

MIT licensed.
