const { afterEach, describe, expect, test } = require('bun:test');
const { fromRandom } = require('@ocap/wallet');
const { DEBOS_BLOCKLET_DID, ROLES } = require('@abtnode/constant');
const { LOGIN_PROVIDER } = require('@blocklet/constant');

process.env.ABT_NODE_SESSION_SECRET = 'test';

const createLoginDebosLaunchAuth = require('../../../api/routes/auth/login-debos-launch');

const ORIGINAL_BLOCKED_DIDS = process.env.DEBOS_LAUNCH_BLOCKED_DIDS;

afterEach(() => {
  if (ORIGINAL_BLOCKED_DIDS === undefined) {
    delete process.env.DEBOS_LAUNCH_BLOCKED_DIDS;
  } else {
    process.env.DEBOS_LAUNCH_BLOCKED_DIDS = ORIGINAL_BLOCKED_DIDS;
  }
});

const createNode = ({ blockletDid = DEBOS_BLOCKLET_DID, existingUser = null } = {}) => {
  const nodeWallet = fromRandom();
  const calls = {
    loginUser: [],
    auditLog: [],
  };

  return {
    calls,
    isInitialized: () => Promise.resolve(true),
    getNodeInfo: () => Promise.resolve({ did: nodeWallet.address, name: 'Test Server' }),
    getSessionSecret: () => Promise.resolve('secret'),
    getBlockletMetaFromUrl: () => Promise.resolve({ meta: { did: blockletDid }, isFree: true }),
    getUser: () => Promise.resolve(existingUser),
    loginUser: args => {
      calls.loginUser.push(args);
      return Promise.resolve({
        ...args.user,
        approved: true,
      });
    },
    createAuditLog: args => {
      calls.auditLog.push(args);
      return Promise.resolve();
    },
  };
};

const createReq = () => ({
  headers: {},
  get: () => '',
  ip: '127.0.0.1',
});

describe('login-debos-launch auth route', () => {
  test('rejects non-DeBOS metadata', async () => {
    const route = createLoginDebosLaunchAuth(createNode({ blockletDid: fromRandom().address }));

    await expect(
      route.onStart({ extraParams: { locale: 'en', blockletMetaUrl: 'https://store.example/blocklet.json' } })
    ).rejects.toThrow('only be used to launch DeBOS');
  });

  test('creates an approved guest wallet session for DeBOS launch', async () => {
    const node = createNode();
    const route = createLoginDebosLaunchAuth(node);
    const userWallet = fromRandom();
    let sessionUpdate = null;

    await route.onAuth({
      claims: [{ type: 'profile', fullName: 'Alice', avatar: 'bn://avatar/alice.png' }],
      userDid: userWallet.address,
      userPk: userWallet.publicKey,
      updateSession: (updates, secure) => {
        sessionUpdate = { updates, secure };
      },
      extraParams: { locale: 'en', blockletMetaUrl: 'https://store.example/blocklet.json' },
      req: createReq(),
    });

    expect(node.calls.loginUser).toHaveLength(1);
    expect(node.calls.loginUser[0].user).toMatchObject({
      did: userWallet.address,
      pk: userWallet.publicKey,
      fullName: 'Alice',
      role: ROLES.GUEST,
      connectedAccount: {
        provider: LOGIN_PROVIDER.WALLET,
        did: userWallet.address,
        pk: userWallet.publicKey,
      },
    });
    expect(node.calls.auditLog[0].action).toBe('login-debos-launch');
    expect(sessionUpdate.secure).toBe(true);
    expect(sessionUpdate.updates.sessionToken).toBeTruthy();
    expect(sessionUpdate.updates.refreshToken).toBeTruthy();
  });

  test('does not revive an existing unapproved user', async () => {
    const route = createLoginDebosLaunchAuth(createNode({ existingUser: { approved: false } }));
    const userWallet = fromRandom();

    await expect(
      route.onAuth({
        claims: [],
        userDid: userWallet.address,
        userPk: userWallet.publicKey,
        updateSession: async () => {},
        extraParams: { locale: 'en', blockletMetaUrl: 'https://store.example/blocklet.json' },
        req: createReq(),
      })
    ).rejects.toThrow();
  });

  test('rejects a blocked wallet before creating a launch session', async () => {
    const node = createNode();
    const route = createLoginDebosLaunchAuth(node);
    const userWallet = fromRandom();
    process.env.DEBOS_LAUNCH_BLOCKED_DIDS = userWallet.address;

    await expect(
      route.onAuth({
        claims: [],
        userDid: userWallet.address,
        userPk: userWallet.publicKey,
        updateSession: async () => {},
        extraParams: { locale: 'en', blockletMetaUrl: 'https://store.example/blocklet.json' },
        req: createReq(),
      })
    ).rejects.toThrow('wallet is not allowed');
    expect(node.calls.loginUser).toHaveLength(0);
  });
});
