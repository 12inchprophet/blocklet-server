const formatContext = require('@abtnode/util/lib/format-context');
const getRequestIP = require('@abtnode/util/lib/get-request-ip');
const getOrigin = require('@abtnode/util/lib/get-origin');
const { getDeviceData } = require('@abtnode/util/lib/device');
const { getAccessWallet } = require('@abtnode/util/lib/blocklet');
const { consumeDebosGoogleLoginGrant } = require('@abtnode/auth/lib/debos-google-grant');
const { DEBOS_BLOCKLET_DID, ROLES, USER_SESSION_STATUS, WELLKNOWN_SERVICE_PATH_PREFIX } = require('@abtnode/constant');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
const { CustomError } = require('@blocklet/error');
const { sign } = require('@blocklet/sdk/lib/util/csrf');

const { createTokenFn, getDidConnectVersion } = require('../../util');
const logger = require('../../libs/logger')('auth');

const isDebosBlocklet = (blocklet) => {
  const dids = [
    blocklet?.did,
    blocklet?.appDid,
    blocklet?.appPid,
    blocklet?.meta?.did,
    blocklet?.environmentObj?.BLOCKLET_COMPONENT_DID,
    ...(blocklet?.componentMountPoints || []).map((item) => item.did),
    ...(blocklet?.children || []).map((item) => item?.meta?.did || item?.did),
  ].filter(Boolean);

  return dids.includes(DEBOS_BLOCKLET_DID);
};

const isOwnerUser = (user) => {
  if (!user || user.approved === false) {
    return false;
  }

  if (user.role === ROLES.OWNER || user.passport?.name === ROLES.OWNER || user.passport?.role === ROLES.OWNER) {
    return true;
  }

  return (user.passports || []).some((passport) => passport.name === ROLES.OWNER || passport.role === ROLES.OWNER);
};

const assertGoogleOwner = async ({ node, teamDid, userDid, googleSub }) => {
  const user = await node.getUser({
    teamDid,
    user: { did: userDid },
    options: { enableConnectedAccount: true },
  });

  if (!isOwnerUser(user)) {
    throw new CustomError(403, 'This Google account is not the owner of this DeBOS instance');
  }

  const connectedAccount = user.connectedAccount || {};
  if (
    connectedAccount.provider === LOGIN_PROVIDER.GOOGLE &&
    connectedAccount.id &&
    connectedAccount.id !== googleSub &&
    !String(connectedAccount.id).startsWith('email|')
  ) {
    throw new CustomError(403, 'This Google account does not match this DeBOS owner');
  }

  return user;
};

const exchangeDebosGoogleLoginGrant = async ({
  req,
  node,
  createSessionToken,
  grantToken,
  visitorId: suppliedVisitorId,
  locale: suppliedLocale = 'en',
}) => {
  const blocklet = await req.getBlocklet();
  if (!isDebosBlocklet(blocklet)) {
    throw new CustomError(403, 'Google owner login is only available for DeBOS instances');
  }

  const blockletInfo = await req.getBlockletInfo();
  const teamDid = blockletInfo.did;
  const grant = await consumeDebosGoogleLoginGrant(grantToken, {
    appDid: teamDid,
    dataDir: node.dataDirs?.data,
  });

  if (grant.provider !== LOGIN_PROVIDER.GOOGLE || !grant.googleSub || !grant.userDid) {
    throw new CustomError(400, 'Invalid Google login grant');
  }

  const user = await assertGoogleOwner({
    node,
    teamDid,
    userDid: grant.userDid,
    googleSub: grant.googleSub,
  });

  const lastLoginIp = getRequestIP(req);
  const visitorId = suppliedVisitorId || grant.visitorId;
  const deviceData = getDeviceData({ req });
  const locale = suppliedLocale || 'en';

  await node.createAuditLog(
    {
      action: 'login-debos-google-owner',
      args: {
        teamDid,
        userDid: user.did,
        provider: LOGIN_PROVIDER.GOOGLE,
        blockletDid: DEBOS_BLOCKLET_DID,
      },
      context: formatContext(Object.assign(req, { user: { ...user, role: ROLES.OWNER } })),
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
      device: deviceData,
      googleSub: grant.googleSub,
    },
    locale,
    origin: await getOrigin({ req }),
  });

  const createToken = createTokenFn(createSessionToken);
  const sessionConfig = blocklet.settings?.session || {};
  const { sessionToken, refreshToken } = createToken(
    user.did,
    {
      secret: blockletInfo.secret,
      role: ROLES.OWNER,
      fullName: user.fullName,
      provider: LOGIN_PROVIDER.GOOGLE,
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

  logger.info('debos-google-login.success', { userDid: user.did, teamDid });
  return {
    sessionToken,
    refreshToken,
    csrfToken,
    visitorId: userSessionDoc.visitorId,
    provider: LOGIN_PROVIDER.GOOGLE,
  };
};

module.exports = {
  exchangeDebosGoogleLoginGrant,

  init(router, node, createSessionToken) {
    router.post(`${WELLKNOWN_SERVICE_PATH_PREFIX}/api/debos-google-login/exchange`, async (req, res) => {
      const result = await exchangeDebosGoogleLoginGrant({
        req,
        node,
        createSessionToken,
        grantToken: req.body?.grant,
        visitorId: req.body?.visitorId,
        locale: req.body?.locale,
      });
      res.json(result);
    });
  },
};
