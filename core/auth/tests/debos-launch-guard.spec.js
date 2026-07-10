const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, expect, test } = require('bun:test');
const fs = require('fs-extra');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
const { DEBOS_BLOCKLET_DID, ROLES } = require('@abtnode/constant');

const {
  assertDebosLaunchLoginAllowed,
  getLedgerPath,
  reserveDebosLaunch,
  updateLaunchRecord,
} = require('../lib/debos-launch-guard');

const ORIGINAL_ENV = { ...process.env };

const createNode = (dataDir) => ({
  dataDirs: { data: dataDir },
});

const createReq = (ip) => ({
  ip,
  headers: {},
  get(name) {
    if (name === 'user-agent') {
      return 'bun-test';
    }
    return '';
  },
});

describe('debos-launch-guard', () => {
  let dataDir;

  beforeEach(async () => {
    process.env.DEBOS_LAUNCH_MIN_FREE_DISK_MB = '0';
    process.env.DEBOS_LAUNCH_MIN_FREE_MEMORY_MB = '0';
    process.env.DEBOS_LAUNCH_MAX_PENDING = '10';
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'debos-launch-guard-'));
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await fs.remove(dataDir);
  });

  test('requires verified Google email for launch login', () => {
    const node = createNode(dataDir);

    expect(() =>
      assertDebosLaunchLoginAllowed({
        node,
        provider: LOGIN_PROVIDER.GOOGLE,
        userDid: 'zGoogleUser',
        googleProfile: {
          sub: 'google-oauth2|123',
          email: 'alice@example.com',
          emailVerified: false,
        },
        req: createReq('203.0.113.10'),
      })
    ).toThrow('verified Google email');
  });

  test('allows one pending guest launch per wallet identity by default', async () => {
    const node = createNode(dataDir);
    const blocklet = { meta: { did: DEBOS_BLOCKLET_DID } };

    const first = await reserveDebosLaunch({
      node,
      blocklet,
      appDid: 'zApp1',
      role: ROLES.GUEST,
      provider: LOGIN_PROVIDER.WALLET,
      userDid: 'zWalletUser',
      user: { did: 'zWalletUser', approved: true },
      req: createReq('203.0.113.11'),
    });

    expect(first.status).toBe('pending');
    await expect(
      reserveDebosLaunch({
        node,
        blocklet,
        appDid: 'zApp2',
        role: ROLES.GUEST,
        provider: LOGIN_PROVIDER.WALLET,
        userDid: 'zWalletUser',
        user: { did: 'zWalletUser', approved: true },
        req: createReq('203.0.113.11'),
      })
    ).rejects.toThrow('already has an active DeBOS launch');

    const ledger = await fs.readJson(getLedgerPath(node));
    expect(ledger.records.map((item) => item.status)).toEqual(['pending', 'denied']);
  });

  test('tracks installed launch records by session id', async () => {
    const node = createNode(dataDir);
    const blocklet = { meta: { did: DEBOS_BLOCKLET_DID } };
    const record = await reserveDebosLaunch({
      node,
      blocklet,
      appDid: 'zApp1',
      role: ROLES.GUEST,
      provider: LOGIN_PROVIDER.WALLET,
      userDid: 'zWalletUser',
      user: { did: 'zWalletUser', approved: true },
      req: createReq('203.0.113.12'),
    });

    await updateLaunchRecord({ node, launchId: record.id, sessionId: 'launch-session-1', status: 'installed' });

    const ledger = await fs.readJson(getLedgerPath(node));
    expect(ledger.records.find((item) => item.id === record.id)).toMatchObject({
      sessionId: 'launch-session-1',
      status: 'installed',
    });
  });
});
