'use client';

// Live dashboard. Gets an initial snapshot from /api/state, then applies
// pushed snapshots from the /api/stream SSE feed — the page never polls.

import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  Activity,
  Bell,
  Copy,
  ExternalLink,
  Moon,
  Sun,
  Check,
} from 'lucide-react';
import clsx from 'clsx';
import type { Snapshot, NetworkView, ValidatorView, ParticipationSample } from '@/lib/state';

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
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <Header live={live} channels={snap?.channels ?? []} />
      {!snap || snap.networks.length === 0 ? (
        <EmptyState loaded={!!snap} />
      ) : (
        <>
          {snap.networks.map((net) => (
            <NetworkSection key={net.name} net={net} localNode={net.name === 'mainnet' ? snap.localNode : null} />
          ))}
        </>
      )}
      <footer className="label mt-10 pb-4 text-center">
        espressoduty · data from the Espresso query service · updates pushed live
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Header({ live, channels }: { live: boolean; channels: string[] }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <header className="mb-6 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Starburst />
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--text-strong)' }}>
            espressoduty
          </h1>
          <p className="label">espresso validator monitor</p>
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
          <span
            className={clsx('h-1.5 w-1.5 rounded-full', live && 'live-dot')}
            style={{ background: 'currentColor' }}
          />
          {live ? 'LIVE' : 'RECONNECTING'}
        </span>
        {channels.length > 0 && (
          <span
            className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs sm:flex"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
            title={`Alert channels: ${channels.join(', ')}`}
          >
            <Bell size={12} />
            {channels.length}
          </span>
        )}
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
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
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

function NetworkSection({
  net,
  localNode,
}: {
  net: NetworkView;
  localNode: Snapshot['localNode'];
}) {
  const suppressed = net.suppressedUntil !== null && net.suppressedUntil > Date.now();
  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest" style={{ color: 'var(--text-strong)' }}>
          {net.name}
        </h2>
        {suppressed && (
          <span className="label" title="Fresh epoch: absolute-rate alerts are suppressed until enough samples exist">
            settling into new epoch…
          </span>
        )}
      </div>

      <NetworkStrip net={net} localNode={localNode} />

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {net.validators.map((v) => (
          <ValidatorCard key={v.key} v={v} explorerBase={net.name === 'mainnet' ? 'https://explorer.main.net.espresso.network' : 'https://explorer.decaf.testnet.espresso.network'} />
        ))}
      </div>

      {net.epochHistory.length > 0 && <EpochTable net={net} />}
    </section>
  );
}

function NetworkStrip({ net, localNode }: { net: NetworkView; localNode: Snapshot['localNode'] }) {
  const tsld = net.timeSinceLastDecide;
  const tsldColor = tsld === null ? 'var(--idle)' : tsld > 60 ? 'var(--crit)' : tsld > 15 ? 'var(--warn)' : 'var(--ok)';
  return (
    <div className="card grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="Block height" value={fmtInt(net.height)} />
      <Stat label="Last decide" value={tsld === null ? '—' : `${Math.round(tsld)}s ago`} color={tsldColor} />
      <Stat label="Epoch" value={net.epoch === null ? '—' : String(net.epoch)} />
      <Stat label="Success rate" value={fmtPct(net.successRate, 1)} />
      <div className="col-span-2 sm:col-span-1">
        <p className="label mb-1">Query nodes</p>
        <div className="flex flex-wrap gap-1.5">
          {net.endpoints.map((ep) => (
            <span
              key={ep.url}
              title={`${ep.url}${ep.lastHeight ? ` · height ${ep.lastHeight}` : ''}${ep.isActive ? ' · active' : ''}`}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
              style={{
                borderColor: ep.isActive ? 'var(--border-strong)' : 'var(--border)',
                color:
                  ep.healthy === false ? 'var(--crit)' : ep.healthy === true ? 'var(--ok)' : 'var(--muted)',
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
              {new URL(ep.url).host.split('.')[0]}
            </span>
          ))}
        </div>
      </div>
      <div>
        <p className="label mb-1">Local node</p>
        {localNode ? (
          <p
            className="text-sm"
            style={{
              color:
                localNode.reachable === false
                  ? 'var(--crit)'
                  : localNode.lagBlocks !== null && localNode.lagBlocks > 20
                    ? 'var(--warn)'
                    : 'var(--ok)',
            }}
          >
            {localNode.reachable === false
              ? 'unreachable'
              : localNode.lagBlocks === null
                ? localNode.reachable
                  ? 'ok'
                  : '—'
                : localNode.lagBlocks <= 0
                  ? 'in sync'
                  : `${localNode.lagBlocks} behind`}
          </p>
        ) : (
          <p className="text-sm" style={{ color: 'var(--idle)' }}>
            not configured
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <p className="label mb-1">{label}</p>
      <p className="text-lg tabular-nums" style={{ color: color ?? 'var(--text-strong)' }}>
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ValidatorCard({ v, explorerBase }: { v: ValidatorView; explorerBase: string }) {
  const [copied, setCopied] = useState(false);
  const copyKey = () => {
    navigator.clipboard?.writeText(v.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const badge =
    v.inActiveSet === null
      ? { text: 'UNKNOWN', color: 'var(--muted)', bg: 'var(--card-soft)' }
      : v.health === 'missing'
        ? { text: 'MISSING', color: 'var(--crit)', bg: 'var(--crit-bg)' }
        : v.inActiveSet
          ? { text: 'ACTIVE', color: 'var(--ok)', bg: 'var(--ok-bg)' }
          : { text: 'INACTIVE', color: 'var(--muted)', bg: 'var(--card-soft)' };

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold" style={{ color: 'var(--text-strong)' }}>
              {v.label}
            </h3>
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider"
              style={{ color: badge.color, background: badge.bg }}
            >
              {badge.text}
            </span>
          </div>
          <button
            onClick={copyKey}
            title={v.key}
            className="mt-0.5 flex items-center gap-1 text-xs transition-opacity hover:opacity-70"
            style={{ color: 'var(--muted)' }}
          >
            {v.key.slice(0, 24)}…{copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <a
            href={explorerBase}
            target="_blank"
            rel="noreferrer"
            title="Explorer"
            className="rounded-full border p-1.5 transition-opacity hover:opacity-70"
            style={{ borderColor: 'var(--border)', color: 'var(--label)' }}
          >
            <ExternalLink size={12} />
          </a>
        </div>
      </div>

      <div className="mb-4 flex items-center justify-around">
        <Ring label="Vote" rate={v.vote} />
        <Ring label="Proposal" rate={v.proposal} emptyText="no leader slots" />
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <Mini label="Stake" value={v.stakeEsp === null ? '—' : `${fmtInt(Math.round(v.stakeEsp))} ESP`} />
        <Mini label="Commission" value={v.commission === null ? '—' : `${(v.commission / 100).toFixed(2)}%`} />
        <Mini label="Delegators" value={fmtInt(v.delegatorCount)} />
      </div>

      <Timeline samples={v.samples} />
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label mb-0.5">{label}</p>
      <p className="truncate text-sm tabular-nums">{value}</p>
    </div>
  );
}

/** Threshold-colored participation gauge. */
function Ring({ label, rate, emptyText }: { label: string; rate: number | null; emptyText?: string }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const color = rateColor(rate);
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative h-[76px] w-[76px]">
        <svg width="76" height="76" viewBox="0 0 76 76" className="-rotate-90">
          <circle cx="38" cy="38" r={r} fill="none" stroke="var(--card-soft)" strokeWidth="6" />
          {rate !== null && (
            <circle
              cx="38"
              cy="38"
              r={r}
              fill="none"
              stroke={color}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - Math.min(Math.max(rate, 0), 1))}
              style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.6s ease' }}
            />
          )}
        </svg>
        <span
          className="absolute inset-0 flex items-center justify-center text-[13px] tabular-nums"
          style={{ color: rate === null ? 'var(--idle)' : 'var(--text-strong)' }}
        >
          {rate === null ? '—' : `${(rate * 100).toFixed(rate >= 0.9995 ? 0 : 1)}%`}
        </span>
      </div>
      <p className="label" title={rate === null && emptyText ? emptyText : undefined}>
        {label}
      </p>
    </div>
  );
}

/**
 * Poll-sampled vote-participation timeline: one cell per poll, colored by
 * threshold, epoch boundaries marked. Espresso exposes per-epoch rates —
 * not per-block events — so this is a time series of samples, deliberately
 * not a fake per-block grid.
 */
function Timeline({ samples }: { samples: ParticipationSample[] }) {
  const recent = samples.slice(-96);
  if (recent.length === 0) {
    return <p className="label">collecting samples…</p>;
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="label">Vote participation · per poll</p>
        <p className="label">{recent.length} samples</p>
      </div>
      <div className="flex h-6 items-end gap-px overflow-hidden rounded" style={{ background: 'var(--card-soft)' }}>
        {recent.map((s, i) => {
          const prev = recent[i - 1];
          const epochBoundary = prev !== undefined && prev.epoch !== s.epoch;
          return (
            <div key={s.t} className="flex h-full flex-1 items-end" title={`${new Date(s.t).toLocaleTimeString('en-US', { hour12: false })} · epoch ${s.epoch} · vote ${fmtPct(s.vote)}${s.proposal !== null ? ` · proposal ${fmtPct(s.proposal)}` : ''}`}>
              {epochBoundary && <div className="h-full w-px shrink-0" style={{ background: 'var(--border-strong)' }} />}
              <div
                className="w-full rounded-sm"
                style={{
                  height: s.vote === null ? '100%' : `${Math.max(s.vote * 100, 8)}%`,
                  background: s.vote === null ? 'var(--idle)' : rateColor(s.vote),
                  opacity: s.vote === null ? 0.5 : 1,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EpochTable({ net }: { net: NetworkView }) {
  return (
    <div className="card mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="label" style={{ background: 'var(--table-head)' }}>
            <th className="px-4 py-2.5 text-left font-medium">Epoch</th>
            {net.epochHistory[0].finals.map((f) => (
              <th key={f.key} className="px-4 py-2.5 text-left font-medium" colSpan={2}>
                {f.label}
              </th>
            ))}
          </tr>
          <tr className="label" style={{ background: 'var(--table-head)' }}>
            <th className="px-4 pb-2 text-left font-normal"></th>
            {net.epochHistory[0].finals.map((f) => (
              <FinalsHead key={f.key} />
            ))}
          </tr>
        </thead>
        <tbody>
          {net.epochHistory.map((e) => (
            <tr key={e.epoch} className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="px-4 py-2 tabular-nums" style={{ color: 'var(--text-strong)' }}>
                {e.epoch}
              </td>
              {e.finals.map((f) => (
                <FinalsCells key={f.key} vote={f.vote} proposal={f.proposal} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FinalsHead() {
  return (
    <>
      <th className="px-4 pb-2 text-left font-normal">vote</th>
      <th className="px-4 pb-2 text-left font-normal">proposal</th>
    </>
  );
}

function FinalsCells({ vote, proposal }: { vote: number | null; proposal: number | null }) {
  return (
    <>
      <td className="px-4 py-2 tabular-nums" style={{ color: rateColor(vote) }}>
        {fmtPct(vote)}
      </td>
      <td className="px-4 py-2 tabular-nums" style={{ color: proposal === null ? 'var(--idle)' : rateColor(proposal) }}>
        {fmtPct(proposal)}
      </td>
    </>
  );
}
