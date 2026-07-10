const get = require('lodash/get');
const pick = require('lodash/pick');
const isEmpty = require('lodash/isEmpty');
const last = require('lodash/last');
const uniq = require('lodash/uniq');
const sortBy = require('lodash/sortBy');
const pRetry = require('p-retry');
const { isNFTExpired, isNFTConsumed } = require('@abtnode/util/lib/nft');
const axios = require('@abtnode/util/lib/axios');
const { CustomError } = require('@blocklet/error');
const { joinURL, withHttps } = require('ufo');
const { types } = require('@ocap/mcrypto');
const { toHex, fromBase64 } = require('@ocap/util');
const { DidType, isEthereumType } = require('@arcblock/did');
const { getApplicationWallet } = require('@blocklet/meta/lib/wallet');
const { getBlockletChainInfo, isInProgress, isRunning } = require('@blocklet/meta/lib/util');
const { getChainClient } = require('@abtnode/util/lib/get-chain-client');

const { getBlockletInfo } = require('@blocklet/meta/lib/info');
const { getBlockletAppIdList } = require('@blocklet/meta/lib/util');
const formatContext = require('@abtnode/util/lib/format-context');
const { isInServerlessMode } = require('@abtnode/util/lib/serverless');
const getRequestIP = require('@abtnode/util/lib/get-request-ip');
const { convertToMoniker } = require('@abtnode/util/lib/transfer-to-moniker');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
const { getDidDomainForBlocklet } = require('@abtnode/util/lib/get-domain-for-blocklet');
const { getUserAvatarUrl, getAppAvatarUrl } = require('@abtnode/util/lib/user');
const {
  ROLES,
  VC_TYPE_GENERAL_PASSPORT,
  VC_TYPE_NODE_PASSPORT,
  NFT_TYPE_SERVER_OWNERSHIP,
  SERVER_ROLES,
  NFT_TYPE_SERVERLESS,
  MAIN_CHAIN_ENDPOINT,
  APP_STRUCT_VERSION,
  PASSPORT_STATUS,
  MFA_PROTECTED_METHODS,
  WELLKNOWN_SERVICE_PATH_PREFIX,
  PASSPORT_SOURCE,
  PASSPORT_LOG_ACTION,
  PASSPORT_ISSUE_ACTION,
  DEBOS_BLOCKLET_DID,
} = require('@abtnode/constant');
const parseBooleanString = require('@abtnode/util/lib/parse-boolean-string');
const { getDeviceData } = require('@abtnode/util/lib/device');
const getOrigin = require('@abtnode/util/lib/get-origin');

const {
  messages,
  getVCFromClaims,
  getUser,
  validatePassportStatus,
  createAuthToken,
  createAuthTokenByOwnershipNFT,
  createBlockletControllerAuthToken,
  checkWalletVersion,
  checkWalletVersionForMigrateAppToV2,
  verifyNFT,
  getPassportStatusEndpoint,
  getApplicationInfo,
} = require('./auth');
const {
  validatePassport,
  isUserPassportRevoked,
  getRoleFromLocalPassport,
  getRoleFromExternalPassport,
  createUserPassport,
  getPassportClaimUrl,
  createPassportVC,
  createPassport,
  upsertToPassports,
} = require('./passport');
const { getLauncherSession } = require('./launcher');
const { reserveDebosLaunch, updateLaunchRecord } = require('./debos-launch-guard');
const logger = require('./logger');

const LAUNCH_BLOCKLET_TOKEN_EXPIRE = '1d';
// External token should expire after 20 min
// Assuming the blocklet installation will take no more than 20 min
const EXTERNAL_LAUNCH_BLOCKLET_TOKEN_EXPIRE = '20m';

const BLOCKLET_SERVER_VC_TYPES = [VC_TYPE_GENERAL_PASSPORT, VC_TYPE_NODE_PASSPORT];

const ensureLauncherIssuer = (issuers, nodeInfo) => {
  const launcherDid = get(nodeInfo, 'launcher.did');
  if (launcherDid) {
    issuers.push(launcherDid);
  }
};

const getTrustedIssuers = (nodeInfo) => {
  const trustedPassports = (nodeInfo.trustedPassports || []).map((x) => x.issuerDid);
  return [nodeInfo.did, ...trustedPassports].filter(Boolean);
};

const getLauncherAppIdList = async (url) => {
  try {
    const urlObj = new URL('__blocklet__.js?type=json', url);

    const delay = process.env.NODE_ENV === 'test' ? 500 : 5000;

    const func = async () => {
      const { data } = await axios.get(urlObj.href, { timeout: delay });
      const result = [data.appId, data.appPid];
      if (Array.isArray(data.alsoKnownAs)) {
        result.push(...data.alsoKnownAs);
      }

      return uniq(result.map((s) => s.trim()).filter(Boolean));
    };

    const result = await pRetry(func, {
      retries: 3,
      minTimeout: delay,
      maxTimeout: delay,
      onFailedAttempt: (error) => {
        logger.error(`attempt get launcher blocklet meta ${urlObj.href} failed.`, { error });
      },
    });

    logger.info('launcher app id list:', { result, launcher: url });

    return result;
  } catch (error) {
    logger.error(`get launcher blocklet meta ${url} failed.`, { error });
    throw new CustomError(500, `get launcher blocklet meta ${url} failed: ${error.message}`);
  }
};

const getBlockletKnownDids = async ({ teamDid, blocklet, node }) => {
  try {
    let blockletInfo = blocklet;
    if (!blockletInfo) {
      blockletInfo = await node.getBlocklet({ did: teamDid, useCache: true });
    }
    return getBlockletAppIdList(blockletInfo);
  } catch (error) {
    return [teamDid];
  }
};

const getKnownIssuerDids = async ({ issuerDid }) => {
  try {
    // FIXME: @liushuang 多次迁移后，did 可能是第一次的 did，存在查询不到 blocklet 信息的情况，通过 domain 间接查询
    const domain = getDidDomainForBlocklet({ did: issuerDid });
    const { data } = await axios.get(joinURL(withHttps(domain), '__blocklet__.js?type=json'), {
      timeout: 10 * 1000,
    });
    const { appId, appPid, alsoKnownAs = [] } = data;
    const alsoKnownAsDids = [appId, appPid, ...alsoKnownAs];
    return [...new Set(alsoKnownAsDids.filter(Boolean))];
  } catch (error) {
    return [issuerDid];
  }
};

const authenticateByVc = async ({
  node,
  locale,
  teamDid,
  userDid,
  claims,
  challenge,
  requireNodeInitialized = true,
  launchBlocklet,
  blocklet,
  // eslint-disable-next-line no-shadow
  types = BLOCKLET_SERVER_VC_TYPES,
  trustedIssuers = [],
}) => {
  if (requireNodeInitialized) {
    if ((await node.isInitialized()) === false) {
      throw new CustomError(403, messages.notInitialized[locale]);
    }
  }

  const info = await node.getNodeInfo();
  const { name } = info;
  if (!teamDid) {
    // eslint-disable-next-line no-param-reassign
    teamDid = info.did;
  }

  if (trustedIssuers.length === 0) {
    // eslint-disable-next-line no-param-reassign
    trustedIssuers = getTrustedIssuers(info);
  }

  if (launchBlocklet) {
    ensureLauncherIssuer(trustedIssuers, info);
  }

  const { vc, types: passportTypes } = await getVCFromClaims({
    claims,
    challenge,
    trustedIssuers,
    types,
    locale,
    vcId: blocklet?.controller?.vcId,
  });

  if (!vc) {
    throw new CustomError(400, messages.missingPassport[locale]);
  }

  // check user approved
  const user = await getUser(node, teamDid, userDid, { enableConnectedAccount: true });
  if (!user) {
    throw new CustomError(404, messages.userNotFound[locale]);
  }
  if (!user.approved) {
    throw new CustomError(403, messages.notAllowedAppUser[locale]);
  }

  // Get user passport from vc
  let passport = createUserPassport(vc, { source: PASSPORT_SOURCE.ISSUE });
  if (user && isUserPassportRevoked(user, passport)) {
    throw new CustomError(403, messages.passportRevoked[locale](passport.title, name));
  }

  // Get role from vc
  let role;
  if (passportTypes.some((x) => [VC_TYPE_GENERAL_PASSPORT].includes(x))) {
    await validatePassport(get(vc, 'credentialSubject.passport'));
    const issuerId = get(vc, 'issuer.id');

    // 需要考虑到 Blocklet 迁移的情况
    const knownTeamDids = await getBlockletKnownDids({ teamDid, blocklet, node });
    const knownIssuerDids =
      trustedIssuers.length > 0 ? trustedIssuers : await getKnownIssuerDids({ issuerDid: issuerId });

    // 如果 issuerId 存在于 blocklet 的 alsoKnownAs 中认为是相同的 blocklet
    if (knownTeamDids.includes(issuerId)) {
      role = getRoleFromLocalPassport(get(vc, 'credentialSubject.passport'));
    } else {
      // map external passport to local role
      const trustedPassports =
        blocklet?.trustedPassports?.length > 0 ? blocklet?.trustedPassports : info.trustedPassports || [];
      const { mappings = [] } = trustedPassports.find((x) => knownIssuerDids.includes(x.issuerDid)) || {};
      role = await getRoleFromExternalPassport({
        passport: get(vc, 'credentialSubject.passport'),
        node,
        teamDid: issuerId,
        locale,
        mappings,
      });

      // check status of external passport if passport has an endpoint
      const endpoint = get(vc, 'credentialStatus.id');
      if (endpoint) {
        await validatePassportStatus({ vcId: vc.id, endpoint, locale });
      }
    }
  } else if (passportTypes.includes(NFT_TYPE_SERVER_OWNERSHIP)) {
    role = ROLES.OWNER;
  } else {
    logger.error('cannot get role from passport, use "guest" for default', { passportTypes, vcId: vc.id });
    role = ROLES.GUEST;
  }

  // Recreate passport with correct role
  passport = createUserPassport(vc, { role, source: PASSPORT_SOURCE.ISSUE });

  return { role, user, teamDid, passport, info };
};

const authenticateByNFT = async ({ node, claims, userDid, challenge, locale, isAuth, chainHost }) => {
  const info = await node.getNodeInfo();

  // serverless 应用通过 querystring 传递 chainHost
  const state = await verifyNFT({ claims, challenge, chainHost: chainHost || info.launcher.chainHost, locale });

  // 本地开发模式下，不校验 nft issuer, Launcher 会使用该字段
  if (info.launcher?.mode !== 'development') {
    const trustedLaunchers = await getLauncherAppIdList(get(info, 'launcher.url'));
    if (!trustedLaunchers.includes(state.issuer)) {
      throw new CustomError(400, messages.invalidNftIssuer[locale]);
    }
  }

  if (state.tags.includes(NFT_TYPE_SERVERLESS)) {
    state.data.value = JSON.parse(state.data.value);

    if (!isAuth && isNFTExpired(state)) {
      throw new CustomError(403, messages.nftAlreadyExpired[locale]);
    }

    return {
      role: SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER,
      nft: state,
      extra: {
        controller: {
          nftId: state.address,
          nftOwner: state.owner,
          chainHost,
        },
      },
      user: {
        did: userDid,
      },
      teamDid: info.did,
    };
  }

  // enforce tag match
  if (last(state.tags) !== info.launcher.tag) {
    throw new CustomError(400, messages.tagNotMatch[locale]);
  }

  const user = await getUser(node, info.did, userDid, { enableConnectedAccount: true });
  return {
    role: ROLES.OWNER,
    teamDid: info.did,
    nft: state,
    user,
    passport: null,
    ownerDid: state.owner,
    ownerNFT: state.address,
  };
};

const authenticateByLauncher = async ({ node, claims, launcherSessionId, launcherUrl, chainHost }) => {
  const info = await node.getNodeInfo();
  const { error, launcherSession } = await getLauncherSession(info.sk, { launcherSessionId, launcherUrl });
  if (error) {
    throw new CustomError(400, error);
  }

  const claim = claims.find((x) => x.type === 'keyPair');
  return {
    role: SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER,
    teamDid: info.did,
    user: {
      did: claim.userDid,
      pk: claim.userPk,
    },
    extra: {
      controller: {
        nftId: launcherSession.nftDid,
        nftOwner: launcherSession.userDid,
        chainHost,
        launcherUrl,
        launcherSessionId,
        ownerDid: claim.userDid,
      },
    },
  };
};

const authenticateBySession = async ({ node, userDid, locale, allowedRoles = ['owner', 'admin', 'member'] }) => {
  const info = await node.getNodeInfo();
  const user = await getUser(node, info.did, userDid, { enableConnectedAccount: true });
  if (!user) {
    throw new CustomError(404, messages.userNotFound[locale]);
  }
  const passport = (user.passports || []).find((x) => x.status === 'valid' && allowedRoles.includes(x.role));
  return { role: passport ? passport.role : ROLES.GUEST, teamDid: info.did, user, passport: null };
};

const getAuthVcClaim =
  ({ node, launchBlocklet, blocklet, options, source = 'blocklet' }) =>
  async ({ extraParams: { locale, passportId }, context: { didwallet, baseUrl } }) => {
    checkWalletVersion({ didwallet, locale });

    const baseClaim = {
      description: messages.requestPassport[locale],
      optional: false,
      item: BLOCKLET_SERVER_VC_TYPES,
    };

    if (blocklet && blocklet?.controller?.vcId) {
      return {
        ...baseClaim,
        target: blocklet.controller.vcId,
      };
    }

    if (passportId) {
      return {
        ...baseClaim,
        target: passportId,
      };
    }

    const info = await node.getNodeInfo();
    const trustedIssuers = getTrustedIssuers(info);

    if (launchBlocklet) {
      ensureLauncherIssuer(trustedIssuers, info);
    }

    return {
      ...baseClaim,
      trustedIssuers,
      ...(options || {}),
      claimUrl: getPassportClaimUrl(
        baseUrl,
        source === 'server' && process.env.NODE_ENV === 'production' ? info.routing.adminPath : ''
      ),
    };
  };

const getAuthPrincipalForMigrateAppToV2 = (node) => async (param) => {
  const {
    extraParams: { locale, appDid },
    context: { didwallet },
  } = param;

  checkWalletVersionForMigrateAppToV2({
    didwallet,
    local: locale,
  });

  if (!appDid) {
    throw new CustomError(400, 'appDid is required in extraParams');
  }

  const blocklet = await node.getBlocklet({ did: appDid });
  if (!blocklet) {
    throw new CustomError(404, messages.invalidBlocklet[locale]);
  }

  const info = await node.getNodeInfo();
  const { wallet } = getBlockletInfo(blocklet, info.sk);
  const type = DidType(wallet.type);

  // get chain info
  let chainInfo = getBlockletChainInfo(blocklet);
  if (isEthereumType(type)) {
    chainInfo.type = 'ethereum';
    chainInfo.id = '1';
  }
  if (chainInfo.host === 'none') {
    chainInfo = { host: MAIN_CHAIN_ENDPOINT, id: 'main', type: 'arcblock' };
  }

  return {
    description: 'Please continue with your account',
    chainInfo,
  };
};

const getAuthPrincipalForTransferAppOwnerShip = getAuthPrincipalForMigrateAppToV2;

const getKeyPairClaim =
  (node, opts = {}) =>
  async ({ extraParams: { locale, appDid, wt = 'default', title }, context: { didwallet } }) => {
    checkWalletVersion({ didwallet, locale });

    const { declare = true } = opts;

    const description = {
      en: 'Please generate a new key-pair for this application',
      zh: '请为应用创建新的钥匙对',
    };

    let appName = title || opts.title;
    let migrateFrom = '';

    let type;
    let chainInfo;

    // We are rotating a key-pair for existing application
    if (appDid) {
      const blocklet = await node.getBlocklet({ did: appDid });
      if (!blocklet) {
        throw new CustomError(404, messages.invalidBlocklet[locale]);
      }

      const info = await node.getNodeInfo();
      const { name, wallet } = getBlockletInfo(blocklet, info.sk);
      appName = name;
      migrateFrom = wallet.address;
      type = DidType(wallet.type);
      chainInfo = getBlockletChainInfo(blocklet);

      const isMigrateFromManaged = isEmpty(blocklet.migratedFrom) && blocklet.externalSkSource?.startsWith('managed');
      migrateFrom = isMigrateFromManaged ? '' : blocklet.appDid;
    } else {
      type = DidType(wt);
      type.role = types.RoleType.ROLE_APPLICATION;
      chainInfo = getBlockletChainInfo();
    }

    const typeStr = DidType.toJSON(type);
    if (isEthereumType(type)) {
      chainInfo.type = 'ethereum';
      chainInfo.id = '1';
    }

    let moniker = convertToMoniker(appName);
    if (!/^[a-zA-Z0-9][-a-zA-Z0-9_]{2,128}$/.test(moniker)) {
      moniker = appDid ? [appDid.slice(0, 6), appDid.slice(-5)].join('-') : `app-${Date.now().toString(36)}`;
    }

    const result = {
      mfa: !process.env.DID_CONNECT_MFA_DISABLED,
      description: description[locale] || description.en,
      moniker,
      declare: !!declare,
      migrateFrom: declare ? migrateFrom : '',
      chainInfo,
      targetType: {
        role: typeStr.role?.split('_').pop()?.toLowerCase(),
        key: typeStr.pk?.toLowerCase(),
        hash: typeStr.hash?.toLowerCase(),
        encoding: typeStr.address?.toLowerCase(),
      },
    };

    return result;
  };

const getRotateKeyPairClaims = (node) => {
  return [
    {
      authPrincipal: async ({ extraParams: { locale, appDid } }) => {
        const description = {
          en: 'Please create a new key-pair for this application',
          zh: '请为应用创建新的钥匙对',
        };

        let chainInfo = { host: 'none', id: 'none', type: 'arcblock' };

        if (!appDid) {
          throw new CustomError(400, messages.missingBlockletDid[locale]);
        }

        const blocklet = await node.getBlocklet({ did: appDid });
        if (!blocklet) {
          throw new CustomError(404, messages.invalidBlocklet[locale]);
        }

        if (isInProgress(blocklet.status)) {
          throw new CustomError(400, 'Blocklet is in progress, please wait for it to finish');
        }

        if (blocklet.structVersion !== APP_STRUCT_VERSION) {
          throw new CustomError(400, messages.invalidAppVersion[locale]);
        }

        // Try to use blocklet chain config if possible
        // Since migration happens on the chain the app holds some actual assets
        // We must ensure it happens on that chain
        chainInfo = getBlockletChainInfo(blocklet);

        // Fallback to main chain, since it is the default registry for all DID
        if (chainInfo.host === 'none') {
          chainInfo = { host: MAIN_CHAIN_ENDPOINT, id: 'main', type: 'arcblock' };
        }

        const isMigrateFromManaged = isEmpty(blocklet.migratedFrom) && blocklet.externalSkSource?.startsWith('managed');

        return {
          chainInfo,
          description: description[locale] || description.en,
          target: isMigrateFromManaged ? '' : blocklet.appDid,
        };
      },
    },
    {
      keyPair: getKeyPairClaim(node),
    },
  ];
};

const getAppDidOwnerClaims = () => {
  const description = {
    en: 'Sign following message to prove that you are the owner of the app',
    zh: '签名如下消息以证明你是应用的拥有者',
  };

  return [
    {
      authPrincipal: async ({ context, extraParams: { locale } }) => {
        const blocklet = await context.request.getBlocklet();
        return {
          description: description[locale] || description.en,
          target: blocklet.appDid,
        };
      },
    },
    {
      signature: async ({ context, extraParams: { locale } }) => {
        const blocklet = await context.request.getBlocklet();
        return {
          description: messages.receivePassport[locale],
          data: `I am the owner of app ${blocklet.appDid}`,
          type: 'mime:text/plain',
        };
      },
    },
  ];
};

const getOwnershipNFTClaim = async (node, locale) => {
  const info = await node.getNodeInfo();
  if (!info.ownerNft || !info.ownerNft.issuer) {
    throw new CustomError(400, messages.noNft[locale]);
  }

  const launcherDid = get(info, 'launcher.did', '');
  const nftDid = get(info, 'launcher.nftDid', '');
  const chainHost = get(info, 'launcher.chainHost', '');
  if (!launcherDid) {
    throw new CustomError(400, messages.noLauncherDid[locale]);
  }

  if (!nftDid) {
    throw new CustomError(400, messages.noNftDid[locale]);
  }

  if (!chainHost) {
    throw new CustomError(400, messages.noChainHost[locale]);
  }

  return {
    description: messages.requestBlockletSpaceNFT[locale],
    trustedIssuers: [launcherDid],
    address: nftDid,
  };
};

const getServerlessNFTClaim = (nftId, locale) => {
  return {
    description: messages.requestBlockletSpaceNFT[locale],
    address: nftId,
  };
};

const getAuthNFTClaim =
  ({ node }) =>
  ({ extraParams: { locale, launchType, nftId }, context: { didwallet } }) => {
    checkWalletVersion({ didwallet, locale });
    if (launchType === 'serverless') {
      if (!nftId) {
        throw new CustomError(400, messages.blockletSpaceNftIdRequired[locale]);
      }

      return getServerlessNFTClaim(nftId, locale);
    }

    return getOwnershipNFTClaim(node, locale);
  };

const getLaunchBlockletClaims = (node, authMethod) => {
  const claims = {
    blockletAppKeypair: ['keyPair', getKeyPairClaim(node)],
  };

  if (authMethod === 'vc') {
    claims.serverPassport = ['verifiableCredential', getAuthVcClaim({ node, launchBlocklet: true })];
  }

  if (authMethod === 'nft') {
    claims.serverNFT = ['asset', getAuthNFTClaim({ node })];
  }

  return claims;
};

const canApprovedUserLaunchBlocklet = ({ authMethod, user, blocklet }) =>
  authMethod === 'session' && user?.approved === true && blocklet?.meta?.did === DEBOS_BLOCKLET_DID;

const ensureBlockletPermission = async ({
  authMethod,
  node,
  userDid,
  claims,
  challenge,
  locale,
  chainHost,
  isAuth = false,
  blocklet = null,
  allowedRoles = ['owner', 'admin', 'member'],
  launcherUrl = '',
  launcherSessionId = '',
}) => {
  let result;
  if (authMethod === 'vc') {
    result = await authenticateByVc({
      node,
      userDid,
      claims,
      challenge,
      requireNodeInitialized: false,
      locale,
      launchBlocklet: true,
      blocklet,
    });
  } else if (authMethod === 'nft') {
    result = await authenticateByNFT({
      node,
      locale,
      userDid,
      claims,
      challenge,
      isAuth,
      chainHost,
    });
  } else if (authMethod === 'launcher') {
    result = await authenticateByLauncher({
      node,
      claims,
      launcherUrl,
      launcherSessionId,
      chainHost,
    });
  } else {
    result = await authenticateBySession({
      node,
      userDid,
      locale,
      allowedRoles,
    });
  }

  const { teamDid, role } = result;
  const permissions = await node.getPermissionsByRole({ teamDid, role: { name: role } });
  const hasPermission = permissions.some((item) => ['mutate_blocklets'].includes(item.name));
  if (!hasPermission && !canApprovedUserLaunchBlocklet({ authMethod, user: result.user, blocklet })) {
    throw new CustomError(403, messages.notAuthorized[locale]);
  }

  return result;
};

const createLaunchBlockletHandler =
  (node, authMethod) =>
  async (
    {
      claims,
      userDid,
      updateSession,
      didwallet,
      extraParams,
      challenge = '',
      provider = LOGIN_PROVIDER.WALLET,
      req = null,
    },
    context = null
  ) => {
    const {
      locale,
      blockletMetaUrl,
      title,
      description,
      chainHost,
      launcherSessionId,
      launcherUrl,
      onlyRequired,
      autoStart,
    } = parseBooleanString(extraParams, ['onlyRequired', 'autoStart']);
    logger.info('createLaunchBlockletHandler', extraParams);

    const claim = claims.find((x) => x.type === 'keyPair');
    if (!claim) {
      logger.error('keyPair claim must be provided');
      throw new CustomError(400, messages.missingKeyPair[locale]);
    }

    if (!blockletMetaUrl && !title && !description) {
      logger.error('blockletMetaUrl | title + description must be provided');
      throw new CustomError(400, messages.missingBlockletUrl[locale]);
    }

    if (authMethod === 'nft' && !chainHost) {
      logger.error('chainHost must be provided');
      throw new CustomError(400, messages.missingChainHost[locale]);
    }

    if (authMethod === 'launcher' && !(launcherSessionId && launcherUrl)) {
      logger.error('launcherUrl and launcherSessionId must be provided');
      throw new CustomError(400, messages.missingLauncherSession[locale]);
    }

    let blocklet;
    let blockletWalletType;
    if (blockletMetaUrl) {
      blocklet = await node.getBlockletMetaFromUrl({ url: blockletMetaUrl, checkPrice: true });
      if (!blocklet.meta) {
        throw new CustomError(400, messages.invalidBlocklet[locale]);
      }

      if (!blocklet.isFree) {
        if (isEmpty(extraParams?.previousWorkflowData?.downloadTokenList)) {
          logger.error('downloadTokenList must be provided');
          throw new CustomError(400, messages.invalidParams[locale]);
        }
      }

      const blockletWalletTypeEnv = (blocklet.meta.environments || []).find((x) => x.name === 'CHAIN_TYPE');
      if (blockletWalletTypeEnv) {
        blockletWalletType = blockletWalletTypeEnv.default;
      }
    }

    const { role, passport, user, extra, nft } = await ensureBlockletPermission({
      authMethod,
      node,
      userDid,
      claims,
      challenge,
      locale,
      chainHost,
      blocklet,
      launcherSessionId,
      launcherUrl,
    });

    let controller;
    let sessionToken = '';
    const secret = await node.getSessionSecret();
    if (authMethod === 'vc') {
      sessionToken = createAuthToken({
        did: userDid,
        passport,
        role,
        fullName: user?.fullName,
        secret,
        expiresIn: LAUNCH_BLOCKLET_TOKEN_EXPIRE,
      });
    } else if (role === SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER) {
      // launch with serverless nft or launcher session
      controller = extra.controller;
      sessionToken = createBlockletControllerAuthToken({
        did: userDid,
        role,
        fullName: user?.fullName,
        controller,
        secret,
        expiresIn: EXTERNAL_LAUNCH_BLOCKLET_TOKEN_EXPIRE,
      });
    } else if (authMethod === 'nft') {
      // launch with server nft
      sessionToken = createAuthTokenByOwnershipNFT({
        did: userDid,
        role,
        fullName: user?.fullName,
        secret,
        expiresIn: LAUNCH_BLOCKLET_TOKEN_EXPIRE,
      });
    }

    if (sessionToken) {
      await updateSession({ sessionToken }, true);
    }

    const appSk = toHex(claim.secret);
    const wallet = getApplicationWallet(appSk, undefined, blockletWalletType);
    const appDid = wallet.address;
    const launchGuardRecord = await reserveDebosLaunch({
      node,
      blocklet,
      appDid,
      role,
      provider,
      userDid,
      user,
      req,
      context,
    });
    const { id: sessionId } = await node.startSession({
      data: {
        appDid,
        userDid,
        ownerDid: claim.userDid,
        ownerPk: claim.userPk,
        lastLoginIp: context?.ip || getRequestIP(req),
        context: context || formatContext(req),
        locale,
        launcherSessionId,
        launcherUrl,
      },
    });

    await updateSession({ appDid, sessionId });
    if (launchGuardRecord) {
      await updateLaunchRecord({ node, launchId: launchGuardRecord.id, sessionId, appDid });
    }

    if (blocklet) {
      // 检查是否已安装，这里不做升级的处理
      const existedBlocklet = await node.getBlocklet({ did: appDid });
      if (existedBlocklet) {
        if (launchGuardRecord) {
          await updateLaunchRecord({ node, launchId: launchGuardRecord.id, sessionId, appDid, status: 'installed' });
        }
        await updateSession({ isInstalled: true });
        logger.info('blocklet already exists', { appDid });
        return null;
      }

      // 如果是 serverless, 并且已经消费过了，但是没有安装，则抛出异常
      if (role === SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER) {
        if (authMethod === 'nft' && isNFTConsumed(nft)) {
          throw new CustomError(403, messages.nftAlreadyConsumed[locale]);
        }
        if (authMethod === 'launcher' && (await node.isLauncherSessionConsumed({ launcherUrl, launcherSessionId }))) {
          throw new CustomError(403, messages.sessionAlreadyConsumed[locale]);
        }
      }
    }

    logger.info('start install blocklet', { blockletMetaUrl, title, description, controller });
    let boundSource = {};
    if (extraParams.type) {
      boundSource = {
        type: extraParams.type,
        did: blocklet?.meta?.did,
        storeUrl: extraParams.storeUrl,
      };
    }
    try {
      await node.installBlocklet(
        {
          ...boundSource,
          url: blockletMetaUrl,
          title,
          description,
          appSk,
          skSource: didwallet?.version ? `${didwallet.os}-wallet-v${didwallet.version}` : '',
          downloadTokenList: extraParams?.previousWorkflowData?.downloadTokenList,
          controller: role === SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER ? controller : null,
          onlyRequired,
        },
        context || formatContext(Object.assign(req, { user: { ...pick(user, ['did', 'fullName']), role } }))
      );

      const deviceData = getDeviceData({ req });

      const result = await node.setupAppOwner({
        node,
        sessionId,
        justCreate: !blockletMetaUrl,
        autoStart,
        provider,
        context: {
          visitorId: extraParams.visitorId,
          ua: context?.ua || req?.get('user-agent'),
          lastLoginIp: context?.ip || getRequestIP(req),
          walletOS: didwallet?.os,
          userDid,
          device: context ? deviceData : null,
          origin: await getOrigin({ req }),
        },
      });
      await updateSession({ setupToken: result.setupToken, visitorId: result.visitorId });
      if (launchGuardRecord) {
        await updateLaunchRecord({ node, launchId: launchGuardRecord.id, sessionId, appDid, status: 'installed' });
      }

      return {
        disposition: 'attachment',
        type: 'VerifiableCredential',
        data: result.passport,
        visitorId: result.visitorId,
      };
    } catch (error) {
      if (launchGuardRecord) {
        await updateLaunchRecord({
          node,
          launchId: launchGuardRecord.id,
          sessionId,
          appDid,
          status: 'failed',
          reason: error.message,
        });
      }
      throw error;
    }
  };

const getBlockletPermissionChecker =
  (node, allowedRoles = ['owner', 'admin', 'member']) =>
  async ({ userDid, extraParams }) => {
    const { locale = 'en' } = extraParams;

    const info = await node.getNodeInfo();
    const user = await getUser(node, info.did, userDid, { enableConnectedAccount: true });
    if (!user) {
      throw new CustomError(404, messages.userNotFound[locale]);
    }
    if (!user.approved) {
      throw new CustomError(403, messages.notAllowedAppUser[locale]);
    }

    const passport = (user.passports || []).find((x) => x.status === 'valid' && allowedRoles.includes(x.role));
    let allowedBlocklet;
    if (!passport && extraParams.blockletMetaUrl) {
      try {
        allowedBlocklet = await node.getBlockletMetaFromUrl({ url: extraParams.blockletMetaUrl, checkPrice: true });
      } catch (error) {
        logger.warn('failed to fetch blocklet metadata for launch permission check', {
          blockletMetaUrl: extraParams.blockletMetaUrl,
          error,
        });
      }
    }

    if (!passport && !canApprovedUserLaunchBlocklet({ authMethod: 'session', user, blocklet: allowedBlocklet })) {
      throw new CustomError(
        403,
        {
          en: 'You do not have permission to install blocklets on this server',
          zh: '你无权在此节点上安装应用',
        }[locale]
      );
    }
  };

const migrateAppDid = async (node, appDid) => {
  const blocklet = await node.getBlocklet({ did: appDid });
  const { wallet, permanentWallet } = getBlockletInfo(blocklet);

  const info = getBlockletChainInfo(blocklet);
  const client = getChainClient(info.host === 'none' ? MAIN_CHAIN_ENDPOINT : info.host);

  const { state: exist } = await client.getAccountState({ address: wallet.address });
  if (exist) {
    logger.info('appDid migration skipped', { did: wallet.address });
    return '';
  }

  const hash = await client.sendAccountMigrateTx({
    tx: {
      itx: {
        address: wallet.address,
        pk: wallet.publicKey,
      },
    },
    wallet: permanentWallet,
  });
  logger.info('appDid migration done', { from: wallet.address, to: permanentWallet.address, hash });

  return hash;
};

const createRotateKeyPairHandler =
  (node) =>
  async ({ claims, userDid, userPk, req, extraParams }) => {
    const { locale, appDid } = extraParams;
    logger.info('createRotateKeyPairHandler', extraParams);

    const claim = claims.find((x) => x.type === 'keyPair');
    if (!claim) {
      logger.error('keyPair claim must be provided');
      throw new CustomError(400, messages.missingKeyPair[locale]);
    }

    if (!appDid) {
      logger.error('appDid must be provided');
      throw new CustomError(400, messages.missingBlockletDid[locale]);
    }

    const blocklet = await node.getBlocklet({ did: appDid });
    if (!blocklet) {
      throw new CustomError(400, messages.invalidBlocklet[locale]);
    }

    // Only the blocklet owner(identified by appDid) can rotate key pair
    const isMigrateFromManaged = isEmpty(blocklet.migratedFrom) && blocklet.externalSkSource?.startsWith('managed');
    if (!isMigrateFromManaged && blocklet.appDid !== userDid) {
      throw new CustomError(
        403,
        {
          zh: `只有 应用DID 所有者（${blocklet.appDid}）可以修改钥匙对. 当前用户：${userDid}`,
          en: `Only the owner of AppDID (${blocklet.appDid}) can rotate key pair. Current User: ${userDid}`,
        }[locale]
      );
    }

    const context = formatContext(Object.assign(req, { user: { did: userDid, fullName: 'Owner', role: 'owner' } }));

    await node.configBlocklet(
      {
        did: blocklet.meta.did,
        configs: [{ key: 'BLOCKLET_APP_SK', value: toHex(claim.secret), secure: true }],
        skipHook: true,
      },
      context
    );

    if (isMigrateFromManaged) {
      // migrate appDid on chain
      await migrateAppDid(node, blocklet.appDid);

      // bind owner wallet to owner account
      const owner = await node.getOwner({ teamDid: appDid });
      const isConnected = owner.connectedAccounts.some((x) => x.did === userDid);
      if (owner.did !== userDid && !isConnected) {
        const connectedAccount = {
          provider: LOGIN_PROVIDER.WALLET,
          did: userDid,
          pk: userPk,
          lastLoginAt: new Date().toISOString(),
          firstLoginAt: new Date().toISOString(),
          userInfo: {
            wallet: userDid,
          },
        };

        const user = await node.updateUser({
          teamDid: appDid,
          user: {
            did: owner.did,
            pk: owner.pk,
            lastLoginIp: getRequestIP(req),
            connectedAccounts: [connectedAccount],
          },
        });

        logger.info('bind owner wallet to owner account', {
          did: owner.did,
          pk: owner.pk,
          connectedAccount,
        });

        // create vc
        const {
          wallet,
          passportColor,
          appUrl,
          name: issuerName,
        } = await getApplicationInfo({ teamDid: appDid, nodeInfo: await node.getNodeInfo(), node });
        const result = await createPassport({ name: ROLES.OWNER, node, teamDid: appDid, locale });
        const vc = await createPassportVC({
          issuerName,
          issuerWallet: wallet,
          issuerAvatarUrl: getAppAvatarUrl(appUrl),
          ownerDid: userDid,
          endpoint: getPassportStatusEndpoint({
            baseUrl: joinURL(appUrl, WELLKNOWN_SERVICE_PATH_PREFIX),
            userDid: user.did,
            teamDid: appDid,
          }),
          ownerProfile: {
            ...user,
            avatar: getUserAvatarUrl(appUrl, user.avatar),
          },
          preferredColor: passportColor,
          passport: result.passport,
          types: result.types,
        });
        const passport = createUserPassport(vc, {
          role: ROLES.OWNER,
          display: null,
          source: PASSPORT_SOURCE.ISSUE,
        });
        user.passports = upsertToPassports(user.passports || [], passport);
        await node.updateUser({
          teamDid: appDid,
          user: {
            did: user.did,
            pk: user.pk,
            passports: user.passports,
          },
        });

        if (passport) {
          await node.createPassportLog(
            appDid,
            {
              passportId: passport.id,
              action: PASSPORT_LOG_ACTION.ISSUE,
              operatorDid: userDid,
              metadata: {
                action: PASSPORT_ISSUE_ACTION.ISSUE_ON_ROTATE_KEY_PAIR,
                ownerDid: userDid,
                userDid: user.did,
              },
            },
            req
          );
        }

        node.sendPassportVcNotification({ userDid, appWallet: wallet, locale, vc });
        logger.info('send owner passport to owner wallet', {
          did: owner.did,
          pk: owner.pk,
          passport,
        });
      }
    }

    if (isRunning(blocklet.status)) {
      node
        .stopBlocklet({ did: appDid, updateStatus: false }, context)
        .then(() => {
          return node.startBlocklet({
            did: blocklet.meta.did,
            checkHealthImmediately: true,
            throwOnError: true,
            atomic: true,
          });
        })
        .then((doc) => {
          logger.info('restart blocklet success after rotate key pair', { appDid });
          return node.createAuditLog(
            {
              action: 'restartBlocklet',
              args: { did: appDid },
              context,
              result: doc,
            },
            node
          );
        })
        .catch((err) => {
          logger.error('failed to restart blocklet after rotate key pair', { appDid, error: err });
        });
    }
  };

const handleRestoreByLauncherSession = async ({ node, userDid, updateSession, extraParams }) => {
  const { chainHost, locale, launcherUrl, launcherSessionId } = extraParams;
  if (await node.isLauncherSessionConsumed({ launcherUrl, launcherSessionId })) {
    throw new CustomError(403, messages.sessionAlreadyConsumed[locale]);
  }

  const { launcherSession } = await node.getLauncherSession({ launcherUrl, launcherSessionId, external: false });
  const controller = {
    nftId: launcherSession.nftDid,
    nftOwner: launcherSession.userDid,
    chainHost,
    launcherUrl,
    launcherSessionId,
    ownerDid: userDid, // FIXME: is this incorrect
  };

  const secret = await node.getSessionSecret();
  const sessionToken = createBlockletControllerAuthToken({
    did: userDid,
    role: SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER,
    controller,
    secret,
    expiresIn: EXTERNAL_LAUNCH_BLOCKLET_TOKEN_EXPIRE,
  });

  await updateSession({ sessionToken }, true);

  return controller;
};

const createRestoreByNftHandler =
  (node, authMethod) =>
  async ({ claims, challenge, userDid, updateSession, extraParams }) => {
    const { chainHost, locale, launcherUrl, launcherSessionId } = extraParams;
    const { role, extra } = await ensureBlockletPermission({
      authMethod,
      node,
      userDid,
      claims,
      challenge,
      locale,
      chainHost,
      launcherUrl,
      launcherSessionId,
    });

    let sessionToken = '';
    const secret = await node.getSessionSecret();

    if (role === SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER) {
      sessionToken = createBlockletControllerAuthToken({
        did: userDid,
        role,
        controller: extra.controller,
        secret,
        expiresIn: EXTERNAL_LAUNCH_BLOCKLET_TOKEN_EXPIRE,
      });
    } else {
      sessionToken = createAuthTokenByOwnershipNFT({
        did: userDid,
        role,
        secret,
        expiresIn: LAUNCH_BLOCKLET_TOKEN_EXPIRE,
      });
    }

    await updateSession({ sessionToken }, true);

    if (role === SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER) {
      return {
        nextWorkflowData: {
          controller: extra.controller,
        },
      };
    }

    return null;
  };

const createServerlessInstallGuard = (node, force = false) => {
  return async ({ extraParams }) => {
    const { locale, blockletMetaUrl, launcherUrl, launcherSessionId } = extraParams;
    const [info, blocklet] = await Promise.all([
      node.getNodeInfo(),
      blockletMetaUrl ? node.getBlockletMetaFromUrl({ url: blockletMetaUrl, checkPrice: true }) : null,
    ]);

    if (force) {
      if (!isInServerlessMode(info)) {
        throw new CustomError(403, messages.notSupported[locale]);
      }
      if (!blocklet) {
        throw new CustomError(400, messages.missingBlockletUrl[locale]);
      }
    }

    // check if serverless is supported
    if (blocklet && isInServerlessMode(info)) {
      const isServerlessSupported = get(blocklet.meta, 'capabilities.serverless', true);
      if (!isServerlessSupported) {
        throw new CustomError(403, messages.notSupported[locale]);
      }
    }

    // check if launcher session consumed
    // 只在 launch serverless 时校验 launch session 的合法性
    if (launcherUrl && launcherSessionId && isInServerlessMode(info)) {
      if (await node.isLauncherSessionConsumed({ launcherUrl, launcherSessionId })) {
        throw new CustomError(403, messages.sessionAlreadyConsumed[locale]);
      }
    }

    return blocklet;
  };
};

const getVerifyAccessClaims = ({
  node,
  passports,
  roles = ['owner', 'admin'],
  // eslint-disable-next-line no-shadow
  types = BLOCKLET_SERVER_VC_TYPES,
  source = 'server',
  trustedIssuers = [],
  optional = false,
  defaultClaims,
}) => {
  return async ({ extraParams: { locale }, context: { didwallet, baseUrl } }) => {
    checkWalletVersion({ didwallet, locale });

    // group passports by role
    const grouped = passports
      .filter((x) => x.status === PASSPORT_STATUS.VALID && x.scope === 'passport' && roles.includes(x.role))
      .reduce((acc, passport) => {
        if (!acc[passport.role]) {
          acc[passport.role] = [];
        }
        acc[passport.role].push(passport);
        return acc;
      }, {});

    // only get the latest 2 passports for each role
    const targets = Object.values(grouped)
      .map((items) => sortBy(items, 'issuanceDate').reverse().slice(0, 2))
      .flat();

    if (targets.length === 0) {
      if (defaultClaims) {
        return defaultClaims;
      }
      throw new Error(messages.passportNotFound[locale]);
    }

    const info = await node.getNodeInfo();
    return {
      description: messages.requestPassport[locale],
      claimUrl: getPassportClaimUrl(baseUrl, source === 'server' ? info.routing.adminPath : ''),
      optional,
      filters: targets.map((x) => ({
        type: types,
        target: x.id,
        trustedIssuers: trustedIssuers.length > 0 ? trustedIssuers : getTrustedIssuers(info),
      })),
    };
  };
};

const validateVerifyDestroyRequest = ({ payload, roles, locale, allowedRoles }) => {
  // ensure payload is valid
  const parsed = JSON.parse(fromBase64(payload).toString());
  if (!MFA_PROTECTED_METHODS.includes(parsed.action)) {
    throw new Error(messages.notRequiredVerifcation[locale]);
  }

  // ensure roles are valid
  const expected = roles
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (expected.some((x) => !allowedRoles.includes(x))) {
    throw new Error(messages.passportNotAllowedToUse({ passports: allowedRoles.join('/') })[locale]);
  }

  return expected;
};

module.exports = {
  getAuthVcClaim,
  getVerifyAccessClaims,
  validateVerifyDestroyRequest,
  getKeyPairClaim,
  authenticateByVc,
  authenticateByNFT,
  authenticateBySession,
  authenticateByLauncher,
  getRotateKeyPairClaims,
  getOwnershipNFTClaim,
  getLaunchBlockletClaims,
  createLaunchBlockletHandler,
  createRotateKeyPairHandler,
  createRestoreByNftHandler,
  ensureBlockletPermission,
  getBlockletPermissionChecker,
  getAppDidOwnerClaims,
  getTrustedIssuers,
  getAuthNFTClaim,
  getServerlessNFTClaim,
  getLauncherAppIdList,
  getAuthPrincipalForMigrateAppToV2,
  getAuthPrincipalForTransferAppOwnerShip,
  createServerlessInstallGuard,
  handleRestoreByLauncherSession,
  migrateAppDid,
};
