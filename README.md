# espressoduty

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-14-black)

Uptime monitoring and alerting for [Espresso Network](https://espressosys.com/)
validators. Polls vote participation every minute, alerts when it keeps
dropping, watches your node's liveness, and pages you over Telegram, Discord,
Slack or PagerDuty. The dashboard on port 3030 updates live over server-sent
events.

![dashboard, light theme](docs/dashboard-light.png)

<details>
<summary>dark theme</summary>

![dashboard, dark theme](docs/dashboard-dark.png)

</details>

## The alert rule

Espresso publishes participation as a per-epoch average, so a healthy node's
number climbs every poll and a node that misses views drags it down. The rule
is exactly that:

- vote dropped **3 polls in a row** (`CONSECUTIVE_DROPS_WARN`) → Telegram /
  Slack / Discord
- vote dropped **5 polls in a row** (`CONSECUTIVE_DROPS_CRIT`) → PagerDuty
- first rising poll → recovery message, PagerDuty incident resolved

Counters persist to `STATE_FILE`, so a bot restart continues the streak
instead of forgetting it. An epoch rollover resets counters cleanly (rates
restart near zero by design — that is not an alert) and resolves anything
left open.

Also watched:

| Alert | Severity |
|---|---|
| Validator missing from the participation map (dropped from set / wrong key) | critical, pages |
| No decide for 60s, cross-checked against other endpoints first | critical (warning if only the endpoint is stale) |
| Local node unreachable (`LOCAL_DOWN_FAILS` consecutive fails) / lagging (`HEIGHT_LAG_BLOCKS`) | critical / warning |
| Start / shutdown | info |

While the local node is down or lagging, the drop counter freezes: the
local-node alert is the root cause, participation dips are its symptom.
Every alert has a paired recovery and repeats respect a cooldown.

## Quick start

```bash
git clone https://github.com/s0urledd/espressoduty.git
cd espressoduty
cp .env.example .env   # add your BLS key and channels
npm install
npm run build
pm2 start ecosystem.config.js   # or: docker compose up -d --build
```

Dashboard: `http://localhost:3030`. Test alert:
`curl -X POST http://localhost:3030/api/alert`

## Configuration

Everything lives in `.env` ([.env.example](.env.example) is the full list):

| Variable | Default | Purpose |
|---|---|---|
| `MAINNET_VALIDATORS` | — | `Label=BLS_VER_KEY~...`, comma separated |
| `QUERY_NODE` | public query service | Data source; comma-separate extras for failover |
| `LOCAL_NODE_URL` | — | Your node's query service, enables local checks |
| `CONSECUTIVE_DROPS_WARN` / `CONSECUTIVE_DROPS_CRIT` | `3` / `5` | The alert rule |
| `LOCAL_DOWN_FAILS` / `HEIGHT_LAG_BLOCKS` | `3` / `50` | Local node monitoring |
| `POLL_INTERVAL_SEC` | `60` | Poll cadence |
| `STATE_FILE` | `./state.json` | Restart-durable counters and grid |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `PAGERDUTY_ROUTING_KEY` | — | Channels |

## Dashboard

Each validator card shows vote and missed slots as big numbers with status
dots, and a 50-slot poll grid: one cell per poll, green when the average
climbed in that window (the node voted), red when it fell (missed views),
empty when the poll returned no data. Thin lines mark epoch boundaries. The
grid and counters survive restarts via `STATE_FILE`.

Missed slots is Espresso's own headline metric (`1 - proposal_participation`,
as on stake.espresso.network). Proposal tracking is live-only per node and
the public endpoint balances over backends with differing state, so sources
are probed until one has the data, and a value seen once is held for the
epoch. With no proposal data there is nothing known to be missed: 0%.

## Data sources

Espresso query service (`/v1`), semantics verified against the node's own
API reference:

- `node/participation/vote/current`: fraction of views properly voted
- `node/participation/proposal/current`: fraction of leader slots proposed
  properly; missed slots = 1 - value
- `node/stake-table/current`: epoch number, set membership, stake
- `node/validators/:epoch`: account, commission, delegators
- `status/block-height`, `status/time-since-last-decide`: liveness

Each poll is served by a single source (local node when in sync, public
otherwise) so subjective per-node views are never mixed.

MIT licensed.
