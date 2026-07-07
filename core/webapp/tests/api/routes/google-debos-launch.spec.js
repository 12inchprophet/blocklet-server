const { afterEach, beforeEach, describe, expect, test } = require('bun:test');
const express = require('express');
const request = require('supertest');
const { fromAppDid } = require('@arcblock/did-ext');
const { fromRandom } = require('@ocap/wallet');
const { DEBOS_BLOCKLET_DID, ROLES } = require('@abtnode/constant');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
const { getStatusFromError } = require('@blocklet/error');
require('express-async-errors');

process.env.ABT_NODE_SESSION_SECRET = 'test';

const googleDebosLaunchRoutes = require('../../../api/routes/auth/google-debos-launch');

const createNode = ({ blockletDid = DEBOS_BLOCKLET_DID, targetUserFactory } = {}) => {
  const wallet = fromRandom();
  const calls = {
    auditLog: [],
    loginUser: [],
  };

  return {
    wallet,
    calls,
    dataDirs: { data: undefined },
    getSessionSecret: () => Promise.resolve('test-session-secret'),
    getBlockletMetaFromUrl: () => Promise.resolve({ meta: { did: blockletDid } }),
    getBlocklet: ({ did }) =>
      Promise.resolve({
        did,
        appDid: did,
        meta: { did },
        environmentObj: {
          BLOCKLET_COMPONENT_DID: DEBOS_BLOCKLET_DID,
          BLOCKLET_APP_URL: 'https://target.example',
        },
      }),
    getBlockletEnvironments: () =>
      Promise.resolve({
        all: [
          { key: 'BLOCKLET_COMPONENT_DID', value: DEBOS_BLOCKLET_DID },
          { key: 'BLOCKLET_APP_URL', value: 'https://target.example' },
        ],
      }),
    getNodeInfo: () =>
      Promise.resolve({
        did: wallet.address,
        sk: wallet.secretKey,
      }),
    getUser: args => Promise.resolve(targetUserFactory ? targetUserFactory(args) : null),
    loginUser: args => {
      calls.loginUser.push(args);
      return Promise.resolve(args.user);
    },
    createAuditLog: args => {
      calls.auditLog.push(args);
      return Promise.resolve();
    },
  };
};

const createApp = (node, googleClientFactory) => {
  const app = express();
  app.use(express.json());
  googleDebosLaunchRoutes.init(app, node, { googleClientFactory });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(getStatusFromError(err)).send(err.message);
  });
  return app;
};

describe('Google DeBOS launch auth', () => {
  beforeEach(() => {
    process.env.DEBOS_GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.DEBOS_GOOGLE_CLIENT_SECRET = 'google-client-secret';
  });

  afterEach(() => {
    delete process.env.DEBOS_GOOGLE_CLIENT_ID;
    delete process.env.DEBOS_GOOGLE_CLIENT_SECRET;
  });

  test('reports whether Google OAuth is configured without exposing credentials', async () => {
    const app = createApp(createNode(), () => ({}));
    const res = await request(app)
      .get('/api/oauth/debos-launch/config')
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      google: {
        enabled: true,
        callbackUrl: 'https://server.example/oauth/debos-launch/callback/google',
        brokerUrl: 'https://server.example',
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('google-client-secret');
  });

  test('starts Google OAuth when the browser omits the referrer header', async () => {
    let authorizationState;
    const app = createApp(createNode(), config => ({
      getAuthorizationUrl: state => {
        authorizationState = state;
        expect(config.callbackUrl).toBe('https://server.example/oauth/debos-launch/callback/google');
        return 'https://accounts.google.com/o/oauth2/v2/auth';
      },
    }));

    const res = await request(app)
      .get('/oauth/debos-launch/google')
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(googleDebosLaunchRoutes.verifyState(authorizationState, 'test-session-secret')).toMatchObject({
      origin: 'https://server.example',
    });
  });

  test('rejects an explicitly cross-origin Google OAuth caller', async () => {
    const app = createApp(createNode(), () => {
      throw new Error('Google client must not be created');
    });

    const res = await request(app)
      .get('/oauth/debos-launch/google')
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https')
      .set('referer', 'https://attacker.example/launch');

    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid OAuth caller');
  });

  test('starts Google OAuth re-entry for an installed DeBOS instance', async () => {
    let authorizationState;
    const app = createApp(createNode(), config => ({
      getAuthorizationUrl: state => {
        authorizationState = state;
        expect(config.callbackUrl).toBe('https://server.example/oauth/debos-launch/callback/google');
        return 'https://accounts.google.com/o/oauth2/v2/auth';
      },
    }));

    const res = await request(app)
      .get('/oauth/debos-login/google')
      .query({ appDid: 'zTargetAppDid', redirect: '/admin/overview?x=1' })
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(googleDebosLaunchRoutes.verifyState(authorizationState, 'test-session-secret')).toMatchObject({
      flow: 'debos-login',
      appDid: 'zTargetAppDid',
      redirectPath: '/admin/overview?x=1',
    });
  });

  test('starts popup Google OAuth re-entry for the DeBOS login modal', async () => {
    let authorizationState;
    const app = createApp(createNode(), config => ({
      getAuthorizationUrl: state => {
        authorizationState = state;
        expect(config.callbackUrl).toBe('https://server.example/oauth/debos-launch/callback/google');
        return 'https://accounts.google.com/o/oauth2/v2/auth';
      },
    }));

    const res = await request(app)
      .get('/oauth/debos-login/google')
      .query({
        appDid: 'zTargetAppDid',
        redirect: '/',
        oauthPopup: '1',
        oauthCallbackUrl: 'https://target.example/.well-known/service/oauth/callback/google',
        oauthState: 'https://target.example',
      })
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(googleDebosLaunchRoutes.verifyState(authorizationState, 'test-session-secret')).toMatchObject({
      flow: 'debos-login',
      appDid: 'zTargetAppDid',
      oauthPopup: true,
      oauthCallbackUrl: 'https://target.example/.well-known/service/oauth/callback/google',
      oauthState: 'https://target.example',
    });
  });

  test('rejects a popup callback that does not belong to the target DeBOS instance', async () => {
    const app = createApp(createNode(), () => {
      throw new Error('Google client must not be created');
    });

    const res = await request(app)
      .get('/oauth/debos-login/google')
      .query({
        appDid: 'zTargetAppDid',
        redirect: '/',
        oauthPopup: '1',
        oauthCallbackUrl: 'https://attacker.example/.well-known/service/oauth/callback/google',
        oauthState: 'https://attacker.example',
      })
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(400);
    expect(res.text).toContain('does not belong to the target blocklet');
  });

  test('creates a one-time instance login grant for the Google owner', async () => {
    const node = createNode({
      targetUserFactory: ({ user }) => ({
        did: user.did,
        approved: true,
        role: ROLES.OWNER,
        connectedAccount: {
          provider: LOGIN_PROVIDER.GOOGLE,
          id: 'google-oauth2|owner',
        },
      }),
    });
    const googleClientFactory = () => ({
      getToken: () => Promise.resolve({ access_token: 'token' }),
      getProfile: () =>
        Promise.resolve({
          sub: 'google-oauth2|owner',
          name: 'Alice',
          email: 'alice@example.com',
          emailVerified: true,
        }),
    });
    const app = createApp(node, googleClientFactory);
    const ownerDid = fromAppDid('google-oauth2|owner', node.wallet.secretKey).address;
    const state = googleDebosLaunchRoutes.signState(
      {
        flow: 'debos-login',
        appDid: 'zTargetAppDid',
        redirectPath: '/admin/overview',
        expiresAt: Date.now() + 60_000,
      },
      'test-session-secret'
    );

    const res = await request(app)
      .get('/oauth/debos-launch/callback/google')
      .query({ code: 'authorization-code', state })
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(302);
    const redirectUrl = new URL(res.headers.location);
    expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe('https://target.example/.well-known/service/login');
    expect(redirectUrl.searchParams.get('debosGoogleGrant')).toBeTruthy();
    expect(redirectUrl.searchParams.get('redirect')).toBe('/admin/overview');
    expect(ownerDid).toBeTruthy();
  });

  test('returns a one-time owner grant through the DeBOS login modal OAuth callback', async () => {
    const node = createNode({
      targetUserFactory: ({ user }) => ({
        did: user.did,
        approved: true,
        role: ROLES.OWNER,
        connectedAccount: {
          provider: LOGIN_PROVIDER.GOOGLE,
          id: 'google-oauth2|owner',
        },
      }),
    });
    const googleClientFactory = () => ({
      getToken: () => Promise.resolve({ access_token: 'token' }),
      getProfile: () =>
        Promise.resolve({
          sub: 'google-oauth2|owner',
          name: 'Alice',
          email: 'alice@example.com',
          emailVerified: true,
        }),
    });
    const app = createApp(node, googleClientFactory);
    const state = googleDebosLaunchRoutes.signState(
      {
        flow: 'debos-login',
        appDid: 'zTargetAppDid',
        redirectPath: '/',
        oauthPopup: true,
        oauthCallbackUrl: 'https://target.example/.well-known/service/oauth/callback/google',
        oauthState: 'https://target.example',
        expiresAt: Date.now() + 60_000,
      },
      'test-session-secret'
    );

    const res = await request(app)
      .get('/oauth/debos-launch/callback/google')
      .query({ code: 'authorization-code', state })
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(302);
    const redirectUrl = new URL(res.headers.location);
    expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(
      'https://target.example/.well-known/service/oauth/callback/google'
    );
    expect(redirectUrl.searchParams.get('code')).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe('https://target.example');
  });

  test('rejects Google re-entry when the Google DID is not the DeBOS owner', async () => {
    const node = createNode();
    const googleClientFactory = () => ({
      getToken: () => Promise.resolve({ access_token: 'token' }),
      getProfile: () =>
        Promise.resolve({
          sub: 'google-oauth2|not-owner',
          email: 'not-owner@example.com',
        }),
    });
    const app = createApp(node, googleClientFactory);
    const state = googleDebosLaunchRoutes.signState(
      {
        flow: 'debos-login',
        appDid: 'zTargetAppDid',
        redirectPath: '/',
        expiresAt: Date.now() + 60_000,
      },
      'test-session-secret'
    );

    const res = await request(app)
      .get('/oauth/debos-launch/callback/google')
      .query({ code: 'authorization-code', state })
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(403);
    expect(res.text).toContain('not the owner');
  });

  test('creates an approved Google guest only for DeBOS', async () => {
    const node = createNode();
    const googleClientFactory = () => ({
      getToken: () => Promise.resolve({ access_token: 'token' }),
      getProfile: () =>
        Promise.resolve({
          sub: 'google-oauth2|123',
          name: 'Alice',
          email: 'alice@example.com',
          emailVerified: true,
        }),
    });
    const app = createApp(node, googleClientFactory);
    const state = googleDebosLaunchRoutes.signState(
      {
        origin: 'https://server.example',
        expiresAt: Date.now() + 60_000,
      },
      'test-session-secret'
    );

    const res = await request(app)
      .post('/api/oauth/debos-launch/login')
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https')
      .set('origin', 'https://server.example')
      .send({
        blockletMetaUrl: 'https://store.example/debos/blocklet.json',
        code: 'authorization-code',
        state,
      });

    expect(res.status).toBe(200);
    expect(res.body.sessionToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.provider).toBe(LOGIN_PROVIDER.GOOGLE);
    expect(node.calls.loginUser).toHaveLength(1);
    expect(node.calls.loginUser[0].user).toMatchObject({
      approved: true,
      fullName: 'Alice',
      email: 'alice@example.com',
      connectedAccount: {
        provider: LOGIN_PROVIDER.GOOGLE,
        id: 'google-oauth2|123',
      },
    });
    expect(node.calls.auditLog[0]).toMatchObject({
      action: 'login-debos-launch',
      args: {
        provider: LOGIN_PROVIDER.GOOGLE,
        blockletDid: DEBOS_BLOCKLET_DID,
      },
    });
  });

  test('rejects Google login when the metadata is not DeBOS', async () => {
    const node = createNode({ blockletDid: fromRandom().address });
    const app = createApp(node, () => ({}));
    const state = googleDebosLaunchRoutes.signState(
      {
        origin: 'https://server.example',
        expiresAt: Date.now() + 60_000,
      },
      'test-session-secret'
    );

    const res = await request(app)
      .post('/api/oauth/debos-launch/login')
      .set('host', 'server.example')
      .set('x-forwarded-proto', 'https')
      .set('origin', 'https://server.example')
      .send({
        blockletMetaUrl: 'https://store.example/other/blocklet.json',
        code: 'authorization-code',
        state,
      });

    expect(res.status).toBe(403);
    expect(res.text).toContain('only be used to launch DeBOS');
    expect(node.calls.loginUser).toHaveLength(0);
  });

  test('rejects a tampered OAuth state', () => {
    const state = googleDebosLaunchRoutes.signState(
      {
        origin: 'https://server.example',
        expiresAt: Date.now() + 60_000,
      },
      'test-session-secret'
    );

    expect(() => googleDebosLaunchRoutes.verifyState(`${state}tampered`, 'test-session-secret')).toThrow(
      'Invalid OAuth state'
    );
  });
});
