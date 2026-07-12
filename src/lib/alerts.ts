// Alert delivery. One normalized event shape, one formatter per channel.
// PagerDuty only receives critical events, gated by a consecutive-failure
// threshold handled in the monitor (dedup_key ties trigger to resolve).

import { loadConfig } from './config';

export type Severity = 'critical' | 'warning' | 'info' | 'recovered';

export interface AlertEvent {
  severity: Severity;
  /** Short headline, no emoji (added per channel). */
  title: string;
  /** Detail lines, already human-readable. */
  lines: string[];
  network?: string;
  /** Optional URL attached to the message. */
  link?: { label: string; url: string };
  /** For PagerDuty trigger/resolve pairing. */
  dedupKey?: string;
  /** 'trigger' | 'resolve' — only meaningful when dedupKey is set. */
  pagerduty?: 'trigger' | 'resolve';
}

const EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟠',
  info: 'ℹ️',
  recovered: '🟢',
};

const DISCORD_COLOR: Record<Severity, number> = {
  critical: 0xdc2626,
  warning: 0xd97706,
  info: 0x0c81b4,
  recovered: 0x16a34a,
};

async function post(url: string, body: unknown, timeoutMs = 10_000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[alerts] ${new URL(url).host} responded ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[alerts] delivery failed: ${err instanceof Error ? err.message : err}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(ev: AlertEvent): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
  const header = `${EMOJI[ev.severity]} <b>${escapeHtml(ev.title)}</b>`;
  const net = ev.network ? `\n<i>${escapeHtml(ev.network)}</i>` : '';
  const body = ev.lines.map((l) => escapeHtml(l)).join('\n');
  const link = ev.link ? `\n<a href="${ev.link.url}">${escapeHtml(ev.link.label)}</a>` : '';
  await post(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
    chat_id: cfg.telegramChatId,
    text: `${header}${net}\n${body}${link}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function sendDiscord(ev: AlertEvent): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.discordWebhookUrl) return;
  await post(cfg.discordWebhookUrl, {
    embeds: [
      {
        title: `${EMOJI[ev.severity]} ${ev.title}`,
        description: ev.lines.join('\n') + (ev.link ? `\n[${ev.link.label}](${ev.link.url})` : ''),
        color: DISCORD_COLOR[ev.severity],
        footer: { text: `espressoduty${ev.network ? ` · ${ev.network}` : ''}` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function sendSlack(ev: AlertEvent): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.slackWebhookUrl) return;
  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${EMOJI[ev.severity]} *${ev.title}*` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ev.lines.join('\n') + (ev.link ? `\n<${ev.link.url}|${ev.link.label}>` : ''),
      },
    },
  ];
  if (ev.network) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `espressoduty · ${ev.network}` }],
    });
  }
  await post(cfg.slackWebhookUrl, { blocks });
}

async function sendPagerDuty(ev: AlertEvent): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.pagerdutyRoutingKey || !ev.dedupKey || !ev.pagerduty) return;
  await post('https://events.pagerduty.com/v2/enqueue', {
    routing_key: cfg.pagerdutyRoutingKey,
    event_action: ev.pagerduty,
    dedup_key: ev.dedupKey,
    payload: {
      summary: `${ev.title}${ev.network ? ` (${ev.network})` : ''}`,
      source: 'espressoduty',
      severity: ev.severity === 'critical' ? 'critical' : 'warning',
      custom_details: { detail: ev.lines.join('\n') },
    },
  });
}

/**
 * Fan an event out to the configured chat channels. Events carrying a
 * PagerDuty trigger/resolve action go to PagerDuty only: the chat channels
 * already received the human-facing alert, repeating it is just noise.
 */
export async function sendAlert(ev: AlertEvent): Promise<void> {
  const results = await Promise.allSettled(
    ev.pagerduty ? [sendPagerDuty(ev)] : [sendTelegram(ev), sendDiscord(ev), sendSlack(ev)],
  );
  const label = `${ev.severity}: ${ev.title}`;
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`[alerts] ${label}${failed ? ` (${failed} channel(s) failed)` : ''}`);
}
