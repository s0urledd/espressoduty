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

function rateColor(rate: number | null): string {
  if (rate === null) return 'var(--idle)';
  if (rate < VOTE_CRIT) return 'var(--crit)';
  if (rate < VOTE_WARN) return 'var(--warn)';
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

  const stripe = v.health === 'missing' ? 'var(--crit)' : rateColor(v.vote);
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

      <PullBar label="vote" rate={v.vote} />
      <div className="mt-3">
        <PullBar label="proposal" rate={v.proposal} thin emptyText="no leader slots yet" />
      </div>

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

/**
 * The signature element: a participation track that fills like an espresso
 * pull. Threshold ticks mark where warn and critical start, so the bar reads
 * against the operator's own thresholds at a glance.
 */
function PullBar({
  label,
  rate,
  thin,
  emptyText,
}: {
  label: string;
  rate: number | null;
  thin?: boolean;
  emptyText?: string;
}) {
  const color = rateColor(rate);
  return (
    <div className="flex items-center gap-3">
      <span className="label w-16 shrink-0">{label}</span>
      <div
        className={clsx('relative flex-1 overflow-hidden rounded-full', thin ? 'h-1.5' : 'h-3')}
        style={{ background: 'var(--card-soft)' }}
        title={rate === null && emptyText ? emptyText : undefined}
      >
        {rate !== null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${Math.min(Math.max(rate, 0), 1) * 100}%`,
              background: color,
              transition: 'width 0.8s ease, background 0.8s ease',
            }}
          />
        )}
        {/* threshold ticks */}
        <Tick at={VOTE_CRIT} title={`critical < ${Math.round(VOTE_CRIT * 100)}%`} />
        <Tick at={VOTE_WARN} title={`warn < ${Math.round(VOTE_WARN * 100)}%`} />
      </div>
      <span
        className={clsx('shrink-0 text-right tabular-nums', thin ? 'w-16 text-xs' : 'w-20 text-sm font-semibold')}
        style={{ color: rate === null ? 'var(--idle)' : 'var(--text-strong)' }}
      >
        {rate === null ? '—' : fmtPct(rate)}
      </span>
    </div>
  );
}

function Tick({ at, title }: { at: number; title: string }) {
  return (
    <div
      title={title}
      className="absolute inset-y-0 w-px"
      style={{ left: `${at * 100}%`, background: 'var(--border-strong)' }}
    />
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
