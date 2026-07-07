const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { joinURL } = require('ufo');
const dayjs = require('@abtnode/util/lib/dayjs');
const pick = require('lodash/pick');
const uniq = require('lodash/uniq');
const trim = require('lodash/trim');
const merge = require('lodash/merge');
const si = require('systeminformation');
const isEmpty = require('lodash/isEmpty');
const {
  getUserAvatarUrl,
  extractUserAvatar,
  getAvatarFile,
  getAvatarByUrl,
  getAppAvatarUrl,
} = require('@abtnode/util/lib/user');
const { CustomError } = require('@blocklet/error');
const { createLaunchBlockletHandler, createServerlessInstallGuard } = require('@abtnode/auth/lib/server');
const { getDisplayName } = require('@blocklet/meta/lib/util');
const { fromAppDid } = require('@arcblock/did-ext');
const { fromRandom } = require('@ocap/wallet');
const { getBlockletInfo } = require('@blocklet/meta/lib/info');
const { getBlockletLogos } = require('@abtnode/util/lib/blocklet');
const { PASSPORT_SOURCE, PASSPORT_LOG_ACTION, PASSPORT_ISSUE_ACTION } = require('@abtnode/constant');

const { getLauncherUser, getLauncherSession: getLauncherSessionRaw, doRequest } = require('@abtnode/auth/lib/launcher');
const { createAuthToken, getPassportStatusEndpoint, messages } = require('@abtnode/auth/lib/auth');
const { createPassportVC, createPassport, createUserPassport } = require('@abtnode/auth/lib/passport');

const { LOGIN_PROVIDER, fromBlockletStatus } = require('@blocklet/constant');
const {
  WELLKNOWN_SERVICE_PATH_PREFIX,
  NODE_DATA_DIR_NAME,
  USER_AVATAR_URL_PREFIX,
  ROLES,
  DEBOS_BLOCKLET_DID,
  LAUNCH_SESSION_STATUS,
  SERVERLESS_BLOCKLET_DATA_RETENTION_DAYS,
} = require('@abtnode/constant');

const logger = require('@abtnode/logger')('@abtnode/core:util:launcher');

const { getNFTState } = require('./index');
const { getBlockletURLForLauncher } = require('./blocklet');
const states = require('../states');
const { version } = require('../../package.json');

const consumeServerlessNFT = async ({ nftId, blocklet }) => {
  try {
    const state = await getNFTState(blocklet.controller.chainHost, nftId);
    if (!state) {
      throw new Error(`Get nft state failed, chainHost: ${blocklet.controller.chainHost}, nftId: ${nftId}`);
    }

    const nodeInfo = await states.node.read();
    const appURL = await getBlockletURLForLauncher({ blocklet, nodeInfo });
    logger.info('Consuming serverless nft params', { appURL, nftId });

    const { launcherUrl } = state.data.value;
    const result = await doRequest(nodeInfo.sk, {
      launcherUrl,
      pathname: '/api/serverless/consume',
      payload: { nftId, appURL },
      method: 'post',
    });

    logger.info('Consume serverless nft success', { nftId, hash: result.hash });
  } catch (error) {
    logger.error('Consume serverless nft failed', { nftId, error });
    throw new Error(`consume nft ${nftId} failed`);
  }
};

const reportComponentsEvent = async ({ blocklet, dids, type, time }) => {
  const { controller } = blocklet;
  const componentDids = uniq(dids);

  const payload = {
    componentDids,
    type,
    time,
  };

  try {
    const info = await states.node.read();

    const result = await doRequest(info.sk, {
      launcherUrl: controller.launcherUrl,
      pathname: `/api/launches/${controller.launcherSessionId}/events`,
      payload,
      method: 'post',
    });

    logger.info(`reported components event ${type}`, {
      controller,
      blockletPid: blocklet.appPid,
      componentDids,
      type,
      result,
    });
  } catch (error) {
    logger.error('report components event failed', { controller, blockletPid: blocklet.appPid, componentDids, type });
    throw new Error(`report components event failed of blocklet ${blocklet.appPid}`);
  }
};

const notifyLauncher = async (type, blocklet) => {
  try {
    const { controller } = blocklet;

    if (!controller) {
      return;
    }

    logger.info('notify blocklet updated', { controller, blockletPid: blocklet.appPid });

    const info = await states.node.read();

    const blockletInfo = getBlockletInfo(blocklet, info.sk);
    const { appLogo, appLogoRect } = getBlockletLogos(blocklet);

    const payload = {
      type,
      payload: {
        did: blocklet.appDid,
        appId: blocklet.appDid,
        appName: blockletInfo.name,
        appDescription: blockletInfo.description,
        status: fromBlockletStatus(blocklet.status),
        appUrl: blockletInfo.url,
        appLogo,
        appLogoRect,
      },
    };

    logger.info('notify blocklet updated payload', { controller, blockletPid: blocklet.appPid, payload });

    const result = await doRequest(info.sk, {
      launcherUrl: controller.launcherUrl,
      pathname: `/api/launches/${controller.launcherSessionId}/webhook`,
      payload,
      method: 'post',
    });

    logger.info('notified blocklet updated', {
      controller,
      blockletPid: blocklet.appPid,
      result,
    });
  } catch (error) {
    logger.error('notify blocklet updated failed', { blockletPid: blocklet?.appPid, error });
  }
};

const notifyBlockletUpdated = (blocklet) => notifyLauncher('serverless.blocklet.updated', blocklet);
const notifyBlockletStarted = (blocklet) => notifyLauncher('serverless.blocklet.started', blocklet);
const notifyBlockletStopped = (blocklet) => notifyLauncher('serverless.blocklet.stopped', blocklet);

const getCpuUtilization = async () => {
  const load = await si.currentLoad();
  const u = Number(load?.currentLoad);

  return Math.max(0, Math.min(1, u / 100));
};

const getComponentsAggregate = async () => {
  try {
    // Use efficient SQL GROUP BY COUNT instead of loading all children into memory
    // This is O(1) memory vs O(n) for the old implementation
    const { total, counts: statusCounts } = await states.blockletChild.getStatusCounts();

    // Convert numeric status keys to string keys using fromBlockletStatus
    const counts = {};
    for (const [status, count] of Object.entries(statusCounts)) {
      const key = fromBlockletStatus(Number(status)) || 'unknown';
      counts[key] = (counts[key] || 0) + count;
    }

    return { total, counts };
  } catch (error) {
    logger.error('getComponentsAggregate failed', { error });
    return { total: 0, counts: {} };
  }
};

const sendServerlessHeartbeat = async () => {
  logger.info('send serverless heartbeat');
  const nodeInfo = await states.node.read();
  const launcherUrl = nodeInfo?.registerUrl;
  if (!launcherUrl) {
    logger.error('skip heartbeat: launcher url not configured', {
      launcher: nodeInfo?.launcher,
    });
    return null;
  }

  const { did } = nodeInfo;
  const cpuCores = os.cpus().length;
  const [mem, cpuUtilization, components] = await Promise.all([
    si.mem(),
    getCpuUtilization(),
    getComponentsAggregate(),
  ]);

  const memoryAvailableMb = mem.available / 1024 / 1024;
  const memoryTotalMb = mem.total / 1024 / 1024;

  const payload = {
    name: nodeInfo.name,
    description: nodeInfo.description,
    version,
    did,
    cpuUtilization,
    memoryAvailableMb,
    memoryTotalMb,
    cpuCores,
    components,
  };

  logger.debug('send serverless heartbeat payload', { did, launcherUrl, payload });

  try {
    const result = await doRequest(nodeInfo.sk, {
      launcherUrl,
      pathname: '/api/serverless/heartbeat',
      payload,
      method: 'post',
    });
    logger.info('sent heartbeat to launcher', { did, launcherUrl, result });
    return result;
  } catch (error) {
    logger.error('send heartbeat failed', { error: error.message, did, launcherUrl });
    return null;
  }
};

const consumeLauncherSession = async ({ params, blocklet }) => {
  try {
    const info = await states.node.read();
    const { name } = getBlockletInfo(blocklet, info.sk);
    const appUrl = getBlockletURLForLauncher({ blocklet, nodeInfo: info });

    let componentDids = blocklet.children.map((x) => x.meta.did);
    componentDids = uniq(componentDids);

    const result = await doRequest(info.sk, {
      launcherUrl: params.launcherUrl,
      pathname: `/api/launches/${params.launcherSessionId}/installed`,
      payload: {
        appDid: blocklet.appPid,
        appUrl,
        appName: name,
        installedAt: blocklet.installedAt,
        ownerDid: params.ownerDid,
        componentDids,
      },
      method: 'post',
    });

    logger.info('Consume launcher session success', { params, result });
  } catch (error) {
    logger.error('Consume launcher session failed', { params, error });
    throw new Error(`Consume launcher session ${params.launcherSessionId} failed`);
  }
};

/**
 *
 * @param {object} param
 * @param {object} param.node node instance
 * @param {string} param.sessionId blocklet setup session id
 * @param {boolean} param.justCreate just create owner, not set owner
 * @param {boolean} param.autoStart auto initialize the blocklet, skip setup process
 * @param {string} [param.provider=LOGIN_PROVIDER.WALLET] provider
 * @param {object} param.context context
 * @param {string} param.context.visitorId visitorId
 * @param {string} param.context.ua ua
 * @param {string} param.context.lastLoginIp lastLoginIp
 * @param {string} param.context.walletOS walletOS
 * @param {object} param.context.device device
 * @param {string} param.context.device.messageToken deviceMessageToken
 * @param {string} param.context.device.id deviceId
 * @param {string} param.context.device.clientName deviceClientName
 * @returns
 */
const setupAppOwner = async ({
  node,
  sessionId,
  justCreate = false,
  autoStart = false,
  context,
  provider = LOGIN_PROVIDER.WALLET,
}) => {
  const session = await node.getSession({ id: sessionId });
  if (!session) {
    throw new Error(`Blocklet setup session not found in server: ${sessionId}`);
  }

  const {
    appDid,
    userDid,
    ownerDid,
    ownerPk,
    lastLoginIp,
    context: sessionContext,
    locale,
    launcherUrl,
    launcherSessionId,
  } = session;
  const [info, blocklet] = await Promise.all([states.node.read(), node.getBlocklet({ did: appDid })]);
  if (!blocklet) {
    throw new Error(`Blocklet not found in server: ${appDid}`);
  }

  // 安装后 blocklet.environments 可能不会立即有值，可以从 node.getBlockletEnvironments 获取
  if (isEmpty(blocklet.environments)) {
    const { all } = await node.getBlockletEnvironments(appDid);
    blocklet.environments = all;
  }

  const { wallet, secret } = getBlockletInfo(blocklet, info.sk);
  const appUrl = blocklet.environments.find((x) => x.key === 'BLOCKLET_APP_URL').value;
  const dataDir = blocklet.environments.find((x) => x.key === 'BLOCKLET_DATA_DIR').value;
  const serverDataDir = path.join(node.dataDirs.data, NODE_DATA_DIR_NAME);

  let user;
  let appOwnerProfile;
  // get user from launcher or server
  if (launcherUrl && launcherSessionId) {
    user = await getLauncherUser(info.sk, { launcherUrl, launcherSessionId });
    if (!user) {
      throw new Error(`Owner user not found from launcher: ${launcherUrl}`);
    }
    appOwnerProfile = pick(user, ['fullName', 'email', 'avatar', 'phone']);
    const avatarBase64 = await getAvatarByUrl(joinURL(launcherUrl, user.avatar));
    appOwnerProfile.avatar = await extractUserAvatar(avatarBase64, { dataDir });
    logger.info('Create owner from launcher for blocklet', { appDid, ownerDid, ownerPk, sessionId, appOwnerProfile });
  } else {
    user = await node.getUser({ teamDid: info.did, user: { did: userDid }, options: { enableConnectedAccount: true } });
    if (!user) {
      throw new Error(`Owner user not found in server: ${userDid}`);
    }
    appOwnerProfile = pick(user, ['fullName', 'email', 'avatar', 'phone']);
    if (user.avatar && user.avatar.startsWith(USER_AVATAR_URL_PREFIX)) {
      const filename = user.avatar.split('/').pop();
      const srcFile = getAvatarFile(serverDataDir, filename);
      const destFile = getAvatarFile(dataDir, filename);
      fs.mkdirpSync(path.dirname(destFile));
      fs.copyFileSync(srcFile, destFile);
    } else {
      appOwnerProfile.avatar = await extractUserAvatar(user.avatar, { dataDir });
    }
    logger.info('Create owner from session for blocklet', { appDid, ownerDid, ownerPk, sessionId, appOwnerProfile });
  }

  // create and send owner passport
  const role = ROLES.OWNER;
  const vc = await createPassportVC({
    issuerName: getDisplayName(blocklet),
    issuerWallet: wallet,
    issuerAvatarUrl: getAppAvatarUrl(appUrl),
    ownerDid,
    ...(await createPassport({
      name: role,
      node,
      teamDid: appDid,
      locale,
      endpoint: appUrl,
    })),
    endpoint: getPassportStatusEndpoint({
      baseUrl: joinURL(appUrl, WELLKNOWN_SERVICE_PATH_PREFIX),
      userDid: ownerDid,
      teamDid: appDid,
    }),
    ownerProfile: { ...appOwnerProfile, avatar: getUserAvatarUrl(appUrl, appOwnerProfile.avatar) },
    preferredColor: 'default',
    expirationDate: undefined,
  });

  // create app owner passport
  const passport = createUserPassport(vc, { role, source: PASSPORT_SOURCE.ISSUE });

  // add app owner to database, app owner can't federated account, so it can't have sourceAppPid field
  const doc = await node.loginUser({
    teamDid: appDid,
    user: {
      ...appOwnerProfile,
      did: ownerDid,
      pk: ownerPk,
      passport,
      locale,
      lastLoginIp,
      connectedAccount: {
        provider,
        did: ownerDid,
        pk: ownerPk,
        id:
          provider === LOGIN_PROVIDER.WALLET ? ownerDid : user.connectedAccount?.id || `email|${appOwnerProfile.email}`,
      },
    },
  });
  await node.createAuditLog(
    {
      action: 'addUser',
      args: { teamDid: appDid, userDid: ownerDid, reason: 'launch blocklet' },
      context: { ...sessionContext, user: doc },
      result: doc,
    },
    node
  );

  if (passport) {
    await node.createPassportLog(appDid, {
      passportId: passport.id,
      action: PASSPORT_LOG_ACTION.ISSUE,
      operatorIp: context?.lastLoginIp,
      operatorUa: context?.ua,
      operatorDid: context?.userDid,
      metadata: {
        action: PASSPORT_ISSUE_ACTION.ISSUE_ON_SETUP_APP_OWNER,
        userDid: context?.userDid,
        appDid,
      },
    });
  }

  // create owner login token that can be used to login on blocklet site
  const setupToken = createAuthToken({
    did: ownerDid,
    passport,
    role,
    fullName: appOwnerProfile?.fullName,
    provider,
    secret,
    expiresIn: '1d',
    elevated: true,
  });

  if (justCreate || autoStart) {
    logger.info('Create owner for blocklet: setBlockletInitialized', { appDid, ownerDid, sessionId });
    await node.setBlockletInitialized({ did: appDid, owner: { did: ownerDid, pk: ownerPk } });
  } else {
    logger.info('Create owner for blocklet: setBlockletOwner', { appDid, ownerDid, sessionId });
    await node.setBlockletOwner({ did: appDid, owner: { did: ownerDid, pk: ownerPk } });
  }

  const userSession = await node
    .upsertUserSession({
      teamDid: appDid,
      userDid: ownerDid,
      appPid: appDid,
      status: 'online',
      // visitorId: context?.visitorId, // NOTICE: @2025-05-06 初始化新应用时，使用新的 visitorId
      ua: context?.ua, // NOTICE: @2024-12-01 webapp 暂不做 userSession 纠正 ua 的处理，因为 webapp 中不涉及 userSession 管理
      lastLoginIp: context?.lastLoginIp,
      extra: {
        walletOS: context?.walletOS,
        device: {
          id: context?.device?.id || context?.walletDeviceId,
          messageToken: context?.device?.messageToken || context?.walletDeviceMessageToken,
          clientName: context?.device?.clientName,
        },
      },
      locale,
      origin: context?.origin,
    })
    .catch((error) => {
      logger.error('upsertUserSession failed', { error, appDid, ownerDid, context });
    });

  logger.info('created user session', { appDid, ownerDid, userSession });

  return {
    session,
    blocklet,
    setupToken,
    passport: vc,
    visitorId: userSession?.visitorId,
  };
};

const getLauncherSession = async ({ launcherUrl, launcherSessionId, external = true }, context) => {
  const info = await states.node.read();
  const result = await getLauncherSessionRaw(info.sk, {
    launcherUrl,
    launcherSessionId,
    locale: context?.query?.locale,
  });

  // strip sensitive data if call from external
  if (external && result.launcherSession) {
    result.launcherSession = pick(result.launcherSession, [
      '_id',
      'status',
      'statusText',
      'subscription',
      'expirationDate',
      'terminatedAt',
      'reservedUntil',
      'userDid',
      'walletDid',
      'metadata',
    ]);
  }

  return result;
};

// Check local first, then remote, FIXME: should we check on chain nft?
const isLauncherSessionConsumed = async (params) => {
  let consumed = await states.blockletExtras.isLauncherSessionConsumed(params.launcherSessionId);
  logger.info('Launcher session consumed at local?', { params, consumed });
  if (consumed) {
    return true;
  }

  const { error, launcherSession } = await getLauncherSession(params);
  if (error) {
    throw new Error(error);
  }
  if (!launcherSession) {
    throw new Error('Launcher session not found');
  }

  consumed = launcherSession.status > 40;
  logger.info('Launcher session consumed at remote?', { params, consumed });
  return consumed;
};

const getLaunchSessionStatus = async (blockletDid, controller) => {
  logger.info('checking blocklet status', { blockletDid, controller });

  const { launcherSessionId } = controller;
  // 新版都通过 Launcher 判断过期状态
  const { error, launcherSession } = await getLauncherSession({
    launcherSessionId,
    launcherUrl: controller.launcherUrl || 'https://launcher.arcblock.io/',
  });

  if (error) {
    logger.error('get launcher session failed', { error, blockletDid, controller });
    throw new Error(error);
  }

  logger.info('get launcher session success', { blockletDid, launcherSessionId, launcherSession });
  return launcherSession.status;
};

const isBlockletProtected = (blockletDid) => {
  if (!process.env.ABT_NODE_DATA_DIR) {
    return false;
  }

  const configFile = path.join(process.env.ABT_NODE_DATA_DIR, '.protected-serverless-apps');
  if (fs.existsSync(configFile)) {
    const protectedAppIds = fs.readFileSync(configFile, 'utf8').split(os.EOL).map(trim).filter(Boolean);
    return protectedAppIds.includes(blockletDid);
  }

  return false;
};

const isBlockletExpired = async (blockletDid, controller) => {
  if (isBlockletProtected(blockletDid)) {
    logger.info('skip expire protected serverless app', { blockletDid, controller });
    return false;
  }
  const status = await getLaunchSessionStatus(blockletDid, controller);
  return [LAUNCH_SESSION_STATUS.overdue, LAUNCH_SESSION_STATUS.canceled, LAUNCH_SESSION_STATUS.terminated].includes(
    status
  );
};

const isLaunchSessionTerminated = (session) => session.status === LAUNCH_SESSION_STATUS.terminated;

const isBlockletTerminated = async (blockletDid, controller) => {
  if (isBlockletProtected(blockletDid)) {
    logger.info('skip terminate protected serverless app', { blockletDid, controller });
    return false;
  }
  const status = await getLaunchSessionStatus(blockletDid, controller);
  return status === LAUNCH_SESSION_STATUS.terminated;
};

const isDataRetentionExceeded = (launcherSession) => {
  if (!launcherSession) {
    return false;
  }

  if (!launcherSession.terminatedAt) {
    return false;
  }

  const { terminatedAt } = launcherSession;
  const exceeded =
    !!terminatedAt && dayjs().diff(dayjs(terminatedAt), 'days') > SERVERLESS_BLOCKLET_DATA_RETENTION_DAYS;

  if (!exceeded) {
    logger.info('blocklet data retention not exceeded, check terminateImmediately', { launcherSession });

    return launcherSession.metadata.terminateImmediately === true;
  }

  return exceeded;
};

const launchBlockletByLauncher = async (node, extraParams, context) => {
  logger.debug('launchBlockletByLauncher', { extraParams, context });
  const checker = createServerlessInstallGuard(node, true);

  extraParams.locale = context.locale || 'en';

  const blocklet = await checker({ extraParams });

  // generate app key pair
  const type = (blocklet.meta.environments || []).find((x) => x.name === 'CHAIN_TYPE')?.default || 'default';
  const appWallet = fromRandom(type);

  // generate owner key pair
  const info = await states.node.read();
  const user = await getLauncherUser(info.sk, extraParams);

  const userWallet = fromAppDid(`email|${user.email}`, appWallet.secretKey);

  let data = {};

  if (extraParams.bindDomainCap && extraParams.domainNftDid) {
    context.bindDomainCap = JSON.parse(extraParams.bindDomainCap);
    context.domainNftDid = extraParams.domainNftDid;

    logger.info('bind domain cap', { bindDomainCap: extraParams.bindCap, domainNftDid: extraParams.domainNftDid });
  }

  const handler = createLaunchBlockletHandler(node, 'launcher');
  await handler(
    {
      extraParams,
      userDid: userWallet.address,
      claims: [
        {
          type: 'keyPair',
          secret: appWallet.secretKey,
          userDid: userWallet.address,
          userPk: userWallet.publicKey,
        },
      ],
      didwallet: {
        os: 'managed',
        version,
      },
      updateSession: (updates) => {
        data = merge(data, updates);
      },
      provider: LOGIN_PROVIDER.EMAIL,
    },
    context
  );

  return data;
};

const launchBlockletWithoutWallet = async (node, extraParams, context) => {
  logger.info('launchBlockletWithoutWallet start', { extraParams });

  extraParams.locale = context.locale || 'en';

  const { blockletMetaUrl, title, description, locale } = extraParams;

  if (!blockletMetaUrl && !title && !description) {
    logger.error('blockletMetaUrl | title + description must be provided');
    throw new CustomError(400, messages.missingBlockletUrl[locale]);
  }

  const blocklet = blockletMetaUrl
    ? await node.getBlockletMetaFromUrl({ url: blockletMetaUrl, checkPrice: true })
    : {
        meta: {
          title,
          description,
        },
      };
  logger.info('launchBlockletWithoutWallet meta fetched', { blocklet });

  if (!blocklet) {
    throw new Error('Blocklet not found');
  }

  if (context?.user?.role === ROLES.GUEST && blocklet?.meta?.did !== DEBOS_BLOCKLET_DID) {
    throw new CustomError(403, 'Guest launch sessions can only launch DeBOS');
  }

  // generate app key pair
  const type = (blocklet?.meta?.environments || []).find((x) => x.name === 'CHAIN_TYPE')?.default || 'default';
  const appWallet = fromRandom(type);

  // use the server user to set up the app owner, this account only allows using the passkey to login
  const { user } = context;
  const provider =
    user.sourceProvider || user.provider || user.connectedAccounts?.[0]?.provider || LOGIN_PROVIDER.EMAIL;

  let data = {};

  const handler = createLaunchBlockletHandler(node, 'session');
  await handler(
    {
      extraParams,
      userDid: user.did,
      claims: [
        {
          type: 'keyPair',
          secret: appWallet.secretKey,
          userDid: user.did,
          userPk: user.pk,
        },
      ],
      didwallet: {
        os: 'managed',
        version,
      },
      updateSession: (updates) => {
        data = merge(data, updates);
      },
      provider,
    },
    context
  );

  return data;
};

module.exports = {
  consumeServerlessNFT,
  consumeLauncherSession,
  reportComponentsEvent,
  setupAppOwner,
  getLauncherSession,
  isDataRetentionExceeded,
  isLaunchSessionTerminated,
  isLauncherSessionConsumed,
  isBlockletExpired,
  isBlockletTerminated,
  notifyBlockletUpdated,
  notifyBlockletStarted,
  notifyBlockletStopped,
  launchBlockletByLauncher,
  launchBlockletWithoutWallet,
  sendServerlessHeartbeat,
};
