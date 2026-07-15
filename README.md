# espressoduty

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-14-black)

Uptime monitoring and alerting for [Espresso Network](https://espressosys.com/) validators.

espressoduty tracks chain-reported missed leader slots, monitors local node
health, and sends alerts through Telegram, Discord, Slack and PagerDuty.
The dashboard runs on port 3030 and updates over server-sent events.

<img width="906" height="576" alt="image" src="https://github.com/user-attachments/assets/cab41479-a8d8-4050-8a71-924d8e0696f1" />


## Local vs public mode

Missed slots and votes come from the chain in both modes — no node-side
setup is needed for accurate counts.

- **Local mode** (`LOCAL_NODE_URL` set) adds node health: node-down and
  sync-lag alerts, instant stuck detection via the decide-view counter,
  and the node's own counters back up the dashboard if the staking API is
  ever unreachable.
- **Public-only mode**: a dead node is only visible once it misses leader
  slots on chain — delayed, but nothing to install.

## Quick start

```bash
git clone https://github.com/s0urledd/espressoduty.git
cd espressoduty
cp .env.example .env   # add your validator and channels
npm install
npm run build
pm2 start ecosystem.config.js   # or: docker compose up -d --build
```

Dashboard: `http://localhost:3030`. The startup alert doubles as a channel
test: every configured channel gets a message each time espressoduty starts.

The dashboard is read-only but unauthenticated — keep it on localhost or a
VPN, or put an authenticated reverse proxy in front before exposing it
(the docker-compose file binds to loopback for this reason).

## Configuration

Everything lives in `.env` ([.env.example](.env.example) is the full list):

| Variable | Default | Purpose |
|---|---|---|
| `MAINNET_VALIDATORS` | — | `Label=0xaddress` or `Label=BLS_VER_KEY~...`, comma separated |
| `TESTNET_VALIDATORS` | — | Same shapes, Decaf network; empty = testnet never polled |
| `STAKING_API` | cache.main.net | Chain-derived missed-slot / vote counts; comma-separate extras for failover |
| `QUERY_NODE` | public query service | Identity and network status; comma-separate extras for failover |
| `LOCAL_NODE_URL` | — | Your node's query service: local checks, instant stuck detection, exact slot counts |
| `CONSECUTIVE_MISSES_WARN` / `CONSECUTIVE_MISSES_CRIT` | `3` / `5` | Missed leader slots: chat / PagerDuty |
| `LOCAL_DOWN_FAILS` / `HEIGHT_LAG_BLOCKS` | `5` / `50` | Local node monitoring |
| `LOCAL_DOWN_PAGE_MIN` / `STUCK_AFTER_MIN` | `10` / `5` | Minutes before down pages / stuck alerts |
| `DECIDE_STALL_SEC` | `300` | Seconds without a finalized block before the chain-stall alert |
| `POLL_INTERVAL_SEC` | `60` | Poll cadence |
| `HEARTBEAT_URL` | — | Dead man's switch: GET after every successful poll |
| `STATE_FILE` | `./state.json` | Restart-durable counters and grid |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `PAGERDUTY_ROUTING_KEY` | — | Channels |

## Leader duty

Leader duty is the primary uptime signal. Missing a leader slot causes the
view to time out. A non-leader vote may be excluded once a QC has formed
from roughly two-thirds of stake, so vote participation is shown as a
latency and connectivity metric rather than an uptime alert.

Missed slots come from the staking API's per-epoch proposal and slot
counters, the same source used by stake.espresso.network.

Poll to poll:

- missed count increased: one or more leader slots were missed
- proposal count increased: the validator proposed successfully
- neither changed: no leader duty occurred during the poll window

Three consecutive misses trigger a chat alert. Five trigger PagerDuty.
A successful proposal clears the streak and resolves the incident.

Counters persist to `STATE_FILE`: a restart continues the streak, and a
miss that lands during the restart shows up as a delta afterwards. An
epoch rollover resets counters (they restart with the epoch by design)
and resolves anything left open.

Also watched:

| Alert | Severity |
|---|---|
| Validator not in the active set (dropped out / wrong key or address) | critical, pages |
| No decide for `DECIDE_STALL_SEC` (5m), cross-checked against other endpoints first | critical (warning if only the endpoint is stale) |
| Local node unreachable (`LOCAL_DOWN_FAILS` consecutive fails): chat immediately, PagerDuty if still down after `LOCAL_DOWN_PAGE_MIN` (10m) | critical |
| Local node lagging (`HEIGHT_LAG_BLOCKS`) | warning |
| Node consensus stuck: reachable but `last_decided_view` frozen for `STUCK_AFTER_MIN` (5m) while the network progresses; PagerDuty after `LOCAL_DOWN_PAGE_MIN` (needs a local node with metrics) | critical |
| Staking API unreachable for 60m (miss alerts paused meanwhile) | warning |
| Start / shutdown | info |

While the local node is down or lagging, miss alerts are suppressed: the
local-node alert is the root cause, the missed slots are its symptom (the
counter itself keeps following the chain). Every alert has a paired
recovery and repeats respect a cooldown.

`HEARTBEAT_URL` covers espressoduty itself: a GET fires after every
successful poll, so [healthchecks.io](https://healthchecks.io) or
[Uptime Kuma](https://github.com/louislam/uptime-kuma) can alert you when
espressoduty stops running.

## Dashboard

Each validator card shows uptime (proposals / leader slots this epoch)
and, beside it, the raw missed-slot count (`1 / 56`) — chain-derived, the
exact numbers stake.espresso.network shows. Vote participation sits as a
small neutral figure in the stats row. Below, a 50-slot leader-duty grid:
one cell per poll — red when a leader slot was missed in that window,
green when duty was met or no slot landed, faint before the first leader
slot of the epoch, empty when the poll returned no data. Thin lines mark
epoch boundaries. The grid and counters survive restarts via `STATE_FILE`.

## Prometheus (optional)

`GET /metrics` serves everything on the dashboard in Prometheus format —
participation, miss counts, set membership, network and local-node status.
Point your existing Prometheus/Grafana at it, or ignore it entirely: no
config, nothing else depends on it.

## Data sources

- `staking/nodes/active` (staking API): per-validator leader-slot and vote
  counts for the current epoch, derived from the chain — missed slots,
  uptime, votes and set membership all come from here
- `node/validators/:epoch` (query service): account, stake, commission,
  delegators, and the 0x address → BLS key resolution
- `status/block-height`, `status/time-since-last-decide`: chain height and
  network liveness (the chain-stall check)
- `status/metrics` (local node only): the `last_decided_view` counter for
  the instant stuck check; the node's leader counters serve as a display
  backup while the staking API is unreachable

Sources fail over in order; the status line's `src` shows which one served
the last poll.

MIT licensed.
