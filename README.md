# espressoduty

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-14-black)

Uptime monitoring and alerting for [Espresso Network](https://espressosys.com/) validators.
Watches your validators' vote participation, catches chain stalls and
set drops, keeps an eye on your node, and pages you over Telegram, Discord,
Slack or PagerDuty. Ships with a live dashboard on port 3030 that updates
over server-sent events — no refresh interval, no page reloads.

Point it at your own node and it reads everything from there (fastest data,
no public rate limits) with the public query service as automatic fallback —
or run it with no node at all against the public endpoints.

![dashboard, light theme](docs/dashboard-light.png)

<details>
<summary>dark theme</summary>

![dashboard, dark theme](docs/dashboard-dark.png)

</details>

## What it watches

The headline metric is **missed slots**, the same number Espresso's own
staking dashboard leads with: how often the validator fails to propose when
it is its turn, computed as `1 - proposal_participation` from the query
service. Vote participation stays as a secondary, technical signal.

| Alert | Severity | Recovery |
|---|---|---|
| Missed slots above `MISSED_CRITICAL` | critical, pages after `PAGERDUTY_THRESHOLD` consecutive polls | yes, with worst value + duration |
| Missed slots above `MISSED_WARN` | warning | yes |
| Vote participation below `VOTE_CRITICAL` / `VOTE_WARN` | critical / warning, chat only | yes, with incident low + duration |
| Validator missing from the participation map (dropped from the set / deregistered / wrong key) | critical, pages | yes |
| No decide for `DECIDE_STALL_SEC` — cross-checked against the other endpoints so a stale endpoint doesn't masquerade as a chain halt | critical (warning if only the endpoint is stale) | yes |
| Local node unreachable / falling behind the network | critical / warning | yes |
| Monitor start / shutdown | info | — |

Every alert has a matching recovery message, repeated alerts respect a
cooldown, and nothing ever fires on the first poll after a restart. While
the local node is down or lagging, participation alerts are suppressed:
the local-node alert is the root cause and a syncing node's data is stale.

Two cases that deliberately never alert:

- **No leader slots yet.** When the key is absent from the proposal map,
  missed slots shows a dash, exactly like stake.espresso.network. Not being
  leader this epoch is not a failure.
- **Young epochs.** Participation rates reset at every rollover and a single
  missed view early in an epoch reads as a catastrophic rate, so threshold
  alerts skip the first few samples of each new epoch.

## Quick start

```bash
git clone https://github.com/s0urledd/espressoduty.git
cd espressoduty
cp .env.example .env   # add your BLS key(s) and alert channels
npm install
npm run build
```

Run with PM2 (recommended):

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 logs espressoduty
```

Or with Docker:

```bash
docker compose up -d --build
```

The dashboard is at `http://localhost:3030`. Send a test alert with:

```bash
curl -X POST http://localhost:3030/api/alert
```

## Configuration

Everything is configured through `.env` (see [.env.example](.env.example) for
the full commented list).

| Variable | Default | Purpose |
|---|---|---|
| `MAINNET_VALIDATORS` | — | Comma-separated BLS keys. `Label=BLS_VER_KEY~...` attaches a display name |
| `LOCAL_NODE_URL` | — | Your node's query service; becomes the primary read source and enables local-down + sync-lag checks |
| `MAINNET_QUERY_NODES` | public query node | Fallback read sources, in order |
| `TESTNET_VALIDATORS` / `TESTNET_QUERY_NODES` | — | Same, for the Decaf testnet |
| `MISSED_WARN` / `MISSED_CRITICAL` | `0.50` / `0.90` | Missed-slots thresholds (primary, pages) |
| `VOTE_WARN` / `VOTE_CRITICAL` | `0.90` / `0.50` | Vote participation thresholds (secondary, chat only) |
| `DECIDE_STALL_SEC` | `60` | Seconds without a decide before the chain counts as stalled |
| `HEIGHT_LAG_BLOCKS` | `20` | Local-node lag tolerance |
| `ALERT_COOLDOWN_MIN` | `30` | Minimum minutes between repeats of the same alert |
| `POLL_INTERVAL_SEC` | `60` | Participation poll interval |
| `STATUS_POLL_INTERVAL_SEC` | `10` | Fast status poll driving the live dashboard and stall detection |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | — | Telegram channel |
| `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` | — | Webhook channels |
| `PAGERDUTY_ROUTING_KEY` + `PAGERDUTY_THRESHOLD` | — / `3` | Page after N consecutive critical polls |

## Dashboard

One page, dark and light themes, pushed live over SSE. Each validator card
shows vote, proposal and missed slots as big numbers with threshold-colored
status dots, a tenderduty-style poll grid underneath (one cell per poll,
never per block: Espresso has no per-block miss stream, and an empty cell
means that poll returned no data), and a health stripe on the card edge
readable from across the room. A one-line network status shows height,
seconds since the last decide, current epoch and which source is being
read from.

State lives in memory. A restart starts clean, which is also why the first
poll never alerts.

## Data sources

Everything comes from the Espresso query service (`/v1`), local node first
when configured:

- `node/participation/proposal/current` — proposal participation; missed
  slots = 1 - value, matching stake.espresso.network
- `node/participation/vote/current` — vote participation rates
- `node/stake-table/current` — current epoch number, set membership, stake
- `node/validators/:epoch`, `node/all-validators/...` — identity, commission,
  delegators; used to tell "dropped from the set" from "wrong key"
- `status/block-height`, `status/time-since-last-decide`,
  `status/success-rate` — liveness

## Roadmap

Deliberately not in the MVP: per-endpoint health alerting with failover
notifications, proposal-participation alerts, participation trend detection
for public-only setups, and an epoch history view. The groundwork (ordered
endpoint failover, epoch tracking) is already in place.

MIT licensed.
