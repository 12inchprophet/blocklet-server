const { messages } = require('@abtnode/auth/lib/auth');
const { assertDebosLaunchLoginAllowed } = require('@abtnode/auth/lib/debos-launch-guard');
const formatContext = require('@abtnode/util/lib/format-context');
const getRequestIP = require('@abtnode/util/lib/get-request-ip');
const { DEBOS_BLOCKLET_DID, ROLES } = require('@abtnode/constant');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
const { CustomError } = require('@blocklet/error');

const logger = require('@abtnode/logger')(require('../../../package.json').name);

const { createToken } = require('../../libs/login');

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

const getProfileClaim = locale => ({
  profile: {
    type: 'profile',
    description: messages.description?.[locale] || messages.description?.en || 'Please provide your profile',
    items: ['fullName', 'avatar'],
    optional: true,
  },
});

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

module.exports = function createRoutes(node) {
  return {
    action: 'login-debos-launch',

    onStart: async ({ extraParams }) => {
      const { locale = 'en', blockletMetaUrl } = extraParams;
      await ensureDebosLaunchRequest({ node, blockletMetaUrl, locale });
    },

    claims: {
      profile: async ({ extraParams }) => {
        const { locale = 'en', blockletMetaUrl } = extraParams;

        if ((await node.isInitialized()) === false) {
          throw new Error(messages.notInitialized[locale]);
        }

        await ensureDebosLaunchRequest({ node, blockletMetaUrl, locale });

        return getProfileClaim(locale).profile;
      },
    },

    onAuth: async ({ claims, userDid, userPk, updateSession, extraParams, req }) => {
      const { locale = 'en', blockletMetaUrl } = extraParams;
      await ensureDebosLaunchRequest({ node, blockletMetaUrl, locale });
      await assertDebosLaunchLoginAllowed({
        node,
        provider: LOGIN_PROVIDER.WALLET,
        userDid,
        req,
      });

      const info = await node.getNodeInfo();
      const existingUser = await node.getUser({
        teamDid: info.did,
        user: { did: userDid },
        options: { enableConnectedAccount: true },
      });
      if (existingUser && !existingUser.approved) {
        throw new CustomError(403, messages.notAllowedAppUser[locale]);
      }

      const profile = claims.find(x => x.type === 'profile') || {};

      try {
        const doc = await node.loginUser({
          teamDid: info.did,
          user: {
            did: userDid,
            pk: userPk,
            locale,
            fullName: profile.fullName,
            avatar: profile.avatar,
            role: ROLES.GUEST,
            lastLoginIp: getRequestIP(req),
            connectedAccount: {
              provider: LOGIN_PROVIDER.WALLET,
              did: userDid,
              pk: userPk,
            },
          },
        });

        await node.createAuditLog(
          {
            action: 'login-debos-launch',
            args: { teamDid: info.did, userDid, provider: LOGIN_PROVIDER.WALLET, blockletDid: DEBOS_BLOCKLET_DID },
            context: formatContext(Object.assign(req, { user: { ...doc, role: ROLES.GUEST } })),
            result: doc,
          },
          node
        );

        const { sessionToken, refreshToken } = await createToken(userDid, {
          secret: await node.getSessionSecret(),
          role: ROLES.GUEST,
          fullName: doc?.fullName,
          elevated: false,
          provider: LOGIN_PROVIDER.WALLET,
          purpose: 'debos-launch',
          launchBlockletDid: DEBOS_BLOCKLET_DID,
        });

        await updateSession({ sessionToken, refreshToken }, true);
        logger.info('login-debos-launch.success', { userDid, blockletDid: DEBOS_BLOCKLET_DID });
      } catch (err) {
        logger.error('login-debos-launch.error', { error: err, userDid });
        throw new Error(err.message);
      }
    },
  };
};

module.exports.ensureDebosLaunchRequest = ensureDebosLaunchRequest;
