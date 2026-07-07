const { test, expect, describe, mock, beforeAll, afterAll } = require('bun:test');
const os = require('os');

const { fromRandom } = require('@ocap/wallet');

const mockName = 'mockBlockletName';
const mockDescription = 'mockBlockletDescription';
const mockAppDid = 'mockAppDid';
const mockVersion = 'mockVersion';
const mockAppUrl = 'mockAppUrl';

const appId = 'zNKpAC6QYU8Boc3KwPCtAbsG1fmXqQ1iuVVG';
const appPk = '0x76b9616f1698d9629276656eaab8b363cd36964b66226a19f8c8424b25c4b28f';

const addressA = fromRandom().address;
const addressB = fromRandom().address;
const addressC = fromRandom().address;
const addressD = fromRandom().address;

process.env.ABT_NODE_DATA_DIR = os.tmpdir();
process.env.ABT_NODE_SESSION_SECRET = '0x1b234ff1c8a64882f6118a128ed55a5f77f264909bcaa3fe3848ddcaa2bd9aa0';
process.env.ABT_NODE_SK =
  '0x0dcdfd854f9c5a54e4d22dae3ef8c66d9807e724f201659068602e5c646da5651b234ff1c8a64882f6118a128ed55a5f77f264909bcaa3fe3848ddcaa2bd9aa0';

mock.module('@blocklet/meta/lib/info', () => {
  return {
    __esModule: true,
    getBlockletInfo: () => ({
      did: appId,
      wallet: { address: appId, publicKey: appPk },
      name: mockName,
      description: mockDescription,
    }),
  };
});

const actualUtil = require('@blocklet/meta/lib/util');

mock.module('@blocklet/meta/lib/util-config', () => {
  return {
    ...actualUtil,
    getConfigs: () => {
      return [
        { key: 'prop1', value: true },
        { key: 'prop2', value: 0 },
        { key: 'prop3' },
        { key: 'prop4', value: null },
        { key: 'prop5', value: 'v5' },
        { key: 'prop6', value: new Date() },
        { key: 'prop7', value: {} },
        { key: 'prop8', value: [] },
        { key: 'prop9', value: () => {} },
        { key: 'prop10', value: { key1: 'str', key2: 1, key3: [] } },
        { key: 'prefs.prop11', value: 'value11' },
      ];
    },
  };
});

afterAll(() => {
  mock.restore();
  mock.clearAllMocks();
});

const express = require('express');
const request = require('supertest');
const { DEBOS_BLOCKLET_DID } = require('@abtnode/constant');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
// const { getBlockletInfo } = require('@blocklet/meta/lib/info');
const { init } = require('../../../api/routes/blocklet-info');

describe('blocklet info', () => {
  let node;
  let app;

  window.location.protocol = 'http:';

  beforeAll(() => {
    node = {
      getNodeInfo: () => ({
        did: 'serverDid123',
        webWalletUrl: 'https://web.wallet',
      }),
      getBlockletBlurhash: () => ({
        splashPortrait: 'U0PQ87~q?b~q?bfQj[fQ~qof9FWB?bfQayj[',
        splashLandscape: 'U2PQ87xu-;xu%MayfQj[~qj[D%ay%Mj[fQay',
      }),
      getBlocklet: ({ did }) => {
        if (did === addressA) {
          return {
            appDid: mockAppDid,
            meta: {
              version: mockVersion,
            },
            settings: {},
            environmentObj: {
              BLOCKLET_APP_URL: mockAppUrl,
              BLOCKLET_APP_LANGUAGES: 'zh',
            },
            status: 6,
          };
        }

        if (did === addressB) {
          return {
            appDid: mockAppDid,
            meta: {
              version: mockVersion,
              navigation: [{ title: 'a' }],
              theme: {
                background: '#eee',
              },
              copyright: {
                own: 'ArcBlock',
              },
            },
            settings: {},
            environmentObj: {},
            status: 6,
            children: [
              {
                meta: {
                  title: 'Child-1',
                  name: 'child-1',
                  version: '1.1.1',
                  did: 'child-did-1',
                  bundleName: 'child-name',
                  bundleDid: 'child-did',
                  interfaces: [{ name: 'publicUrl', type: 'web', path: '/', prefix: '*' }],
                },
                status: 8,
                mountPoint: '/abc',
              },
            ],
          };
        }

        if (did === addressC) {
          return {
            appDid: mockAppDid,
            meta: {
              version: mockVersion,
            },
            settings: {},
            env: {
              appDir: '/path/to/xxx',
            },
            environmentObj: {
              BLOCKLET_APP_URL: mockAppUrl,
              BLOCKLET_APP_LOGO_SQUARE: 'https://logo',
            },
            status: 8,
          };
        }

        if (did === addressD) {
          return {
            appDid: addressD,
            appPid: addressD,
            meta: {
              did: addressD,
              version: mockVersion,
            },
            settings: {
              authentication: {
                wallet: { enabled: true, order: 0, showQrcode: true, type: 'builtin' },
                passkey: { enabled: true, order: 1, type: 'builtin' },
              },
            },
            environmentObj: {
              BLOCKLET_APP_URL: mockAppUrl,
              BLOCKLET_COMPONENT_DID: DEBOS_BLOCKLET_DID,
            },
            status: 8,
            children: [
              {
                meta: {
                  title: 'DeBOS',
                  name: 'debos',
                  version: '1.0.0',
                  did: DEBOS_BLOCKLET_DID,
                  bundleName: 'debos',
                  interfaces: [{ name: 'publicUrl', type: 'web', path: '/', prefix: '*' }],
                },
                status: 8,
                mountPoint: '/',
              },
            ],
          };
        }

        throw new Error('cannot find blocklet');
      },
      on: () => {},
      dataDirs: {
        tmp: os.tmpdir(),
      },
      getBlockletDomainAliases: () => [],
    };

    app = express();

    app.use((_req, res, next) => {
      res.sendFile = file => {
        if (!res.headersSent) {
          res.send(file);
        }
      };

      next();
    });

    init(app, node);
  });

  // NOTICE: should NOT use expect().rejects/resolves with supertest!
  test('should work as expected', async () => {
    const scriptPrefix = 'window.blocklet = ';

    let res; // temp response

    // invalid param or blocklet
    res = await request(app).get('/xxxx/__blocklet__.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch('application/javascript');
    expect(res.text.startsWith(scriptPrefix)).toBe(true);
    expect(res.text).toMatch('window.blocklet = {}');

    res = await request(app).get('/xxxx/__blocklet__.js').set('x-blocklet-did', 'unknown');
    expect(res.status).toBe(200);

    // app env
    res = await request(app)
      .get('/xxxx/__blocklet__.js')
      .set('x-blocklet-did', addressA)
      .set('x-blocklet-real-did', addressA);

    expect(res.text).toMatch(`appId: "${mockAppDid}"`);
    expect(res.text).toMatch(`appName: "${mockName}"`);
    expect(res.text).toMatch(`appDescription: "${mockDescription}"`);
    expect(res.text).toMatch(`appUrl: "${mockAppUrl}"`);
    expect(res.text).toMatch('appPk: "');
    expect(res.text).toMatch('updatedAt: ');
    expect(res.text).toMatch('version: ""');
    expect(res.text).toMatch('简体中文');
    expect(res.text).toMatch('navigation: [');
    expect(res.text).toMatch('componentMountPoints: [');
    expect(res.text).toMatch('appLogo: "/.well-known/service/blocklet/logo');
    expect(res.text).toMatch('appLogoRect:');

    expect(res.text).toMatch('prop1: true');
    expect(res.text).toMatch('prop2: 0');
    expect(res.text).toMatch('prop3: undefined');
    expect(res.text).toMatch('prop4: null');
    expect(res.text).toMatch('prop5: "v5"');
    expect(res.text).toMatch('prop6:');
    expect(res.text).toMatch('prop7: {}');
    expect(res.text).toMatch('prop8: []');
    expect(res.text).toMatch('prop9:');
    expect(res.text).toMatch('prop10: {"key1":"str","key2":1,"key3":[]}');
    expect(res.text).toMatch('preferences: {"prop11":"value11"}');
    expect(res.text).toMatch('serverDid: "serverDid123"');

    res = await request(app)
      .get('/xxxx/__meta__.js')
      .set('x-blocklet-did', addressA)
      .set('x-blocklet-real-did', addressA);
    expect(res.text).toMatch(`appId: "${mockAppDid}"`);
    expect(res.text).toMatch(`appName: "${mockName}"`);
    expect(res.text).toMatch(`appDescription: "${mockDescription}"`);
    expect(res.text).toMatch(`appUrl: "${mockAppUrl}"`);
    expect(res.text).toMatch('navigation: [');
    expect(res.text).toMatch('componentMountPoints: [');
    expect(res.text).toMatch('preferences: {"prop11":"value11"}');
    expect(res.text).toMatch('serverDid: "serverDid123"');

    // component
    res = await request(app)
      .get('/xxxx/__blocklet__.js')
      .set('x-blocklet-did', addressA)
      .set('x-blocklet-component-id', addressA);
    expect(res.text).toMatch('isComponent: false');

    res = await request(app)
      .get('/xxxx/__blocklet__.js')
      .set('x-blocklet-did', addressA)
      .set('x-blocklet-component-id', addressB);
    expect(res.text).toMatch('isComponent: true');

    // prefix;
    res = await request(app).get('/xxxx/__blocklet__.js').set('x-blocklet-did', addressA).set('x-path-prefix', '/a');
    expect(res.text).toMatch('prefix: "/a/"');

    res = await request(app)
      .get('/xxxx/__blocklet__.js')
      .set('x-blocklet-did', addressA)
      .set('x-group-path-prefix', '/b');
    expect(res.text).toMatch('groupPrefix: "/b/"');

    res = await request(app)
      .get('/xxxx/__blocklet__.js')
      .set('x-blocklet-did', addressB)
      .set('x-blocklet-component-id', addressB);
    expect(res.text).toMatch('copyright: {');
    expect(res.text).toMatch('navigation: [');
    expect(res.text).toMatch('theme: {');

    // componentMountPoints;
    res = await request(app).get('/xxxx/__blocklet__.js').set('x-blocklet-did', addressB);
    expect(res.text).toMatch(
      'componentMountPoints: [{"title":"Child-1","name":"child-name","did":"child-did","version":"1.1.1","status":"stopped","mountPoint":"/abc","components":[],"capabilities":{}}]'
    );

    // json
    res = await request(app).get('/xxxx/__blocklet__.js?type=json').set('x-blocklet-did', addressA);
    expect(res._body.isComponent).toBe(true);
    expect(res._body.prefix).toBe('/');
    expect(res._body.componentMountPoints).toEqual([]);
    expect(res._body.serverDid).toBe('serverDid123');

    res = await request(app).get(`/blocklet/logo/${addressC}`);
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('/images/blocklet.png'); // remote error fallback

    // component logo
    res = await request(app).get(`/blocklet/logo-bundle/${addressC}`);
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('/images/blocklet.png'); // file does not exist

    // splash
    res = await request(app).get(`/blocklet/splash/portrait/${addressC}`);
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('/images/splash-portrait.png'); // remote error fallback
    res = await request(app).get(`/blocklet/splash/landscape/${addressC}`);
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('/images/splash-landscape.png'); // remote error fallback

    res = await request(app)
      .get('/xxxx/__blocklet__.js')
      .set('x-blocklet-did', addressB)
      .set('x-blocklet-component-id', 'child-did-1');
    expect(res.text).toMatch('version: "1.1.1"');

    // logo
    res = await request(app).get('/blocklet/logo/c');
    expect(res.statusCode).toBe(400);

    // component logo
    res = await request(app).get('/blocklet/logo-bundle/c');
    expect(res.statusCode).toBe(400);

    // splash
    res = await request(app).get('/blocklet/splash/portrait/c');
    expect(res.statusCode).toBe(400);
    res = await request(app).get('/blocklet/splash/landscape/c');
    expect(res.statusCode).toBe(400);
  }, 30_000);

  test('exposes Google auth metadata for launched DeBOS instances', async () => {
    process.env.DEBOS_GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.DEBOS_GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.DEBOS_GOOGLE_BROKER_URL = 'https://server.example/.well-known/server/admin';

    try {
      const res = await request(app).get('/xxxx/__blocklet__.js?type=json').set('x-blocklet-did', addressD);

      expect(res.status).toBe(200);
      expect(res._body.settings.authentication[LOGIN_PROVIDER.GOOGLE]).toEqual({
        enabled: true,
        order: 2,
        type: 'oauth',
      });
    } finally {
      delete process.env.DEBOS_GOOGLE_CLIENT_ID;
      delete process.env.DEBOS_GOOGLE_CLIENT_SECRET;
      delete process.env.DEBOS_GOOGLE_BROKER_URL;
    }
  });
});
