// Typed client for the Espresso query service (HotShot query API, /v1).
// Response shapes were derived from live mainnet responses, not from docs.

/** BLS verification key -> participation rate for the epoch, 0.0-1.0. */
export type ParticipationMap = Record<string, number>;

export interface StakeTableEntry {
  stake_table_entry: {
    stake_key: string;
    /** Hex-encoded wei-style amount. */
    stake_amount: string;
  };
  state_ver_key: string;
  connect_info: unknown;
}

export interface StakeTableResponse {
  epoch: number;
  stake_table: StakeTableEntry[];
}

export interface ValidatorInfo {
  /** L1 account of the validator. */
  account: string;
  /** BLS verification key (matches participation-map keys). */
  stake_table_key: string;
  state_ver_key: string;
  /** Hex-encoded total stake. */
  stake: string;
  /** Basis points, e.g. 1000 = 10%. */
  commission: number;
  delegators: Record<string, string>;
}

export interface FullValidatorInfo extends ValidatorInfo {
  authenticated?: boolean | null;
}

export class QueryError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;

async function get<T>(base: string, path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const url = `${base.replace(/\/$/, '')}/${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new QueryError(`HTTP ${res.status} for ${url}`, base, res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof QueryError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new QueryError(`${msg} for ${url}`, base);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Client over one or more query-service base URLs. Reads go to the first
 * healthy endpoint; on failure the next one is tried in order (failover).
 */
export class EspressoClient {
  /** Index of the endpoint that served the last successful request. */
  activeIndex = 0;

  constructor(readonly endpoints: string[]) {
    if (endpoints.length === 0) throw new Error('EspressoClient needs at least one endpoint');
  }

  get activeEndpoint(): string {
    return this.endpoints[this.activeIndex];
  }

  /** Try the active endpoint first, then the rest in order. */
  private async failover<T>(path: string): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.activeIndex + i) % this.endpoints.length;
      try {
        const out = await get<T>(this.endpoints[idx], path);
        this.activeIndex = idx;
        return out;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** Direct single-endpoint read, no failover. Used by health probing. */
  static async getFrom<T>(base: string, path: string, timeoutMs?: number): Promise<T> {
    return get<T>(base, path, timeoutMs);
  }

  blockHeight(): Promise<number> {
    return this.failover<number>('status/block-height');
  }

  /** Seconds since the last decide; the chain-stall signal. */
  timeSinceLastDecide(): Promise<number> {
    return this.failover<number>('status/time-since-last-decide');
  }

  successRate(): Promise<number> {
    return this.failover<number>('status/success-rate');
  }

  /** Cheapest known source of the current epoch number. */
  currentStakeTable(): Promise<StakeTableResponse> {
    return this.failover<StakeTableResponse>('node/stake-table/current');
  }

  voteParticipation(epoch: number | 'current'): Promise<ParticipationMap> {
    return this.failover<ParticipationMap>(`node/participation/vote/${epoch}`);
  }

  proposalParticipation(epoch: number | 'current'): Promise<ParticipationMap> {
    return this.failover<ParticipationMap>(`node/participation/proposal/${epoch}`);
  }

  /** Active validators for an epoch, keyed by L1 account. */
  validators(epoch: number): Promise<Record<string, ValidatorInfo>> {
    return this.failover<Record<string, ValidatorInfo>>(`node/validators/${epoch}`);
  }

  /** Paged scan over all (incl. inactive) validators, used to classify a key that left the active set. */
  async findInAllValidators(epoch: number, blsKey: string): Promise<FullValidatorInfo | null> {
    const pageSize = 100;
    for (let offset = 0; offset < 5000; offset += pageSize) {
      const page = await this.failover<FullValidatorInfo[]>(
        `node/all-validators/${epoch}/${offset}/${pageSize}`,
      );
      if (!Array.isArray(page) || page.length === 0) return null;
      const hit = page.find((v) => v.stake_table_key === blsKey);
      if (hit) return hit;
      if (page.length < pageSize) return null;
    }
    return null;
  }

  /** Per-block reward for an epoch, decimal wei string. */
  blockReward(epoch?: number): Promise<string> {
    return this.failover<string>(epoch === undefined ? 'node/block-reward' : `node/block-reward/epoch/${epoch}`);
  }
}

/** Hex wei amount -> whole ESP tokens (18 decimals), for display only. */
export function hexStakeToEsp(hex: string): number {
  try {
    return Number(BigInt(hex) / 10n ** 12n) / 1e6;
  } catch {
    return 0;
  }
}
