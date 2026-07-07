const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { fromRandom } = require('@ocap/wallet');
const { DEBOS_BLOCKLET_DID, ROLES } = require('@abtnode/constant');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
const { getStatusFromError } = require('@blocklet/error');
const { createDebosGoogleLoginGrant } = require('@abtnode/auth/lib/debos-google-grant');

require('express-async-errors');

const createRoute = require('../../../api/services/auth/debos-google-login');

const tempDirs = [];

afterEach(() => {
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

const createApp = async ({ owner = true } = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debos-google-login-'));
  tempDirs.push(dataDir);

  const appDid = fromRandom().address;
  const ownerDid = fromRandom().address;
  const serverWallet = fromRandom();
  const calls = { auditLog: [] };
  const node = {
    dataDirs: { data: dataDir },
    getUser: () =>
      Promise.resolve(
        owner
          ? {
              did: ownerDid,
              approved: true,
              role: ROLES.OWNER,
              fullName: 'Alice',
              connectedAccount: {
                provider: LOGIN_PROVIDER.GOOGLE,
                id: 'google-oauth2|owner',
              },
            }
          : null
      ),
    createAuditLog: (args) => {
      calls.auditLog.push(args);
      return Promise.resolve();
    },
    upsertUserSession: (args) => Promise.resolve({ ...args, visitorId: args.visitorId || 'visitor-1' }),
    getNodeInfo: () => Promise.resolve({ sk: serverWallet.secretKey }),
  };
  const createSessionToken = (did, params) => JSON.stringify({ did, role: params.role, provider: params.provider });
  const router = express();
  router.use(express.json());
  router.use((req, _res, next) => {
    req.getBlocklet = () =>
      Promise.resolve({
        appDid,
        meta: { did: appDid },
        environmentObj: {
          BLOCKLET_COMPONENT_DID: DEBOS_BLOCKLET_DID,
        },
        settings: { session: {} },
      });
    req.getBlockletInfo = () => Promise.resolve({ did: appDid, secret: 'blocklet-secret' });
    next();
  });
  createRoute.init(router, node, createSessionToken);
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    res.status(getStatusFromError(err)).json({ error: err.message });
  });

  const grant = await createDebosGoogleLoginGrant(
    {
      appDid,
      userDid: ownerDid,
      provider: LOGIN_PROVIDER.GOOGLE,
      googleSub: 'google-oauth2|owner',
      profile: { email: 'alice@example.com' },
    },
    { dataDir }
  );

  return { app: router, grant, calls };
};

describe('DeBOS Google owner login exchange', () => {
  test('exchanges a one-time Google grant for an owner session', async () => {
    const { app, grant, calls } = await createApp();

    const res = await request(app)
      .post('/.well-known/service/api/debos-google-login/exchange')
      .send({ grant, visitorId: 'visitor-from-browser' });

    expect(res.status).toBe(200);
    expect(res.body.sessionToken).toContain(`"role":"${ROLES.OWNER}"`);
    expect(res.body.refreshToken).toContain(`"role":"${ROLES.OWNER}"`);
    expect(res.body.csrfToken).toBeTruthy();
    expect(res.body.visitorId).toBe('visitor-from-browser');
    expect(calls.auditLog[0]).toMatchObject({
      action: 'login-debos-google-owner',
      args: {
        provider: LOGIN_PROVIDER.GOOGLE,
        blockletDid: DEBOS_BLOCKLET_DID,
      },
    });
  });

  test('does not exchange a grant when the Google DID is not the owner', async () => {
    const { app, grant } = await createApp({ owner: false });

    const res = await request(app).post('/.well-known/service/api/debos-google-login/exchange').send({ grant });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('not the owner');
  });
});
