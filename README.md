# espressoduty

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-14-black)

Uptime monitoring and alerting for [Espresso Network](https://espressosys.com/)
validators. Watches missed slots and vote participation, catches chain stalls
and set drops, keeps an eye on your node, and alerts over Telegram, Discord,
Slack or PagerDuty. The dashboard on port 3030 updates live over server-sent
events.

Works with no node at all against the public query service. Point
`LOCAL_NODE_URL` at your own node to add reachability and sync-lag checks.
Each poll reads all participation metrics from a single source: your node
when it is reachable and in sync, the public endpoints otherwise — never a
mix, and never an out-of-sync node.

![dashboard, light theme](docs/dashboard-light.png)

<details>
<summary>dark theme</summary>

![dashboard, dark theme](docs/dashboard-dark.png)

</details>

## Alerts

The headline metric is **missed slots**, the number Espresso's own staking
dashboard leads with: `1 - proposal_participation`, the fraction of leader
slots where the validator failed to propose.

| Alert | Severity | Recovery |
|---|---|---|
| Missed slots above `MISSED_CRITICAL` / `MISSED_WARN` | critical (pages) / warning | yes |
| Vote participation below `VOTE_CRITICAL` / `VOTE_WARN` | critical / warning, chat only | yes |
| Missing from the participation map | critical, pages | yes |
| No decide for `DECIDE_STALL_SEC` | critical, or warning if only the endpoint is stale | yes |
| Local node unreachable / lagging | critical / warning | yes |
| Start / shutdown | info | — |

Rules that keep it quiet:

- Nothing fires on the first poll after a restart, repeats respect a cooldown,
  and every alert has a matching recovery with the worst value and duration.
- A key absent from the proposal map shows a dash, like stake.espresso.network.
  Not being leader this epoch is not a failure and never alerts. Once a real
  value has been seen, it is held for the rest of the epoch so one incomplete
  poll cannot flip the card back to a dash.
- Participation rates reset at each epoch, so threshold alerts are suppressed
  for the first `EPOCH_MIN_SAMPLE_MIN` minutes after a rollover.
- While the local node is down or lagging, participation alerts stay quiet:
  the local-node alert is the root cause. Missed-slots alerts stay quiet for
  the rest of that epoch — the cumulative average keeps reporting slots lost
  during the outage, which nobody can act on anymore.
- The local node counts as down only after `LOCAL_DOWN_FAILS` consecutive
  failed checks; one slow response from a busy node is not an outage.
- A chain-stall alert is cross-checked against the other endpoints first, so a
  stale endpoint doesn't masquerade as a network halt.
- PagerDuty pages only on missed slots (after `PAGERDUTY_THRESHOLD`
  consecutive criticals) and on dropping out of the set.

## Quick start

```bash
git clone https://github.com/s0urledd/espressoduty.git
cd espressoduty
cp .env.example .env   # add your BLS key(s) and alert channels
npm install
npm run build
```

PM2 (recommended):

```bash
pm2 start ecosystem.config.js
```

Docker:

```bash
docker compose up -d --build
```

Dashboard: `http://localhost:3030`. Test alert:
`curl -X POST http://localhost:3030/api/alert`

## Configuration

All settings live in `.env`, fully commented in
[.env.example](.env.example). The essentials:

| Variable | Default | Purpose |
|---|---|---|
| `MAINNET_VALIDATORS` | — | BLS keys, comma separated. `Label=BLS_VER_KEY~...` adds a name |
| `LOCAL_NODE_URL` | — | Your node's query service: primary read source + local checks |
| `MISSED_WARN` / `MISSED_CRITICAL` | `0.50` / `0.90` | Missed-slots thresholds |
| `VOTE_WARN` / `VOTE_CRITICAL` | `0.90` / `0.50` | Vote thresholds, chat only |
| `POLL_INTERVAL_SEC` | `60` | Participation poll |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | — | Telegram |
| `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` | — | Webhooks |
| `PAGERDUTY_ROUTING_KEY` + `PAGERDUTY_THRESHOLD` | — / `3` | Paging |

## Data sources

Everything comes from the Espresso query service (`/v1`). Semantics verified
against the node's own API reference:

- `node/participation/proposal/current`: fraction of views where the key
  proposed properly as leader. Missed slots = 1 - value.
- `node/participation/vote/current`: fraction of views properly voted.
- `node/stake-table/current`: current epoch number, set membership, stake.
- `node/validators/:epoch`, `node/all-validators/...`: account, commission
  (basis points), delegators. Used to tell "dropped from the set" from
  "wrong key".
- `status/block-height`, `status/time-since-last-decide`: liveness.

Participation numbers are subjective per serving node, which is why every
poll is served by one source and an out-of-sync local node is never used.
Values can still differ from stake.espresso.network, whose missed-slots
column comes from a separate streaming aggregator with its own observation
window; the definition is the same, the window is not.

State lives in memory: a restart starts clean, which is also why the first
poll never alerts.

## Roadmap

Per-endpoint health alerting, participation trend detection for public-only
setups, epoch history. The groundwork (endpoint failover, epoch tracking) is
in place.

MIT licensed.
