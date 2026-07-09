const { test, expect, describe, beforeEach, mock, spyOn } = require('bun:test');
const os = require('node:os');
const path = require('node:path');
const axios = require('@abtnode/util/lib/axios');
const fs = require('fs-extra');
const { fromRandom, WalletType } = require('@ocap/wallet');
const { types } = require('@ocap/mcrypto');
const { DEBOS_BLOCKLET_DID } = require('@abtnode/constant');
const lib = require('../lib/auth');
const {
  getKeyPairClaim,
  getTrustedIssuers,
  getServerlessNFTClaim,
  authenticateBySession,
  getLaunchBlockletClaims,
  getAppDidOwnerClaims,
  createLaunchBlockletHandler,
  createRotateKeyPairHandler,
  getBlockletPermissionChecker,
  getLauncherAppIdList,
} = require('../lib/server');

const { messages } = lib;

const context = { didwallet: { os: 'ios', version: '4.0.0' }, baseUrl: 'https://www.arcblock.io' };

describe('server', () => {
  beforeEach(() => {
    mock.restore();
  });

  describe('getTrustedIssuers', () => {
    test('should return trusted issuers array', () => {
      const nodeInfo = {
        did: 'test-did',
        trustedPassports: [
          {
            role: 'owner',
            issuerDid: 'test-issuer-id',
          },
          {
            role: 'guest',
          },
        ],
      };

      const result = getTrustedIssuers(nodeInfo);

      expect(result.length).toEqual(2);
      expect(result.includes('test-did')).toBe(true);
      expect(result.includes('test-issuer-id')).toBe(true);
    });
  });

  describe('getServerlessNFTClaim', () => {
    const locale = 'en';
    const testNftId = 'test-nft-id';

    test('should return correct claim', async () => {
      const claim = await getServerlessNFTClaim(testNftId, locale);

      expect(claim).toEqual({
        description: messages.requestBlockletSpaceNFT[locale],
        address: testNftId,
      });
    });
  });

  describe('authenticateBySession', () => {
    test('should return guest when no passport', async () => {
      const node = {
        getNodeInfo: () => ({ did: 'server01' }),
        getUser: () => ({ role: 'guest' }),
      };

      const result = await authenticateBySession({ node, userDid: 'a' });

      expect(result).toEqual({
        passport: null,
        role: 'guest',
        teamDid: 'server01',
        user: {
          role: 'guest',
        },
      });
    });

    ['owner', 'admin', 'member'].forEach((role) => {
      test(`should be authenticated when have ${role} passport`, async () => {
        const node = {
          getNodeInfo: () => ({ did: 'server01' }),
          getUser: () => ({ passports: [{ role, status: 'valid' }] }),
        };

        const result = await authenticateBySession({ node, userDid: 'a' });

        expect(result).toEqual({
          passport: null,
          role,
          teamDid: 'server01',
          user: {
            passports: [{ role, status: 'valid' }],
          },
        });
      });
    });
  });

  describe('getBlockletPermissionChecker', () => {
    test('should throw when condition not meet', async () => {
      const node = {
        getNodeInfo: () => ({ did: 'server01' }),
        getUser: () => ({ role: 'guest', approved: true }),
      };

      const checkFn = getBlockletPermissionChecker(node);

      await expect(checkFn({ userDid: 'a', extraParams: { connectedDid: 'a' } })).rejects.toThrow('permission');
    });

    test('should throw when user not approved', async () => {
      const node = {
        getNodeInfo: () => ({ did: 'server01' }),
        getUser: () => ({ role: 'guest', approved: false }),
      };

      const checkFn = getBlockletPermissionChecker(node);
      await expect(checkFn({ userDid: 'a', extraParams: { connectedDid: 'a' } })).rejects.toThrow('revoked');
    });

    test('should return passport when has owner passport', async () => {
      const node = {
        getNodeInfo: () => ({ did: 'server01' }),
        getUser: () => ({ passports: [{ role: 'owner', status: 'valid' }], approved: true }),
      };

      const checkFn = getBlockletPermissionChecker(node);
      const result = await checkFn({ userDid: 'a', extraParams: { connectedDid: 'a' } });
      expect(result).toBeUndefined();
    });

    test('should allow an approved guest to launch DeBOS', async () => {
      const getBlockletMetaFromUrl = mock().mockResolvedValue({ meta: { did: DEBOS_BLOCKLET_DID } });
      const node = {
        getNodeInfo: () => ({ did: 'server01' }),
        getUser: () => ({ passports: [], approved: true }),
        getBlockletMetaFromUrl,
      };

      const checkFn = getBlockletPermissionChecker(node);
      await expect(
        checkFn({ userDid: 'a', extraParams: { blockletMetaUrl: 'https://example.com/debos/blocklet.json' } })
      ).resolves.toBeUndefined();
      expect(getBlockletMetaFromUrl).toHaveBeenCalledWith({
        url: 'https://example.com/debos/blocklet.json',
        checkPrice: true,
      });
    });

    test('should reject an approved guest launching another blocklet', async () => {
      const node = {
        getNodeInfo: () => ({ did: 'server01' }),
        getUser: () => ({ passports: [], approved: true }),
        getBlockletMetaFromUrl: () => ({ meta: { did: 'z8iOtherBlocklet' } }),
      };

      const checkFn = getBlockletPermissionChecker(node);
      await expect(
        checkFn({ userDid: 'a', extraParams: { blockletMetaUrl: 'https://example.com/other/blocklet.json' } })
      ).rejects.toThrow('permission');
    });
  });

  describe('getLaunchBlockletClaims', () => {
    const node = {
      getNodeInfo: () => ({
        did: 'server01',
        ownerNft: { issuer: 'launcher-did' },
        launcher: { tag: 'dedicated', chainHost: 'main', did: 'launcher-did', nftDid: 'ownership-did' },
      }),
      getUser: () => ({ passports: [{ role: 'owner', status: 'valid' }] }),
    };

    test('should return expected when by session', async () => {
      let result = getLaunchBlockletClaims(node, 'session');
      expect(result.blockletAppKeypair).toBeTruthy();

      let claim = await result.blockletAppKeypair[1]({ extraParams: { locale: 'en', title: 'My App' }, context });
      expect(claim.moniker).toEqual('my-app');
      expect(claim.mfa).toBeTruthy();

      result = getLaunchBlockletClaims(node, 'session');
      claim = await result.blockletAppKeypair[1]({ extraParams: { locale: 'en', title: '测试应用' }, context });
      expect(claim.moniker).toEqual('ce-shi-ying-yong');
      expect(claim.mfa).toBeTruthy();
    });

    test('should return expected when by server nft', async () => {
      const result = getLaunchBlockletClaims(node, 'nft');
      expect(result.blockletAppKeypair).toBeTruthy();
      expect(result.serverNFT).toBeTruthy();

      let claim = await result.serverNFT[1]({ extraParams: { locale: 'en', title: 'ABC' }, context });
      expect(claim.trustedIssuers).toEqual(['launcher-did']);
      expect(claim.address).toEqual(node.getNodeInfo().launcher.nftDid);

      claim = await result.serverNFT[1]({
        extraParams: { launchType: 'serverless', nftId: 'serverless-nft-01' },
        context,
      });
      expect(claim.address).toEqual('serverless-nft-01');
    });

    test('should return expected when by vc', async () => {
      const result = getLaunchBlockletClaims(node, 'vc');
      expect(result.blockletAppKeypair).toBeTruthy();
      expect(result.serverPassport).toBeTruthy();

      const claim = await result.serverPassport[1]({
        extraParams: { locale: 'en', title: 'ABC' },
        context,
      });

      const info = node.getNodeInfo();

      expect(claim.trustedIssuers).toEqual([info.did, info.launcher.did]);
      expect(claim.optional).toEqual(false);
    });
  });

  describe('getAppDidOwnerClaims', () => {
    test('should return expected when by session', () => {
      const claims = getAppDidOwnerClaims();
      expect(claims.find((x) => x.authPrincipal)).toBeTruthy();
      expect(claims.find((x) => x.signature)).toBeTruthy();
    });
  });

  describe('createLaunchBlockletHandler', () => {
    const node = {
      getNodeInfo: () => ({
        did: 'server01',
        ownerNft: { issuer: 'launcher' },
        launcher: { tag: 'dedicated', chainHost: 'main' },
      }),
      getUser: () => ({ passports: [{ role: 'owner', status: 'valid' }] }),
      getBlockletMetaFromUrl: () => ({ meta: {}, isFree: true }),
      getPermissionsByRole: () => [{ name: 'mutate_blocklets' }],
      getBlocklet: () => null,
      startSession: () => ({ id: 'sessionId' }),
      installBlocklet: mock(),
      setupAppOwner: mock().mockResolvedValue({ setupToken: 'test-setup-token' }),
      getSessionSecret: () => 'test-session-secret',
    };

    const appWallet = fromRandom(
      WalletType({
        role: types.RoleType.ROLE_APPLICATION,
        pk: types.KeyType.ED25519,
        hash: types.HashType.SHA3,
      })
    );

    const params = {
      claims: [{ type: 'keyPair', secret: appWallet.secretKey }],
      challenge: 'random',
      userDid: 'ownerDid',
      extraParams: { locale: 'en', title: '', description: '', blockletMetaUrl: '' },
      updateSession: mock(),
      req: {
        get: mock(),
      },
    };

    test('should return expected when by session', async () => {
      const handler = createLaunchBlockletHandler(node, 'session');

      await expect(
        handler({
          ...params,
          claims: [],
        })
      ).rejects.toThrow('App key pair required');

      await expect(
        handler({
          ...params,
        })
      ).rejects.toThrow('Blocklet URL required');

      await handler({
        ...params,
        extraParams: { blockletMetaUrl: 'https://example.com/blocklet.json' },
      });
      expect(node.installBlocklet).toHaveBeenCalled();
      expect(node.setupAppOwner).toHaveBeenCalled();
      expect(params.updateSession).toHaveBeenCalledWith({ appDid: appWallet.address, sessionId: 'sessionId' });
      expect(params.updateSession).toHaveBeenCalledWith({ setupToken: 'test-setup-token' });
      expect(params.updateSession).not.toHaveBeenCalledWith({ isInstalled: true });

      node.installBlocklet.mockClear();
      node.setupAppOwner.mockClear();
      params.updateSession.mockClear();

      node.getBlocklet = () => ({ meta: {}, xxx: 'yyy' });
      await handler({
        ...params,
        extraParams: { blockletMetaUrl: 'https://example.com/blocklet.json' },
      });
      expect(node.installBlocklet).not.toHaveBeenCalled();
      expect(node.setupAppOwner).not.toHaveBeenCalled();
      expect(params.updateSession).toHaveBeenCalledWith({ appDid: appWallet.address, sessionId: 'sessionId' });
      expect(params.updateSession).toHaveBeenCalledWith({ isInstalled: true });
    });

    test('should install DeBOS for an approved guest session', async () => {
      const installBlocklet = mock();
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'debos-launch-server-test-'));
      const guestNode = {
        ...node,
        dataDirs: { data: dataDir },
        getUser: () => ({ approved: true, passports: [] }),
        getBlockletMetaFromUrl: () => ({ meta: { did: DEBOS_BLOCKLET_DID }, isFree: true }),
        getPermissionsByRole: () => [],
        getBlocklet: () => null,
        installBlocklet,
        setupAppOwner: mock().mockResolvedValue({ setupToken: 'test-setup-token' }),
      };
      const handler = createLaunchBlockletHandler(guestNode, 'session');

      try {
        await handler({
          ...params,
          updateSession: mock(),
          extraParams: { locale: 'en', blockletMetaUrl: 'https://example.com/debos/blocklet.json' },
        });
      } finally {
        await fs.remove(dataDir);
      }

      expect(installBlocklet).toHaveBeenCalledTimes(1);
    });

    test('should reject another blocklet for an approved guest session', async () => {
      const installBlocklet = mock();
      const guestNode = {
        ...node,
        getUser: () => ({ approved: true, passports: [] }),
        getBlockletMetaFromUrl: () => ({ meta: { did: 'z8iOtherBlocklet' }, isFree: true }),
        getPermissionsByRole: () => [],
        getBlocklet: () => null,
        installBlocklet,
      };
      const handler = createLaunchBlockletHandler(guestNode, 'session');

      await expect(
        handler({
          ...params,
          updateSession: mock(),
          extraParams: { locale: 'en', blockletMetaUrl: 'https://example.com/other/blocklet.json' },
        })
      ).rejects.toThrow('permission');
      expect(installBlocklet).not.toHaveBeenCalled();
    });
  });

  describe('getKeyPairClaim', () => {
    const node = {
      getNodeInfo: () => ({
        did: 'server01',
        ownerNft: { issuer: 'launcher' },
        launcher: { tag: 'dedicated', chainHost: 'main' },
      }),
    };

    test('should return expected when create new', async () => {
      const generator = getKeyPairClaim(node);

      await expect(generator({ extraParams: { locale: 'en', title: '' }, context })).resolves.toEqual({
        description: 'Please generate a new key-pair for this application',
        mfa: true,
        migrateFrom: '',
        declare: true,
        moniker: 'application',
        chainInfo: {
          host: 'none',
          id: 'none',
          type: 'arcblock',
        },
        targetType: {
          encoding: 'base58',
          hash: 'sha3',
          key: 'ed25519',
          role: 'application',
        },
      });

      await expect(
        generator({ extraParams: { locale: 'en', title: 'ABC', wt: 'arcblock' }, context })
      ).resolves.toEqual({
        description: 'Please generate a new key-pair for this application',
        mfa: true,
        migrateFrom: '',
        declare: true,
        moniker: 'abc',
        chainInfo: {
          host: 'none',
          id: 'none',
          type: 'arcblock',
        },
        targetType: {
          encoding: 'base58',
          hash: 'sha3',
          key: 'ed25519',
          role: 'application',
        },
      });

      await expect(generator({ extraParams: { locale: 'en', title: 'ABC', wt: 'eth' }, context })).resolves.toEqual({
        description: 'Please generate a new key-pair for this application',
        mfa: true,
        migrateFrom: '',
        declare: true,
        moniker: 'abc',
        chainInfo: {
          host: 'none',
          id: '1',
          type: 'ethereum',
        },
        targetType: {
          encoding: 'base16',
          hash: 'keccak',
          key: 'ethereum',
          role: 'application',
        },
      });
    });

    test('should return expected when rotate', async () => {
      const wallet = {
        server: fromRandom({ role: types.RoleType.ROLE_APPLICATION }),
        blocklet: fromRandom({ role: types.RoleType.ROLE_APPLICATION }),
      };

      const generator = getKeyPairClaim({
        getNodeInfo: () => ({
          sk: wallet.server.secretKey,
          did: wallet.server.address,
        }),
        getBlocklet: ({ did }) => {
          if (did === wallet.blocklet.address) {
            return {
              appDid: wallet.blocklet.address,
              meta: {
                did: 'awesome',
              },
              environments: [
                { key: 'BLOCKLET_APP_NAME', value: 'Def' },
                { key: 'BLOCKLET_APP_SK', value: wallet.blocklet.secretKey },
              ],
              configObj: {
                CHAIN_HOST: 'https://beta.abtnetwork.io/api/',
                CHAIN_ID: 'beta',
              },
            };
          }

          return null;
        },
      });

      await expect(
        generator({ extraParams: { locale: 'en', appDid: wallet.server.address }, context })
      ).rejects.toThrow(/Invalid blocklet/);

      await expect(
        generator({ extraParams: { locale: 'en', appDid: wallet.blocklet.address }, context })
      ).resolves.toEqual({
        description: 'Please generate a new key-pair for this application',
        mfa: true,
        migrateFrom: wallet.blocklet.address,
        declare: true,
        moniker: 'def',
        chainInfo: {
          host: 'https://beta.abtnetwork.io/api/',
          id: 'beta',
          type: 'arcblock',
        },
        targetType: {
          encoding: 'base58',
          hash: 'sha3',
          key: 'ed25519',
          role: 'application',
        },
      });
    });
  });

  describe('createRotateKeyPairHandler', () => {
    const wallet = {
      server: fromRandom({ role: types.RoleType.ROLE_APPLICATION }),
      blocklet: fromRandom({ role: types.RoleType.ROLE_APPLICATION }),
    };
    const node = {
      getNodeInfo: () => ({
        sk: wallet.server.secretKey,
        did: wallet.server.address,
      }),
      getUser: () => ({ passports: [{ role: 'owner', status: 'valid' }] }),
      getPermissionsByRole: () => [{ name: 'mutate_blocklets' }],
      getBlocklet: ({ did }) => {
        if (did === wallet.blocklet.address) {
          return {
            appDid: wallet.blocklet.address,
            appPid: wallet.blocklet.address,
            meta: {
              did: 'awesome',
            },
            environments: [
              { key: 'BLOCKLET_APP_NAME', value: 'Def' },
              { key: 'BLOCKLET_APP_SK', value: wallet.blocklet.secretKey },
            ],
          };
        }

        return null;
      },
      configBlocklet: mock(),
    };

    const params = {
      claims: [{ type: 'keyPair', secret: '0xabc' }],
      challenge: 'random',
      userDid: wallet.blocklet.address,
      extraParams: { locale: 'en' },
      req: {},
    };

    test('should return expected when by session', async () => {
      const handler = createRotateKeyPairHandler(node, 'session');

      await expect(handler({ ...params, claims: [] })).rejects.toThrow('App key pair required');
      await expect(handler({ ...params })).rejects.toThrow('Blocklet DID required');

      spyOn(node, 'configBlocklet');
      await handler({ ...params, extraParams: { locale: 'en', appDid: wallet.blocklet.address } });
      expect(node.configBlocklet).toBeCalledWith(
        {
          configs: [
            {
              key: 'BLOCKLET_APP_SK',
              secure: true,
              value: '0xabc',
            },
          ],
          did: 'awesome',
          skipHook: true,
        },
        {
          hostname: '',
          ip: '127.0.0.1',
          nodeMode: undefined,
          port: 0,
          protocol: 'http',
          query: undefined,
          ua: '',
          url: undefined,
          referrer: '',
          user: { role: 'owner', did: wallet.blocklet.address, fullName: 'Owner', locale: 'en' },
          timezone: '',
        }
      );
    });
  });

  describe('getLauncherAppIdList', () => {
    test('should throw error if launcher url is invalid', async () => {
      await expect(getLauncherAppIdList()).rejects.toThrow(/get launcher blocklet meta/i);
      await expect(getLauncherAppIdList({})).rejects.toThrow(/get launcher blocklet meta/i);
      await expect(getLauncherAppIdList('')).rejects.toThrow(/get launcher blocklet meta/i);
    });

    test('should retry if launcher server unreachable', async () => {
      const mockGet = spyOn(axios, 'get');
      await expect(getLauncherAppIdList('https://invalid-launcher-test.arcblock.io')).rejects.toThrow(
        /get launcher blocklet meta/i
      );
      expect(mockGet).toHaveBeenCalledTimes(4);
    }, 20000);

    test('should retry if launcher server unreachable 2', async () => {
      const mockGet = spyOn(axios, 'get');
      await expect(getLauncherAppIdList('https://invalid-launcher-test.arcblock.io')).rejects.toThrow(
        /get launcher blocklet meta/i
      );
      expect(mockGet).toHaveBeenCalledTimes(4);
    }, 20000);

    test('should return expected app id list', async () => {
      const mockData = {
        appId: 'zNKobn3BJYBkhBPnRzofGoQSMfLXDYnnrBg2',
        appPid: 'zNKobn3BJYBkhBPnRzofGoQSMfLXDYnnrBg2',
        alsoKnownAs: ['zNKjDm4Xsoaffb19UE6QxVeevuaTaLCS1n1S', ''],
      };
      const mockGet = spyOn(axios, 'get').mockResolvedValueOnce({
        data: mockData,
      });

      const result = await getLauncherAppIdList('https://invalid-launcher-test.arcblock.io');
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result).toEqual(['zNKobn3BJYBkhBPnRzofGoQSMfLXDYnnrBg2', 'zNKjDm4Xsoaffb19UE6QxVeevuaTaLCS1n1S']);
    }, 20000);

    test('should not read alsoKnownAs data if alsoKnownAs is no an array', async () => {
      const mockData = {
        appId: 'zNKobn3BJYBkhBPnRzofGoQSMfLXDYnnrBg2',
        appPid: 'zNKjDm4Xsoaffb19UE6QxVeevuaTaLCS1n1S',
        alsoKnownAs: null,
      };
      const mockGet = spyOn(axios, 'get').mockResolvedValueOnce({
        data: mockData,
      });

      const result = await getLauncherAppIdList('https://invalid-launcher-test.arcblock.io');
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result).toEqual(['zNKobn3BJYBkhBPnRzofGoQSMfLXDYnnrBg2', 'zNKjDm4Xsoaffb19UE6QxVeevuaTaLCS1n1S']);
    }, 20000);
  });
});
