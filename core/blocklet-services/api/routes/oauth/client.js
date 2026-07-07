const { handleInvitationReceive, getApplicationInfo } = require('@abtnode/auth/lib/auth');
const { createPassportList, createPassportSwitcher } = require('@abtnode/auth/lib/oauth');
const { DEBOS_BLOCKLET_DID, WELLKNOWN_SERVICE_PATH_PREFIX } = require('@abtnode/constant');
const { extractUserAvatar, getUserAvatarUrl } = require('@abtnode/util/lib/user');
const { fromAppDid } = require('@arcblock/did-ext');
const pick = require('lodash/pick');
const cloneDeep = require('@abtnode/util/lib/deep-clone');
const { joinURL, withHttps, withQuery, withTrailingSlash } = require('ufo');
const { upsertToPassports } = require('@abtnode/auth/lib/passport');
const { getWalletDid, getConnectedAccounts, getSourceProvider } = require('@blocklet/meta/lib/did-utils');
const formatContext = require('@abtnode/util/lib/format-context');
const createTranslator = require('@abtnode/util/lib/translate');
const { CustomError } = require('@blocklet/error');
const { LOGIN_PROVIDER, OAUTH_PROVIDER_PUBLIC_FIELDS } = require('@blocklet/constant');
const { getLastUsedPassport } = require('@abtnode/auth/lib/passport');
const { getAvatarByEmail, getAvatarByUrl } = require('@abtnode/util/lib/user');
const { transferPassport } = require('@abtnode/auth/lib/util/transfer-passport');
const { fromBase64 } = require('@ocap/util');
const { sign } = require('@blocklet/sdk/lib/util/csrf');
const { getAccessWallet } = require('@abtnode/util/lib/blocklet');

const logger = require('../../libs/logger')('oauth:client');
const { OauthClient } = require('../../libs/auth');
const OAuthAuth0 = require('../../libs/auth/adapters/auth0');
const OAuthAuth0Legacy = require('../../libs/auth/adapters/auth0-legacy');
const OAuthGithub = require('../../libs/auth/adapters/github');
const OAuthGoogle = require('../../libs/auth/adapters/google');
const OAuthApple = require('../../libs/auth/adapters/apple');
const OAuthTwitter = require('../../libs/auth/adapters/twitter');
const initJwt = require('../../libs/jwt');
const { sendToUser } = require('../../libs/notification');
const { createTokenFn, getDidConnectVersion, redirectWithoutCache } = require('../../util');
const federatedUtil = require('../../util/federated');
const userUtil = require('../../util/user-util');
const { isOAuthEmailVerified, isEmailUniqueRequired, isEmailKycRequired, isSameEmail } = require('../../libs/kyc');
const checkUser = require('../../middlewares/check-user');
const { exchangeDebosGoogleLoginGrant } = require('../../services/auth/debos-google-login');

const PREFIX = WELLKNOWN_SERVICE_PATH_PREFIX;

const prefix = `${PREFIX}/oauth`;
const prefixApi = `${PREFIX}/api/oauth`;

const getRequestOrigin = (req) => {
  const protocol = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host')).split(',')[0].trim();
  return `${protocol}://${host}`;
};

const getEnvironmentValue = (blocklet, key) =>
  blocklet?.environmentObj?.[key] || (blocklet?.environments || []).find((item) => item.key === key)?.value;

const isDebosBlocklet = (blocklet) => {
  const dids = [
    blocklet?.did,
    blocklet?.appDid,
    blocklet?.appPid,
    blocklet?.meta?.did,
    blocklet?.environmentObj?.BLOCKLET_COMPONENT_DID,
    getEnvironmentValue(blocklet, 'BLOCKLET_COMPONENT_DID'),
    ...(blocklet?.componentMountPoints || []).map((item) => item.did),
    ...(blocklet?.children || []).map((item) => item?.meta?.did || item?.did),
  ].filter(Boolean);

  return dids.includes(DEBOS_BLOCKLET_DID);
};

const getDebosGoogleBrokerUrl = () => process.env.DEBOS_GOOGLE_BROKER_URL?.replace(/\/+$/, '');

const getDebosBlockletAppDid = (blocklet) =>
  blocklet?.appPid || blocklet?.appDid || blocklet?.did || blocklet?.meta?.did;

const canUseDebosGoogleBroker = (blocklet) =>
  isDebosBlocklet(blocklet) && Boolean(getDebosGoogleBrokerUrl() && getDebosBlockletAppDid(blocklet));

const getDebosGoogleCallbackUrl = (req) => joinURL(getRequestOrigin(req), prefix, '/callback', LOGIN_PROVIDER.GOOGLE);

const translations = {
  zh: {
    alreadyMainAccount: '当前邮箱已经绑定过该应用，不过你可以先以此邮箱登陆，然后再绑定钱包账户',
    alreadyBindWallet: '当前邮箱已经绑定过钱包账户 {did}。',
    alreadyExist: '当前账户已存在，无法完成绑定操作。',
    alreadyBindProvider: '当前账户绑定过 {provider}，无法完成绑定操作。',
    oauthCantBeOwner: '第三方登录的账户不能成为应用的拥有者',
    oauthCantBindOauth: '第三方登录的账户无法绑定另一个第三方登录的账户',
    cantUnbindWalletAccount: '不能解绑钱包账户',
    cantUnbindSourceProvider: '不能解绑源账户',
    accountNotExist: '第三方登录的账户不存在，无法完成解绑操作',
    emailUniqueRequired: '当前邮箱已经绑定过另一个账户，请更换邮箱',
    notAllowedToDelete: '您无权删除此用户 {did}',
    oauthUserInfoInvalid: '第三方登录的账户信息无效，无法完成登录操作',
    failedToGetUserInfo: '获取用户信息失败',
  },
  en: {
    alreadyMainAccount:
      'Your email has already logged in to the app, so binding cannot be completed. However, you can first log in with this email and then bind your wallet account.',
    alreadyBindWallet: 'Your account is already bond to wallet account {did}, so binding can not be completed.',
    alreadyExist: 'Your account already exists, so binding cannot be completed.',
    alreadyBindProvider: 'Your account is already bind to {provider}, so binding can not be completed.',
    oauthCantBeOwner: "Can't login oauth account as owner",
    oauthCantBindOauth: "Current account can't bind to a third party account",
    cantUnbindWalletAccount: 'Cannot unbind wallet provider',
    cantUnbindSourceProvider: 'Cannot unbind source provider',
    accountNotExist: "Connected account is not exist, can't finish disconnect",
    emailUniqueRequired: 'Current email is already bind to another account, please change email',
    notAllowedToDelete: 'You are not allowed to delete user {did}',
    oauthUserInfoInvalid: 'Third party login account information is invalid, cannot complete login operation',
    failedToGetUserInfo: 'Failed to get user info',
  },
};

const t = createTranslator({ translations });

async function getOAuthUserInfo({ blocklet, provider, token, idToken, code, appPid }) {
  let oauthInfo;
  const authClient = getAuthClient(blocklet, provider, {
    appPid,
    legacy: Boolean(token && provider === 'auth0'),
  });
  // FIXME: 临时兼容 auth0 这种直接传 token 的方式，将来要废弃这种方式
  if (token && provider === 'auth0') {
    oauthInfo = await authClient.getProfile(token);
  } else if (idToken) {
    // FIXME: 临时提供 id_token 方案，将来要废弃这种方式
    oauthInfo = await authClient.getProfile({ id_token: idToken });
  } else if (code) {
    const oauthToken = await authClient.getToken({ code });
    oauthInfo = await authClient.getProfile(oauthToken);
  }

  if (oauthInfo) {
    oauthInfo.provider = provider;
  }

  return oauthInfo;
}

async function getOAuthFederatedUserInfo(req, { blocklet, locale = 'en' }) {
  let userWallet;
  let oauthInfo;
  const { token, idToken, code, provider, sourceAppPid = null } = req.body;

  // appUrl
  const { wallet: blockletWallet } = await req.getBlockletInfo();

  // NOTICE: 如果是统一登录，则向 master 站点发起 oauth 用户信息查询请求，auth0 的账户信息必须由 master 来生成
  if (sourceAppPid) {
    const data = await federatedUtil.getOAuthUserInfo({
      request: req,
      blocklet,
      provider,
      sourceAppPid,
      // 三种用于获取用户信息的方式，任选其一即可
      token,
      idToken,
      code,
      locale,
    });
    userWallet = data.wallet;
    oauthInfo = data.info;
  } else {
    oauthInfo = await getOAuthUserInfo({ blocklet, provider, code, idToken, token });
  }
  if (!oauthInfo?.sub) {
    throw new CustomError(400, t('failedToGetUserInfo', locale));
  }
  if (!userWallet) {
    userWallet = fromAppDid(oauthInfo.sub, blockletWallet.secretKey);
  }
  return { info: oauthInfo, wallet: userWallet };
}

function getAuthClient(blocklet, provider, { legacy = false, appPid } = {}) {
  const oauthConfig = cloneDeep(blocklet?.settings?.authentication || {});
  const providerConfig = oauthConfig?.[provider];
  if (!providerConfig) {
    throw new CustomError(400, `Provider ${provider} is not valid`);
  }
  // NOTICE: 这里的 callbackUrl 只能是配置在 oauth 中 callback 的地址，不能是当前应用的任意一个域名
  let appUrl = blocklet?.environmentObj?.BLOCKLET_APP_URL;
  if (appPid) {
    const federatedSites = blocklet.settings?.federated?.sites || [];
    const loginSite = federatedSites.find((x) => x.appPid === appPid);
    appUrl = loginSite.appUrl;
  }
  providerConfig.callbackUrl = joinURL(appUrl, prefix, '/callback', provider);

  if (provider === 'auth0') {
    if (legacy) {
      // FIXME: 将来需要移除 legacy auth0 的支持
      return new OAuthAuth0Legacy.AuthenticationClient({
        domain: providerConfig.domain,
      });
    }
    if (!providerConfig.clientSecret) {
      throw new Error('missing client secret');
    }
    return new OauthClient({
      provider: OAuthAuth0({
        // HACK: auth0 比较奇葩，它的 issuer 有斜杠后缀
        issuer: withTrailingSlash(withHttps(providerConfig.domain)),
        clientId: providerConfig.clientId,
        clientSecret: providerConfig.clientSecret,
        callbackUrl: providerConfig.callbackUrl,
      }),
    });
  }

  if (provider === 'github') {
    return new OauthClient({ provider: OAuthGithub(providerConfig) });
  }
  if (provider === 'google') {
    return new OauthClient({ provider: OAuthGoogle(providerConfig) });
  }
  if (provider === 'apple') {
    return new OauthClient({ provider: OAuthApple(providerConfig) });
  }
  if (provider === 'twitter') {
    return new OauthClient({ provider: OAuthTwitter(providerConfig) });
  }
  return null;
}

async function login(req, node, options) {
  const blocklet = await req.getBlocklet();
  const teamDid = blocklet.appPid;
  const { locale = 'en', provider, inviter = null, sourceAppPid = null } = req.body;
  if (!blocklet.settings?.owner) {
    throw new CustomError(400, t('oauthCantBeOwner', locale));
  }

  const { info: oauthInfo, wallet: userWallet } = await getOAuthFederatedUserInfo(req, {
    blocklet,
    locale,
  });

  const userDid = userWallet.address;
  const userPk = userWallet.publicKey;

  let currentUser = await federatedUtil.getUserWithinFederated(
    { sourceAppPid, teamDid, userDid, userPk },
    { node, blocklet }
  );
  const connectedAccount = {
    provider,
    did: userDid,
    pk: userPk,
    id: oauthInfo.sub,
    userInfo: oauthInfo,
  };
  let profile;
  const lastUsedPassport = getLastUsedPassport(currentUser?.passports, '', { useFallback: false });
  // 如果当前用户不存在，并且是 destroy-self 操作，则抛出错误
  if (!currentUser && req.body.action === 'destroy-self') {
    throw new CustomError(400, t('notAllowedToDelete', locale));
  }
  if (!currentUser) {
    currentUser = {
      did: userDid,
      pk: userPk,
    };
    await userUtil.checkNeedInvite({ req, node, teamDid, locale });

    if (isEmailUniqueRequired(blocklet)) {
      const used = await node.isEmailUsed({
        teamDid,
        email: oauthInfo.email,
        verified: isEmailKycRequired(blocklet),
        sourceProvider: oauthInfo.provider,
      });
      if (used) {
        throw new CustomError(400, t('emailUniqueRequired', locale));
      }
    }

    // 当前 oauth 账户不存在，自动添加一个新用户
    const avatar = oauthInfo.picture
      ? await userUtil.getAvatarBnByUrl(oauthInfo.picture, { req, node })
      : await userUtil.getAvatarBnByEmail(oauthInfo.email, { req, node });
    profile = {
      fullName: oauthInfo.name,
      email: oauthInfo.email,
      avatar,
      emailVerified: isOAuthEmailVerified(blocklet, oauthInfo),
      inviter,
    };
  } else if (
    [LOGIN_PROVIDER.APPLE, LOGIN_PROVIDER.GITHUB, LOGIN_PROVIDER.AUTH0, LOGIN_PROVIDER.GOOGLE].includes(
      currentUser.sourceProvider
    )
  ) {
    // HACK: 由于某些旧的数据，可能存在 emailVerified 为 false 的情况，此处做一个强制覆盖（因为是 OAuth 的信息，可以信任）
    profile = {
      emailVerified: isOAuthEmailVerified(blocklet, oauthInfo),
    };
  }

  const { sessionToken, refreshToken, visitorId } = await userUtil.loginUserSession(
    {
      did: currentUser.did || userDid,
      pk: currentUser.pk,
      profile,
      passport: lastUsedPassport,
      sourceAppPid,
      connectedAccount,
      provider,
    },
    { req, node, options }
  );

  // for backward compatibility
  if (!getDidConnectVersion(req)) {
    return sessionToken;
  }

  // 生成 csrf token
  const nodeInfo = await req.getNodeInfo();
  const accessWallet = getAccessWallet({
    blockletAppDid: blocklet.appDid || blocklet.meta.did,
    serverSecretKey: nodeInfo.sk,
  });
  const csrfToken = await sign(accessWallet.secretKey, sessionToken);

  const result = { sessionToken, refreshToken, visitorId, csrfToken };

  if (req.body.action === 'destroy-self') {
    const parsed = JSON.parse(fromBase64(req.body.payload).toString());
    const destroySession = await node.startSession({
      data: { ...parsed, type: 'destroy', operator: currentUser.did || userDid },
    });
    result.destroySessionId = destroySession.id;
  }

  return result;
}

async function invite(req, node, options) {
  const { locale, inviteId, baseUrl, provider = LOGIN_PROVIDER.AUTH0, sourceAppPid = null } = req.body;
  const blocklet = await req.getBlocklet();
  const teamDid = blocklet.appPid;

  const { info: oauthInfo, wallet: userWallet } = await getOAuthFederatedUserInfo(req, {
    blocklet,
    locale,
  });

  const nodeInfo = await req.getNodeInfo();
  const userDid = userWallet.address;
  const userPk = userWallet.publicKey;

  let profile;
  let currentUser = await federatedUtil.getUserWithinFederated(
    { sourceAppPid, teamDid, userDid, userPk },
    { node, blocklet }
  );

  const { name: applicationName } = await getApplicationInfo({ node, nodeInfo, teamDid });
  if (!currentUser) {
    currentUser = {
      did: userDid,
      pk: userPk,
    };
    if (isEmailUniqueRequired(blocklet)) {
      const used = await node.isEmailUsed({
        teamDid,
        email: oauthInfo.email,
        verified: isEmailKycRequired(blocklet),
        sourceProvider: oauthInfo.provider,
      });
      if (used) {
        throw new CustomError(400, t('emailUniqueRequired', locale));
      }
    }

    const avatar = oauthInfo.picture
      ? await userUtil.getAvatarBnByUrl(oauthInfo.picture, { req, node })
      : await userUtil.getAvatarBnByEmail(oauthInfo.email, { req, node });
    profile = {
      email: oauthInfo.email,
      fullName: oauthInfo.name,
      avatar: getUserAvatarUrl(baseUrl, avatar),
    };
    if (isSameEmail(profile.email, oauthInfo.email) && isOAuthEmailVerified(blocklet, oauthInfo)) {
      profile.emailVerified = true;
    }
  }

  const statusEndpointBaseUrl = joinURL(baseUrl, WELLKNOWN_SERVICE_PATH_PREFIX);
  const endpoint = baseUrl;

  const { passport, response, role, inviteInfo, user } = await handleInvitationReceive({
    node,
    req,
    endpoint,
    inviteId,
    nodeInfo,
    profile: profile || {
      email: currentUser.email,
      fullName: currentUser.fullName,
      avatar: getUserAvatarUrl(baseUrl, currentUser.avatar),
    },
    statusEndpointBaseUrl,
    teamDid,
    userDid: userWallet.address,
    userPk: userWallet.publicKey,
    locale,
    provider,
  });

  if (currentUser) {
    const walletDid = getWalletDid(currentUser);
    if (walletDid) {
      // 如果已经绑定了 wallet 账户，则将 passport 发送给 wallet 账户
      await sendToUser(
        walletDid,
        {
          title: 'Invitation accepted',
          body: `You accept an invitation to be a ${role} of ${applicationName}`,
          attachments: [
            {
              type: 'vc',
              data: {
                credential: response.data,
                tag: role,
              },
            },
          ],
        },
        { req }
      );
    }
  }
  const connectedAccount = {
    provider,
    id: oauthInfo.sub,
    did: userWallet.address,
    pk: userWallet.publicKey,
    userInfo: oauthInfo,
  };

  if (profile) {
    profile.inviter = inviteInfo.inviter?.did;
  }

  const { sessionToken, refreshToken, visitorId } = await userUtil.loginUserSession(
    {
      did: currentUser.did,
      pk: currentUser.pk,
      profile,
      passport,
      sourceAppPid,
      connectedAccount,
      provider,
    },
    { req, node, options, loggedUser: user }
  );

  // for backward compatibility
  if (!getDidConnectVersion(req)) {
    return sessionToken;
  }

  return {
    sessionToken,
    refreshToken,
    visitorId,
  };
}

// 给 DID Wallet 绑定 Auth0 的流程
// eslint-disable-next-line no-unused-vars
async function bind(req, node, options) {
  const { locale = 'en', provider, sourceAppPid } = req.body;
  const blocklet = await req.getBlocklet();
  const { did: teamDid, appUrl } = await req.getBlockletInfo();
  const userDid = req.user.did;

  const { info: oauthInfo, wallet: userWallet } = await getOAuthFederatedUserInfo(req, { blocklet, locale });
  let oauthUser = await node.getUser({
    teamDid,
    user: { did: userWallet.address },
    options: {
      enableConnectedAccount: true,
    },
  });
  if (oauthUser) {
    throw new CustomError(
      409,
      JSON.stringify({
        code: 'ALREADY_EXIST',
        message: t('alreadyExist', locale, { email: oauthInfo.email, did: oauthUser.did }),
        data: pick(oauthUser, ['did', 'fullName', 'avatar']),
      })
    );
  }

  // NOTICE: 这里获得的 did 是当前登录用户的永久 did，无需再去查询 connectedAccount
  const bindUser = await node.getUser({ teamDid, user: { did: userDid } });

  const connectAccounts = getConnectedAccounts(bindUser);

  const account = connectAccounts.find((x) => x.provider === provider);

  if (account) {
    throw new CustomError(
      409,
      JSON.stringify({
        code: 'ALREADY_BIND',
        message: t('alreadyBindProvider', locale, { provider }),
        data: pick(bindUser, ['did', 'fullName', 'avatar']),
      })
    );
  }

  const mergePassport = (oauthUser?.passports || []).reduce((sum, cur) => {
    return upsertToPassports(sum, cur);
  }, bindUser.passports || []);

  let { avatar } = bindUser;
  if (!avatar) {
    const nodeInfo = await req.getNodeInfo();
    const { dataDir } = await getApplicationInfo({ node, nodeInfo, teamDid });
    avatar = oauthInfo.picture ? await getAvatarByUrl(oauthInfo.picture) : await getAvatarByEmail(oauthInfo.email);
    avatar = await extractUserAvatar(avatar, { dataDir });
  }

  const mergeProfile = {
    fullName: bindUser.fullName || oauthInfo.name,
    email: bindUser.email || oauthInfo.email,
    avatar,
  };

  if (isSameEmail(mergeProfile.email, oauthInfo.email) && isOAuthEmailVerified(blocklet, oauthInfo)) {
    mergeProfile.emailVerified = true;
  }

  const currentTime = new Date().toISOString();

  const connectedAccount = {
    provider,
    id: oauthInfo.sub,
    did: userWallet.address,
    pk: userWallet.publicKey,
    firstLoginAt: currentTime,
    lastLoginAt: currentTime,
    userInfo: oauthInfo,
  };

  await node.updateUser({
    teamDid,
    user: {
      did: bindUser.did,
      pk: bindUser.pk,
      ...mergeProfile,
      passports: mergePassport,
      connectedAccounts: [connectedAccount],
    },
  });

  const masterSite = federatedUtil.getFederatedMaster(blocklet);
  if (federatedUtil.shouldSyncFederated(blocklet, sourceAppPid)) {
    // NOTICE: 采用异步来更新，不阻塞接口的正常响应
    const syncUserData = {
      did: bindUser.did,
      pk: bindUser.pk,
      ...mergeProfile,
      connectedAccount: [connectedAccount],
    };
    if (syncUserData.avatar) {
      syncUserData.avatar = getUserAvatarUrl(appUrl, syncUserData.avatar);
    }
    node.syncFederated({
      did: teamDid,
      data: {
        users: [
          {
            ...syncUserData,
            action: 'connectAccount',
            sourceAppPid: sourceAppPid || masterSite?.appPid,
          },
        ],
      },
    });
  }

  if (!oauthUser) {
    oauthUser = {
      did: userWallet.address,
      pk: userWallet.publicKey,
    };
  }
  const nodeInfo = await req.getNodeInfo();
  await transferPassport(oauthUser, bindUser, { req, node, teamDid, nodeInfo, revokePassport: true });
  await node.createAuditLog(
    {
      action: 'connectAccount',
      args: { teamDid, connectedAccount, provider, userDid: bindUser.did },
      context: formatContext(Object.assign(req, { user: bindUser })),
      result: bindUser,
    },
    node
  );
}

async function unbind(req, node) {
  const { locale = 'en', connectedAccount, sourceAppPid } = req.body;

  const userDid = req.user.did;
  const blocklet = await req.getBlocklet();
  const { did: teamDid } = await req.getBlockletInfo();
  const bindUser = await node.getUser({ teamDid, user: { did: userDid } });
  if (connectedAccount.provider === LOGIN_PROVIDER.WALLET) {
    throw new Error(t('cantUnbindWalletAccount', locale));
  }
  if (getSourceProvider(bindUser) === connectedAccount.provider) {
    throw new Error(t('cantUnbindSourceProvider', locale));
  }
  if (
    !getConnectedAccounts(bindUser).some(
      (x) => x.provider === connectedAccount.provider && x.did === connectedAccount.did && x.pk === connectedAccount.pk
    )
  ) {
    throw new Error(t('accountNotExist', locale));
  }

  await node.disconnectUserAccount({
    teamDid,
    connectedAccount,
  });

  const masterSite = federatedUtil.getFederatedMaster(blocklet);
  if (federatedUtil.shouldSyncFederated(blocklet, sourceAppPid)) {
    // NOTICE: 采用异步来更新，不阻塞接口的正常响应
    const syncUserData = {
      did: bindUser.did,
      pk: bindUser.pk,
      disconnectedAccount: connectedAccount,
    };
    node.syncFederated({
      did: teamDid,
      data: {
        users: [
          {
            ...syncUserData,
            action: 'disconnectAccount',
            sourceAppPid: sourceAppPid || masterSite?.appPid,
          },
        ],
      },
    });
  }
}

module.exports = {
  checkUser,

  init(router, node, options) {
    const { createSessionToken } = initJwt(node, options);

    router.get(`${prefixApi}/configs`, async (req, res) => {
      const blocklet = await req.getBlocklet();
      const oauthConfig = pick(blocklet?.settings?.authentication || {}, OAUTH_PROVIDER_PUBLIC_FIELDS);
      res.send(oauthConfig);
    });

    router.get(`${prefixApi}/passports`, checkUser, createPassportList(node, 'service'));
    router.post(
      `${prefixApi}/switch`,
      checkUser,
      createPassportSwitcher(node, createTokenFn(createSessionToken), 'service')
    );

    router.post(`${prefixApi}/bind`, checkUser, async (req, res) => {
      try {
        await bind(req, node, options);
        res.status(200).json({});
      } catch (err) {
        logger.error('Failed bind oauth', { error: err });
        throw err;
      }
    });

    router.post(`${prefixApi}/unbind`, checkUser, async (req, res) => {
      try {
        await unbind(req, node, options);
        res.status(200).json({});
      } catch (err) {
        logger.error('Failed unbind oauth', { error: err });
        throw err;
      }
    });

    /**
     * oauth 方式登录
     * 1. 普通配置下，登录/注册是同样的流程，登录过程中会自动注册账号
     * 2. 仅邀请可登录模式下，只允许登录，不允许注册
     */
    router.post(`${prefixApi}/login`, async (req, res) => {
      const { action = 'login' } = req.body;
      const actionMap = {
        login,
        invite,
        'destroy-self': login,
      };
      if (!actionMap[action]) {
        logger.error('Failed to login oauth', { error: 'action not exist', action });
        throw new Error(`action not exist: ${action}`);
      }

      try {
        const blocklet = await req.getBlocklet();
        if (action === 'login' && req.body.provider === LOGIN_PROVIDER.GOOGLE && canUseDebosGoogleBroker(blocklet)) {
          const result = await exchangeDebosGoogleLoginGrant({
            req,
            node,
            createSessionToken,
            grantToken: req.body.code,
            visitorId: req.body.visitorId,
            locale: req.body.locale,
          });
          res.send(result);
          return;
        }

        const result = await actionMap[action](req, node, options);
        res.send(result);
      } catch (err) {
        logger.error('Failed login oauth', { error: err, action });
        throw err;
      }
    });

    router.post(`${prefixApi}/getUser`, async (req, res) => {
      const { provider, token, idToken, code, appPid, locale = 'en' } = req.body;
      const blocklet = await req.getBlocklet();
      const oauthInfo = await getOAuthUserInfo({ blocklet, provider, token, idToken, code, appPid });
      if (!oauthInfo?.sub) {
        res.status(400).send(t('failedToGetUserInfo', locale));
        return;
      }
      const { wallet: blockletWallet } = await req.getBlockletInfo();
      const userWallet = fromAppDid(oauthInfo.sub, blockletWallet.secretKey);

      res.json({
        info: oauthInfo,
        wallet: pick(userWallet, ['type', 'publicKey', 'address']),
      });
    });

    const checkReferrerMiddleware = () => {
      return async (req, res, next) => {
        const blocklet = await req.getBlocklet();
        const trustedDomains = await federatedUtil.getTrustedDomains({ node, req, blocklet });
        const referrer = req.get('referrer');
        let referrerHost;

        if (!referrer) {
          logger.error('Invalid referrer', { referrer });
          res.status(400).send('Invalid host'); // 这里故意返回 Invalid host 而不是 Invalid referrer，可以避免攻击者伪造 referrer 来绕过信任域名检查
          return;
        }

        try {
          referrerHost = new URL(referrer).hostname;
        } catch (err) {
          logger.error('Invalid referrer (failed to parse referrer)', { err });
          res.status(400).send('Invalid host'); // 这里故意返回 Invalid host 而不是 Invalid referrer，可以避免攻击者伪造 referrer 来绕过信任域名检查
          return;
        }

        if (!trustedDomains.includes(referrerHost)) {
          logger.error('Invalid referrer host', { referrerHost });
          res.status(400).send(`Invalid host: ${referrerHost}`);
          return;
        }
        next();
      };
    };

    router.get(`${prefix}/login/:provider`, checkReferrerMiddleware(), async (req, res) => {
      const { provider } = req.params;
      const blocklet = await req.getBlocklet();
      if (provider === LOGIN_PROVIDER.GOOGLE && canUseDebosGoogleBroker(blocklet)) {
        const referrer = req.get('referrer');
        const appDid = getDebosBlockletAppDid(blocklet);
        const authUrl = withQuery(joinURL(getDebosGoogleBrokerUrl(), '/oauth/debos-login/google'), {
          appDid,
          redirect: req.query.redirect || '/',
          locale: req.query.locale || 'en',
          oauthPopup: '1',
          oauthCallbackUrl: getDebosGoogleCallbackUrl(req),
          oauthState: new URL(referrer).origin,
        });
        redirectWithoutCache(res, authUrl);
        return;
      }

      const availableProviderList = Object.keys(blocklet.settings?.authentication).filter(
        (x) =>
          blocklet.settings?.authentication[x]?.enabled === true &&
          blocklet.settings?.authentication[x]?.type === 'oauth'
      );
      if (!availableProviderList.includes(provider)) {
        res.status(400).send(`Provider: ${provider} is not supported`);
        return;
      }
      const referrer = req.get('referrer');
      const client = getAuthClient(blocklet, provider);
      const authUrl = client.getAuthorizationUrl(new URL(referrer).origin);
      redirectWithoutCache(res, authUrl);
    });

    // HACK: apple 需要特殊处理，callback 使用的是 post 请求返回的，通过特殊处理转为 get 请求，转由前端继续处理
    // 此处改为所有 provider 都兼容的模式
    router.post(`${prefix}/callback/:provider`, (req, res) => {
      /**
       * @type {{code?: string, user?: {name: {firstName: string, lastName: string}, email: string}}}
       */
      const { code, user, state } = req.body;
      // HACK: URL 构造函数必须传入一个域名
      const redirectUrl = new URL(req.url, 'http://127.0.0.1');
      if (code) {
        redirectUrl.searchParams.set('code', code);
        redirectUrl.searchParams.set('state', state);
        if (user) {
          // FIXME: apple 的用户名信息只会在首次获取 code 时出现，该如何将这个值传递给另一个接口中？
          // 即使如此处理，也无法完全解决后续无法获取到用户名的问题。如果一个已有的 oauth 配置配置到了另一个应用中，对于 apple 来说，该用户已经不是第一次登录了，就不会返回用户名信息
          // redirectUrl.searchParams.set('name', `${user.name.firstName} ${user.name.lastName}`);
        }
      } else {
        const error = 'true';
        const errorDescription = 'invalid code';
        redirectUrl.searchParams.set('error', error);
        redirectUrl.searchParams.set('error_description', errorDescription);
      }
      redirectWithoutCache(res, `${redirectUrl.pathname}${redirectUrl.search}`);
    });
  },
};
