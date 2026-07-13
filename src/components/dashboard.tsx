'use client';

// Live dashboard. Inspired by tenderduty/monadoring's density, but with its
// own signature: each validator is a "pull bar" — a wide participation track
// that fills like an espresso pull, with the warn/critical thresholds marked
// as ticks — plus a health-colored stripe on the card's left edge.
//
// Gets an initial snapshot from /api/state, then applies pushed snapshots
// from the /api/stream SSE feed — the page never polls.

import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { Activity, Copy, Github, Moon, Sun, Check } from 'lucide-react';
import clsx from 'clsx';
import type { Snapshot, NetworkView, ValidatorView } from '@/lib/state';

// Thresholds mirrored for display only; the server enforces the real ones.
const VOTE_WARN = Number(process.env.NEXT_PUBLIC_VOTE_WARN ?? 0.9);
const VOTE_CRIT = Number(process.env.NEXT_PUBLIC_VOTE_CRITICAL ?? 0.5);
const MISSED_WARN = Number(process.env.NEXT_PUBLIC_MISSED_WARN ?? 0.5);
const MISSED_CRIT = Number(process.env.NEXT_PUBLIC_MISSED_CRITICAL ?? 0.9);

const NO_SLOTS_HINT =
  'No proposal data reported for this epoch yet; a value appears as soon as a source has it';

function rateColor(rate: number | null): string {
  if (rate === null) return 'var(--idle)';
  if (rate < VOTE_CRIT) return 'var(--crit)';
  if (rate < VOTE_WARN) return 'var(--warn)';
  return 'var(--ok)';
}

/** Missed slots: higher is worse. */
function missedColor(missed: number | null): string {
  if (missed === null) return 'var(--idle)';
  if (missed > MISSED_CRIT) return 'var(--crit)';
  if (missed > MISSED_WARN) return 'var(--warn)';
  return 'var(--ok)';
}

function fmtPct(x: number | null | undefined, digits = 2): string {
  return x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`;
}

function fmtInt(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : x.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then(setSnap)
      .catch(() => {});

    let closed = false;
    const connect = () => {
      if (closed) return;
      const es = new EventSource('/api/stream');
      esRef.current = es;
      es.onopen = () => setLive(true);
      es.onmessage = (ev) => {
        setLive(true);
        try {
          setSnap(JSON.parse(ev.data));
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        setLive(false);
        es.close();
        setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      esRef.current?.close();
    };
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Header live={live} />
      {!snap || snap.networks.length === 0 ? (
        <EmptyState loaded={!!snap} />
      ) : (
        snap.networks.map((net) => (
          <NetworkSection key={net.name} net={net} localNode={net.name === 'mainnet' ? snap.localNode : null} />
        ))
      )}
      <Footer />
    </main>
  );
}

// ---------------------------------------------------------------------------

function Header({ live }: { live: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <header className="mb-8 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Starburst />
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--text-strong)' }}>
            espressoduty
          </h1>
          <p className="label">every view counts</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
          style={{
            borderColor: 'var(--border)',
            color: live ? 'var(--ok)' : 'var(--warn)',
            background: live ? 'var(--ok-bg)' : 'var(--warn-bg)',
          }}
        >
          <span className={clsx('h-1.5 w-1.5 rounded-full', live && 'live-dot')} style={{ background: 'currentColor' }} />
          {live ? 'LIVE' : 'RECONNECTING'}
        </span>
        {mounted && (
          <button
            aria-label="Toggle theme"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            className="rounded-full border p-2 transition-opacity hover:opacity-70"
            style={{ borderColor: 'var(--border)', color: 'var(--label)' }}
          >
            {resolvedTheme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        )}
      </div>
    </header>
  );
}

/** Espresso-style starburst mark. */
function Starburst() {
  return (
    <svg width="32" height="32" viewBox="0 0 34 34" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6;
        return (
          <line
            key={i}
            x1={17 + 5 * Math.cos(a)}
            y1={17 + 5 * Math.sin(a)}
            x2={17 + 14 * Math.cos(a)}
            y2={17 + 14 * Math.sin(a)}
            stroke="var(--accent)"
            strokeWidth={i % 3 === 0 ? 3 : 2}
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

function EmptyState({ loaded }: { loaded: boolean }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-16 text-center">
      <Activity size={20} style={{ color: 'var(--label)' }} />
      <p style={{ color: 'var(--text-strong)' }}>{loaded ? 'No validators configured' : 'Loading…'}</p>
      {loaded && (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Set <code className="rounded px-1" style={{ background: 'var(--card-soft)' }}>MAINNET_VALIDATORS</code> in
          your .env and restart. See .env.example.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NetworkSection({ net, localNode }: { net: NetworkView; localNode: Snapshot['localNode'] }) {
  return (
    <section className="mb-8">
      <StatusLine net={net} localNode={localNode} />
      <div className="mt-3 space-y-3">
        {net.validators.map((v) => (
          <ValidatorCard key={v.key} v={v} />
        ))}
      </div>
    </section>
  );
}

/**
 * One terminal-ish line for the whole network — everything an operator
 * glances at before looking at their own validators.
 */
function StatusLine({ net, localNode }: { net: NetworkView; localNode: Snapshot['localNode'] }) {
  const tsld = net.timeSinceLastDecide;
  const alive = tsld !== null && tsld <= 60;
  const tsldColor = tsld === null ? 'var(--idle)' : tsld > 60 ? 'var(--crit)' : tsld > 15 ? 'var(--warn)' : 'var(--ok)';
  const active = net.endpoints.find((e) => e.isActive);
  const source = active ? (active.isLocal ? 'local' : new URL(active.url).host.split('.')[0]) : '—';

  return (
    <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm">
      <span className="flex items-center gap-2">
        <span
          className={clsx('h-2 w-2 rounded-full', alive && 'live-dot')}
          style={{ background: alive ? 'var(--ok)' : tsld === null ? 'var(--idle)' : 'var(--crit)' }}
        />
        <span className="font-semibold uppercase tracking-widest" style={{ color: 'var(--text-strong)' }}>
          {net.name}
        </span>
      </span>
      <Field k="height" v={fmtInt(net.height)} />
      <Field k="decide" v={tsld === null ? '—' : `${Math.round(tsld)}s`} color={tsldColor} />
      <Field k="epoch" v={net.epoch === null ? '—' : String(net.epoch)} />
      <Field k="src" v={source} title={active?.url} />
      {localNode && (
        <Field
          k="local"
          v={
            localNode.reachable === false
              ? 'down'
              : localNode.lagBlocks === null
                ? localNode.reachable
                  ? 'ok'
                  : '—'
                : localNode.lagBlocks <= 0
                  ? 'in sync'
                  : `${localNode.lagBlocks} behind`
          }
          color={
            localNode.reachable === false
              ? 'var(--crit)'
              : localNode.lagBlocks !== null && localNode.lagBlocks > 20
                ? 'var(--warn)'
                : 'var(--ok)'
          }
        />
      )}
    </div>
  );
}

function Field({ k, v, color, title }: { k: string; v: string; color?: string; title?: string }) {
  return (
    <span className="flex items-baseline gap-1.5 tabular-nums" title={title}>
      <span className="label">{k}</span>
      <span style={{ color: color ?? 'var(--text-strong)' }}>{v}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------

function ValidatorCard({ v }: { v: ValidatorView }) {
  const [copied, setCopied] = useState(false);
  const copyKey = () => {
    navigator.clipboard?.writeText(v.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // The stripe reflects overall health, not the raw vote band: vote alone
  // caps at warn in the health model, and the edge should agree with it.
  const stripe =
    v.health === 'missing' || v.health === 'crit'
      ? 'var(--crit)'
      : v.health === 'warn'
        ? 'var(--warn)'
        : v.health === 'unknown'
          ? 'var(--idle)'
          : 'var(--ok)';
  const badge =
    v.inActiveSet === null
      ? { text: 'unknown', color: 'var(--muted)', bg: 'var(--card-soft)' }
      : v.health === 'missing'
        ? { text: 'missing', color: 'var(--crit)', bg: 'var(--crit-bg)' }
        : v.inActiveSet
          ? { text: 'active', color: 'var(--ok)', bg: 'var(--ok-bg)' }
          : { text: 'inactive', color: 'var(--muted)', bg: 'var(--card-soft)' };

  return (
    <div className="card relative overflow-hidden px-6 py-5">
      {/* health stripe: the card's left edge tells the story from across the room */}
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: stripe }} />

      <div className="mb-4 flex items-center gap-2.5">
        <h3 className="truncate text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
          {v.label}
        </h3>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ color: badge.color, background: badge.bg }}
        >
          {badge.text}
        </span>
        <button
          onClick={copyKey}
          title={v.key}
          className="ml-auto flex shrink-0 items-center gap-1 text-xs transition-opacity hover:opacity-70"
          style={{ color: 'var(--muted)' }}
        >
          {v.key.slice(0, 20)}…{copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>

      {/* Big number + status dot per metric. Missed slots is Espresso's
          headline (1 - proposal_participation); with no proposal data for
          the epoch there is nothing known to be missed, shown as 0%. */}
      <div className="mb-4 grid grid-cols-2 gap-4">
        <Metric label="vote" value={v.vote} dot={rateColor(v.vote)} />
        <Metric
          label="missed slots"
          value={v.missedSlots}
          dot={missedColor(v.missedSlots)}
          hint={v.proposal === null ? NO_SLOTS_HINT : undefined}
        />
      </div>

      <PollGrid samples={v.samples} />

      <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: 'var(--muted)' }}>
        <span>{v.stakeEsp === null ? '— ESP' : `${fmtInt(Math.round(v.stakeEsp))} ESP`}</span>
        <span>{v.delegatorCount === null ? '— delegators' : `${fmtInt(v.delegatorCount)} delegator${v.delegatorCount === 1 ? '' : 's'}`}</span>
        <span>{v.commission === null ? '— commission' : `${(v.commission / 100).toFixed(2)}% commission`}</span>
        {v.account && (
          <span className="tabular-nums" title={v.account}>
            {v.account.slice(0, 6)}…{v.account.slice(-4)}
          </span>
        )}
      </p>
    </div>
  );
}

/** Colored status dot, small label, big number. Dash only before the first poll. */
function Metric({
  label,
  value,
  dot,
  hint,
}: {
  label: string;
  value: number | null;
  dot: string;
  hint?: string;
}) {
  const empty = value === null;
  const num = empty ? null : (value * 100).toFixed(1).replace(/\.0$/, '');
  return (
    <div title={hint}>
      <p className="mb-1 flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: empty ? 'var(--idle)' : dot }} />
        <span className="label">{label}</span>
      </p>
      {empty ? (
        <p className="pt-2 text-sm leading-none" style={{ color: 'var(--idle)' }}>
          no data
        </p>
      ) : (
        <p className="text-[26px] font-medium leading-none tabular-nums" style={{ color: 'var(--text-strong)' }}>
          {num}
          <span className="text-sm" style={{ color: 'var(--muted)' }}>
            %
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * tenderduty-style grid, kept honest: one cell is ONE POLL, not a block.
 * Espresso only exposes the cumulative epoch average, so a cell is colored
 * purely by the trend during that poll window: the average climbing, by
 * however little, means the node voted right then (green); falling or not
 * climbing means it missed views (red). A saturated average (~100%) stays
 * green when flat, since there is no room left to climb. The first cell of
 * an epoch has no trend and renders neutral; an empty bordered cell means
 * that poll returned no data. Thin vertical lines mark epoch boundaries.
 */
const GRID_SLOTS = 50;

function PollGrid({ samples }: { samples: ValidatorView['samples'] }) {
  const recent = samples.slice(-GRID_SLOTS);
  if (recent.length === 0) {
    return <p className="label">collecting polls…</p>;
  }
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label">vote participation · per poll</span>
        <span className="label">{recent.length} polls</span>
      </div>
      {/* Exactly GRID_SLOTS equal columns across the full card width: bars
          keep the same comfortable size whether 3 polls or 50 are in the
          buffer, and fill in left to right. */}
      <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${GRID_SLOTS}, 1fr)` }}>
        {recent.map((s, i) => {
          const prev = recent[i - 1];
          const boundary = prev !== undefined && prev.epoch !== null && s.epoch !== null && prev.epoch !== s.epoch;
          const time = new Date(s.t).toLocaleTimeString('en-US', { hour12: false });
          const sameEpochPrev =
            prev !== undefined && prev.vote !== null && prev.epoch === s.epoch ? prev.vote : null;
          const rising = s.vote !== null && sameEpochPrev !== null && s.vote > sameEpochPrev + 1e-6;
          const saturated = s.vote !== null && s.vote >= 0.995;
          const color =
            s.vote === null
              ? null
              : sameEpochPrev === null
                ? saturated
                  ? 'var(--ok)'
                  : 'var(--idle)'
                : rising || saturated
                  ? 'var(--ok)'
                  : 'var(--crit)';
          const trend =
            s.vote === null || sameEpochPrev === null
              ? ''
              : rising || saturated
                ? ' ↑ voting'
                : ' ↓ missing views';
          const tip =
            s.vote === null
              ? `${time} · no data`
              : `${time} · epoch ${s.epoch} · vote ${fmtPct(s.vote)}${trend}`;
          return (
            <div key={s.t} className="flex h-5 items-stretch" title={tip}>
              {boundary && <span className="mr-px w-0.5 shrink-0" style={{ background: 'var(--border-strong)' }} />}
              <span
                className="w-full rounded-[3px]"
                style={color === null ? { border: '1px solid var(--border)', background: 'transparent' } : { background: color }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer className="mt-12 flex flex-col items-center gap-4 pb-6">
      <a
        href="/api/state"
        target="_blank"
        rel="noreferrer"
        className="rounded-md border px-4 py-2 text-sm transition-opacity hover:opacity-70"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}
      >
        [STATE API]
      </a>
      <a
        href="https://github.com/s0urledd/espressoduty"
        target="_blank"
        rel="noreferrer"
        aria-label="GitHub"
        className="transition-opacity hover:opacity-70"
        style={{ color: 'var(--muted)' }}
      >
        <Github size={18} />
      </a>
    </footer>
  );
}
