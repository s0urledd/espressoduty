export type NetworkName = 'mainnet' | 'testnet';

export interface WatchedValidator {
  /** Full BLS verification key, `BLS_VER_KEY~...` */
  key: string;
  /** Display label. Optional in config (`Label=BLS_VER_KEY~...`); falls back to a shortened key. */
  label: string;
}

export interface NetworkConfig {
  name: NetworkName;
  validators: WatchedValidator[];
  /** Query-service base URLs, e.g. https://query.main.net.espresso.network/v1 (first = primary). */
  queryNodes: string[];
  explorerUrl: string;
}

export interface Config {
  networks: NetworkConfig[];
  /**
   * Operator's own node. When set it becomes the primary read source for
   * participation and status (the public query nodes stay as fallback),
   * and enables local-down and sync-lag checks.
   */
  localNodeUrl: string | null;
  /**
   * Missed-slots thresholds, on the delegator-facing metric Espresso's own
   * dashboard leads with: missed = 1 - proposal_participation.
   * Alerts fire when the missed fraction rises ABOVE these.
   */
  missedWarn: number;
  missedCritical: number;
  /** Secondary vote-participation thresholds (alerts when the rate falls BELOW). */
  voteWarn: number;
  voteCritical: number;
  decideStallSec: number;
  heightLagBlocks: number;
  alertCooldownMin: number;
  /** Participation / stake-table poll interval. */
  pollIntervalSec: number;
  /** Lightweight status poll (block height, time-since-last-decide) driving the live dashboard. */
  statusPollIntervalSec: number;
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
  slackWebhookUrl: string;
  pagerdutyRoutingKey: string;
  pagerdutyThreshold: number;
}

function str(name: string, def = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v.trim();
}

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function list(name: string): string[] {
  return str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Entries are either a bare key or `Label=BLS_VER_KEY~...`. */
function parseValidators(name: string): WatchedValidator[] {
  return list(name).map((entry) => {
    const eq = entry.indexOf('=');
    if (eq > 0 && entry.slice(eq + 1).startsWith('BLS_VER_KEY~')) {
      return { label: entry.slice(0, eq).trim(), key: entry.slice(eq + 1).trim() };
    }
    return { label: shortKey(entry), key: entry };
  });
}

export function shortKey(key: string): string {
  const body = key.replace(/^BLS_VER_KEY~/, '');
  return body.length > 12 ? `${body.slice(0, 6)}…${body.slice(-4)}` : body;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const networks: NetworkConfig[] = [];
  const mainnetValidators = parseValidators('MAINNET_VALIDATORS');
  if (mainnetValidators.length > 0) {
    networks.push({
      name: 'mainnet',
      validators: mainnetValidators,
      queryNodes:
        list('MAINNET_QUERY_NODES').length > 0
          ? list('MAINNET_QUERY_NODES')
          : ['https://query.main.net.espresso.network/v1'],
      explorerUrl: str('MAINNET_EXPLORER_URL', 'https://explorer.main.net.espresso.network'),
    });
  }
  const testnetValidators = parseValidators('TESTNET_VALIDATORS');
  if (testnetValidators.length > 0 && list('TESTNET_QUERY_NODES').length > 0) {
    networks.push({
      name: 'testnet',
      validators: testnetValidators,
      queryNodes: list('TESTNET_QUERY_NODES'),
      explorerUrl: str('TESTNET_EXPLORER_URL', 'https://explorer.decaf.testnet.espresso.network'),
    });
  }

  cached = {
    networks,
    localNodeUrl: str('LOCAL_NODE_URL') || null,
    missedWarn: num('MISSED_WARN', 0.5),
    missedCritical: num('MISSED_CRITICAL', 0.9),
    voteWarn: num('VOTE_WARN', 0.9),
    voteCritical: num('VOTE_CRITICAL', 0.5),
    decideStallSec: num('DECIDE_STALL_SEC', 60),
    heightLagBlocks: num('HEIGHT_LAG_BLOCKS', 20),
    alertCooldownMin: num('ALERT_COOLDOWN_MIN', 30),
    pollIntervalSec: Math.max(15, num('POLL_INTERVAL_SEC', 60)),
    statusPollIntervalSec: Math.max(5, num('STATUS_POLL_INTERVAL_SEC', 10)),
    telegramBotToken: str('TELEGRAM_BOT_TOKEN'),
    telegramChatId: str('TELEGRAM_CHAT_ID'),
    discordWebhookUrl: str('DISCORD_WEBHOOK_URL'),
    slackWebhookUrl: str('SLACK_WEBHOOK_URL'),
    pagerdutyRoutingKey: str('PAGERDUTY_ROUTING_KEY'),
    pagerdutyThreshold: num('PAGERDUTY_THRESHOLD', 3),
  };
  return cached;
}

export function configuredChannels(cfg: Config): string[] {
  const out: string[] = [];
  if (cfg.telegramBotToken && cfg.telegramChatId) out.push('Telegram');
  if (cfg.discordWebhookUrl) out.push('Discord');
  if (cfg.slackWebhookUrl) out.push('Slack');
  if (cfg.pagerdutyRoutingKey) out.push('PagerDuty');
  return out;
}
