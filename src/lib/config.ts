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
  /**
   * Staking API base URLs (first = primary). Serves per-validator
   * leader-slot and vote counts for the current epoch, derived from the
   * chain itself — the source stake.espresso.network uses.
   */
  stakingApis: string[];
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
   * Alerting is on the leader-duty axis: the cumulative proposal rate only
   * moves when the validator IS leader, so a falling poll means a missed
   * leader slot and a rising poll means a successful proposal. Chat
   * channels alert after consecutiveMissesWarn missed-slot events in a
   * row; PagerDuty pages after consecutiveMissesCrit. A successful
   * proposal resets the streak.
   */
  consecutiveMissesWarn: number;
  consecutiveMissesCrit: number;
  /** Minutes the local node may stay down/stuck before PagerDuty is paged. */
  localDownPageMin: number;
  /** Minutes without view progress before the stuck alert fires. */
  stuckAfterMin: number;
  /** Display thresholds for the missed-slots color only, never alerts. */
  missedWarn: number;
  missedCritical: number;
  decideStallSec: number;
  heightLagBlocks: number;
  /** Consecutive failed checks before the local node counts as down. */
  localDownFails: number;
  /** Timeout for status/health probes; a busy node can be slow without being down. */
  statusPollTimeoutSec: number;
  alertCooldownMin: number;
  /** Participation / stake-table poll interval. */
  pollIntervalSec: number;
  /** Lightweight status poll (block height, time-since-last-decide) driving the live dashboard. */
  statusPollIntervalSec: number;
  /**
   * Dead man's switch. When set, a GET fires here after every successful
   * poll cycle; the receiving service (healthchecks.io, Uptime Kuma, ...)
   * alerts when the pings stop — i.e. when espressoduty itself died.
   */
  heartbeatUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
  slackWebhookUrl: string;
  pagerdutyRoutingKey: string;
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

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Entries are a BLS key, an L1 address (resolved to the BLS key on the
 * first poll), or either with a `Label=` prefix.
 */
function parseValidators(name: string): WatchedValidator[] {
  return list(name).map((entry) => {
    const eq = entry.indexOf('=');
    let label = '';
    let value = entry;
    if (eq > 0) {
      const rest = entry.slice(eq + 1).trim();
      if (rest.startsWith('BLS_VER_KEY~') || ADDR_RE.test(rest)) {
        label = entry.slice(0, eq).trim();
        value = rest;
      }
    }
    if (ADDR_RE.test(value)) {
      const addr = value.toLowerCase();
      return { label: label || `${addr.slice(0, 6)}…${addr.slice(-4)}`, key: addr };
    }
    return { label: label || shortKey(value), key: value };
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
  // QUERY_NODE accepts a comma-separated list; extra entries are failover.
  const queryNodes = list('QUERY_NODE').length > 0 ? list('QUERY_NODE') : list('MAINNET_QUERY_NODES');
  if (mainnetValidators.length > 0) {
    networks.push({
      name: 'mainnet',
      validators: mainnetValidators,
      queryNodes: queryNodes.length > 0 ? queryNodes : ['https://query.main.net.espresso.network/v1'],
      stakingApis:
        list('STAKING_API').length > 0
          ? list('STAKING_API')
          : ['https://cache.main.net.espresso.network/v0/staking'],
      explorerUrl: str('MAINNET_EXPLORER_URL', 'https://explorer.main.net.espresso.network'),
    });
  }

  // Testnet (Decaf). Nothing is polled unless TESTNET_VALIDATORS is set —
  // an unused section costs zero requests.
  const testnetValidators = parseValidators('TESTNET_VALIDATORS');
  if (testnetValidators.length > 0) {
    networks.push({
      name: 'testnet',
      validators: testnetValidators,
      queryNodes:
        list('TESTNET_QUERY_NODE').length > 0
          ? list('TESTNET_QUERY_NODE')
          : ['https://query.decaf.testnet.espresso.network/v1'],
      stakingApis:
        list('TESTNET_STAKING_API').length > 0
          ? list('TESTNET_STAKING_API')
          : ['https://cache.decaf.testnet.espresso.network/v0/staking'],
      explorerUrl: str('TESTNET_EXPLORER_URL', 'https://explorer.decaf.testnet.espresso.network'),
    });
  }

  cached = {
    networks,
    localNodeUrl: str('LOCAL_NODE_URL') || null,
    consecutiveMissesWarn: Math.max(1, num('CONSECUTIVE_MISSES_WARN', 3)),
    consecutiveMissesCrit: Math.max(2, num('CONSECUTIVE_MISSES_CRIT', 5)),
    localDownPageMin: Math.max(1, num('LOCAL_DOWN_PAGE_MIN', 10)),
    stuckAfterMin: Math.max(1, num('STUCK_AFTER_MIN', 5)),
    missedWarn: num('MISSED_WARN', 0.5),
    missedCritical: num('MISSED_CRITICAL', 0.9),
    // 5 minutes: the network takes brief (~60-70s) finalization pauses
    // around epoch transitions; those are routine, not a chain stall.
    decideStallSec: Math.max(60, num('DECIDE_STALL_SEC', 300)),
    heightLagBlocks: num('HEIGHT_LAG_BLOCKS', 50),
    localDownFails: Math.max(2, num('LOCAL_DOWN_FAILS', 5)),
    statusPollTimeoutSec: Math.max(3, num('STATUS_POLL_TIMEOUT_SEC', 10)),
    alertCooldownMin: num('ALERT_COOLDOWN_MIN', 30),
    pollIntervalSec: Math.max(15, num('POLL_INTERVAL_SEC', 60)),
    statusPollIntervalSec: Math.max(5, num('STATUS_POLL_INTERVAL_SEC', 10)),
    heartbeatUrl: str('HEARTBEAT_URL'),
    telegramBotToken: str('TELEGRAM_BOT_TOKEN'),
    telegramChatId: str('TELEGRAM_CHAT_ID'),
    discordWebhookUrl: str('DISCORD_WEBHOOK_URL'),
    slackWebhookUrl: str('SLACK_WEBHOOK_URL'),
    pagerdutyRoutingKey: str('PAGERDUTY_ROUTING_KEY'),
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
