const get = require('lodash/get');
const formatContext = require('@abtnode/util/lib/format-context');
const getRequestIP = require('@abtnode/util/lib/get-request-ip');
const { messages } = require('@abtnode/auth/lib/auth');
const { DEBOS_BLOCKLET_DID, ROLES, USER_SESSION_STATUS } = require('@abtnode/constant');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
const { CustomError } = require('@blocklet/error');
const { extractUserAvatar } = require('@abtnode/util/lib/user');
const { getDeviceData } = require('@abtnode/util/lib/device');
const getOrigin = require('@abtnode/util/lib/get-origin');
const { sign } = require('@blocklet/sdk/lib/util/csrf');
const { getAccessWallet } = require('@abtnode/util/lib/blocklet');

const { createTokenFn, getDidConnectVersion } = require('../../../util');
const logger = require('../../../libs/logger')('auth');

const localMessages = {
  missingBlockletMetaUrl: {
    en: 'Missing blocklet metadata URL',
    zh: '缺少应用元数据地址',
  },
  unsupportedBlocklet: {
    en: 'This login flow can only be used to launch DeBOS',
    zh: '此登录流程仅可用于启动 DeBOS',
  },
};

const getMessage = (key, locale = 'en') => localMessages[key]?.[locale] || localMessages[key]?.en || key;

const ensureDebosLaunchRequest = async ({ node, blockletMetaUrl, locale = 'en' }) => {
  if (!blockletMetaUrl) {
    throw new CustomError(400, getMessage('missingBlockletMetaUrl', locale));
  }

  const blocklet = await node.getBlockletMetaFromUrl({ url: blockletMetaUrl, checkPrice: true });
  if (blocklet?.meta?.did !== DEBOS_BLOCKLET_DID) {
    throw new CustomError(403, getMessage('unsupportedBlocklet', locale));
  }

  return blocklet;
};

module.exports = function createRoutes(node, authenticator, createSessionToken) {
  return {
    action: 'login-debos-launch',

    onStart: async ({ extraParams }) => {
      const { locale = 'en', blockletMetaUrl } = extraParams;
      await ensureDebosLaunchRequest({ node, blockletMetaUrl, locale });
    },

    onConnect: async ({ extraParams, request }) => {
      const { locale = 'en', blockletMetaUrl } = extraParams;
      await ensureDebosLaunchRequest({ node, blockletMetaUrl, locale });

      if ((await node.isInitialized()) === false) {
        throw new Error(messages.notInitialized[locale]);
      }

      const blocklet = await request.getBlocklet();
      const profileItems = (blocklet.settings?.session?.profileFields || ['fullName', 'avatar']).filter((item) =>
        ['fullName', 'avatar'].includes(item)
      );

      return {
        profile: {
          type: 'profile',
          description: messages.description?.[locale] || messages.description?.en,
          items: profileItems.length ? profileItems : ['fullName', 'avatar'],
          optional: true,
        },
      };
    },

    onAuth: async ({ claims, userDid, userPk, updateSession, extraParams, req }) => {
      const { locale = 'en', blockletMetaUrl, visitorId } = extraParams;
      await ensureDebosLaunchRequest({ node, blockletMetaUrl, locale });

      const blocklet = await req.getBlocklet();
      const blockletInfo = await req.getBlockletInfo();
      const { secret, did: teamDid } = blockletInfo;

      const existingUser = await node.getUser({
        teamDid,
        user: { did: userDid },
        options: { enableConnectedAccount: true },
      });
      if (existingUser && !existingUser.approved) {
        throw new CustomError(403, messages.notAllowedAppUser[locale]);
      }

      const profile = claims.find((x) => x.type === 'profile') || {};
      const role = ROLES.GUEST;
      const provider = LOGIN_PROVIDER.WALLET;
      const walletOS = req.context.didwallet.os;
      const lastLoginIp = getRequestIP(req);
      const deviceData = getDeviceData({ req });
      const connectedAccount = { provider, did: userDid, pk: userPk };

      try {
        const user = await node.loginUser({
          teamDid,
          user: {
            did: existingUser?.did || userDid,
            pk: existingUser?.pk || userPk,
            approved: true,
            locale,
            lastLoginIp,
            connectedAccount,
            fullName: profile.fullName || existingUser?.fullName,
            avatar: profile.avatar
              ? await extractUserAvatar(get(profile, 'avatar'), {
                  dataDir: blocklet.env.dataDir,
                })
              : existingUser?.avatar,
          },
        });

        await node.createAuditLog(
          {
            action: 'login-debos-launch',
            args: { teamDid, userDid: user.did, provider, blockletDid: DEBOS_BLOCKLET_DID },
            context: formatContext(Object.assign(req, { user: { ...user, role } })),
            result: user,
          },
          node
        );

        const userSessionDoc = await node.upsertUserSession({
          teamDid,
          visitorId,
          userDid: user.did,
          appPid: teamDid,
          status: USER_SESSION_STATUS.ONLINE,
          ua: null,
          lastLoginIp,
          extra: {
            walletOS,
            device: deviceData,
          },
          locale,
          origin: await getOrigin({ req }),
        });

        const createToken = createTokenFn(createSessionToken);
        const sessionConfig = blocklet.settings?.session || {};
        const { sessionToken, refreshToken } = createToken(
          user.did,
          {
            secret,
            role,
            fullName: user.fullName,
            provider,
            walletOS,
            emailVerified: !!user.emailVerified,
            phoneVerified: !!user.phoneVerified,
            elevated: false,
          },
          { ...sessionConfig, didConnectVersion: getDidConnectVersion(req) }
        );

        const nodeInfo = await node.getNodeInfo();
        const accessWallet = getAccessWallet({
          blockletAppDid: blocklet.appDid || blocklet.meta.did,
          serverSecretKey: nodeInfo.sk,
        });
        const csrfToken = sign(accessWallet.secretKey, sessionToken);

        await updateSession(
          {
            sessionToken,
            refreshToken,
            csrfToken,
            visitorId: userSessionDoc.visitorId,
          },
          true
        );

        logger.info('login-debos-launch.success', { userDid: user.did, blockletDid: DEBOS_BLOCKLET_DID });

        return {
          sessionToken,
          refreshToken,
          csrfToken,
          visitorId: userSessionDoc.visitorId,
        };
      } catch (err) {
        logger.error('login-debos-launch.error', { error: err, userDid });
        throw new Error(err.message);
      }
    },
  };
};

module.exports.ensureDebosLaunchRequest = ensureDebosLaunchRequest;
