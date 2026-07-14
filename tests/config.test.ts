// Config parsing: validator entries in every accepted shape, and the
// defaults that .env.example promises.

import { describe, it, expect, vi } from 'vitest';

const ENV_KEYS =
  /^(MAINNET|TESTNET|QUERY|STAKING|CONSECUTIVE|LOCAL|HEIGHT|STUCK|POLL|STATE|TELEGRAM|SLACK|DISCORD|PAGERDUTY|ALERT|HEARTBEAT|STATUS|MISSED|DECIDE)/;

async function fresh(env: Record<string, string>) {
  vi.resetModules();
  for (const k of Object.keys(process.env)) if (ENV_KEYS.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const mod = await import('../src/lib/config');
  return mod.loadConfig();
}

const BLS = 'BLS_VER_KEY~At1pSArjX2jiti-TRGmTJ5S4ptA9eyedToIjGbhyfy-u04nTxKzdn8dr25SMUgevHxau';
const ADDR = '0xA5d75b9b781dbEcF3614ba75Cc6078bF0b9286B3';

describe('validator entries', () => {
  it('accepts a bare BLS key with a shortened default label', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: BLS });
    expect(cfg.networks[0].validators).toEqual([{ key: BLS, label: 'At1pSA…Hxau' }]);
  });

  it('accepts Label=BLS', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: `Huginn=${BLS}` });
    expect(cfg.networks[0].validators[0]).toEqual({ key: BLS, label: 'Huginn' });
  });

  it('lowercases a labeled 0x address', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: `Huginn=${ADDR}` });
    expect(cfg.networks[0].validators[0]).toEqual({ key: ADDR.toLowerCase(), label: 'Huginn' });
  });

  it('gives a bare address a short label', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: ADDR });
    expect(cfg.networks[0].validators[0]).toEqual({ key: ADDR.toLowerCase(), label: '0xa5d7…86b3' });
  });

  it('treats a non-key non-address value as an opaque key (never drops it)', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: 'Huginn=0xL1adress' });
    expect(cfg.networks[0].validators[0].key).toBe('Huginn=0xL1adress');
  });

  it('splits comma-separated entries', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: `A=${BLS},B=${ADDR}` });
    expect(cfg.networks[0].validators.map((v) => v.label)).toEqual(['A', 'B']);
  });
});

describe('defaults', () => {
  it('matches what .env.example documents', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: BLS });
    expect(cfg.consecutiveMissesWarn).toBe(3);
    expect(cfg.consecutiveMissesCrit).toBe(5);
    expect(cfg.localDownFails).toBe(5);
    expect(cfg.localDownPageMin).toBe(10);
    expect(cfg.stuckAfterMin).toBe(5);
    expect(cfg.networks[0].stakingApis).toEqual(['https://cache.main.net.espresso.network/v0/staking']);
    expect(cfg.networks[0].queryNodes).toEqual(['https://query.main.net.espresso.network/v1']);
  });

  it('never creates a testnet network while TESTNET_VALIDATORS is empty', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: BLS });
    expect(cfg.networks.map((n) => n.name)).toEqual(['mainnet']);
  });

  it('enables testnet with Decaf defaults when TESTNET_VALIDATORS is set', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: BLS, TESTNET_VALIDATORS: `Test=${ADDR}` });
    const t = cfg.networks.find((n) => n.name === 'testnet')!;
    expect(t.validators[0]).toEqual({ key: ADDR.toLowerCase(), label: 'Test' });
    expect(t.stakingApis).toEqual(['https://cache.decaf.testnet.espresso.network/v0/staking']);
    expect(t.queryNodes).toEqual(['https://query.decaf.testnet.espresso.network/v1']);
  });

  it('reads STAKING_API as a comma-separated failover list', async () => {
    const cfg = await fresh({ MAINNET_VALIDATORS: BLS, STAKING_API: 'https://a/v0/staking, https://b/v0/staking' });
    expect(cfg.networks[0].stakingApis).toEqual(['https://a/v0/staking', 'https://b/v0/staking']);
  });
});
