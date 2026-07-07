/* eslint-disable no-shadow */
/* eslint-disable implicit-arrow-linebreak */
/* eslint-disable no-underscore-dangle */
const JWT = require('jsonwebtoken');
const { fromPublicKey } = require('@ocap/wallet');
const { isSameDid } = require('@ocap/util');
const { getBlockletInfo } = require('@blocklet/meta/lib/info');
const { getApplicationWallet: getBlockletWallet } = require('@blocklet/meta/lib/wallet');
const { SERVER_ROLES, AUTH_CERT_TYPE, isSystemRole, NODE_MODES } = require('@abtnode/constant');
const { createAuthToken } = require('@abtnode/auth/lib/auth');
const { isUserPassportRevoked, getRoleFromLocalPassport } = require('@abtnode/auth/lib/passport');
const signer = require('@blocklet/server-js/lib/signer');
const { getApplicationInfo } = require('@abtnode/auth/lib/auth');
const { checkAccessKeySource } = require('@abtnode/util/lib/auth-simple-access-key');
const { verify: verifyJwt, decode: decodeJwt } = require('@arcblock/jwt');

const logger = require('@abtnode/logger')('webapp:libs:login');

const { cacheTtl, ttl } = require('./env');

const toBuffer = str => (str.startsWith('0x') ? Buffer.from(str.slice(2), 'hex') : str);

async function getUser(node, did) {
  const user = await node.getNodeUser({ did }, { enableConnectedAccount: true });
  if (user && user.approved) {
    return user;
  }
  return null;
}

const createSessionToken = (
  did,
  { secret, passport, role, fullName, elevated = false, provider, purpose, launchBlockletDid } = {}
) => {
  return createAuthToken({
    did,
    passport,
    role,
    fullName,
    secret,
    expiresIn: cacheTtl,
    elevated,
    provider,
    purpose,
    launchBlockletDid,
  });
};

const createRefreshToken = (did, { secret, passport, role, fullName, provider, purpose, launchBlockletDid } = {}) => {
  return createAuthToken({
    did,
    passport,
    role,
    fullName,
    secret,
    expiresIn: ttl,
    provider,
    purpose,
    launchBlockletDid,
  });
};

const createToken = (
  did,
  { secret, passport, role, fullName, elevated = false, provider, purpose, launchBlockletDid } = {}
) => {
  return {
    sessionToken: createSessionToken(did, {
      secret,
      passport,
      role,
      fullName,
      elevated,
      provider,
      purpose,
      launchBlockletDid,
    }),
    refreshToken: createRefreshToken(did, { secret, passport, role, fullName, provider, purpose, launchBlockletDid }),
  };
};

const parseUserByDecodedJwtToken = async ({ data = {}, node } = {}) => {
  const { did } = data;
  if (!did) {
    throw new Error('Invalid jwt token: invalid did');
  }

  if (data.type === AUTH_CERT_TYPE.OWNERSHIP_NFT) {
    return { role: data.role, did: data.did, elevated: true };
  }

  if (data.type === AUTH_CERT_TYPE.BLOCKLET_USER) {
    return {
      did: data.did,
      role: data.role.startsWith('blocklet-') ? data.role : `blocklet-${data.role}`,
      elevated: data.elevated || false,
      blockletDid: data.blockletDid,
      tenantMode: data.tenantMode,
      provider: data.provider,
      esh: data.esh, // service 中传递过来的 enableSessionHardening
    };
  }

  if (data.type === AUTH_CERT_TYPE.BLOCKLET_CONTROLLER) {
    return {
      role: SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER,
      did: data.did,
      elevated: true,
      controller: data.controller,
      // just for frond-end display
      passports: [{ name: SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER, title: 'External' }],
    };
  }

  const { role, passport, elevated = false } = data;

  const user = await getUser(node, did);
  if (!user) {
    throw new Error('Invalid jwt token: user not in whitelist');
  }

  if (passport && passport.id && isUserPassportRevoked(user, passport)) {
    throw new Error(`Passport ${passport.name} has been revoked`);
  }

  user.elevated = elevated;
  user.role = role;
  user.provider = data.provider;
  user.purpose = data.purpose;
  user.launchBlockletDid = data.launchBlockletDid;
  if (passport) {
    user.passportId = passport.id;
  }

  return user;
};

// allow launcher request with self-signed token when in serverless mode
async function authWithLauncherSignature(token, node) {
  const info = await node.getNodeInfo();

  if (info.mode !== NODE_MODES.SERVERLESS && process.env.ABT_NODE_DEBUG_AS_SERVERLESS !== 'true') {
    logger.warn('Launcher signature is not allowed in non-serverless mode');
    return null;
  }
  if (!info.registerUrl || !info.registerInfo) {
    logger.warn('Launcher info is not available');
    return null;
  }

  const { appId, appPk } = info.registerInfo;
  const decoded = decodeJwt(token, appPk);

  if (!decoded?.iss || !isSameDid(decoded.iss, appId)) {
    logger.warn('Launcher signature is not valid: signer did mismatch');
    return null;
  }

  const valid = await verifyJwt(token, appPk);
  if (!valid) {
    logger.warn('Launcher signature is not valid: signature mismatch');
    return null;
  }

  return {
    role: SERVER_ROLES.EXTERNAL_BLOCKLETS_MANAGER,
    did: decoded.did,
    elevated: true,
    provider: 'launcher',
  };
}

function authWithJwt(token, node) {
  return node.getSessionSecret().then(sessionSecret => {
    return new Promise((resolve, reject) => {
      JWT.verify(token, sessionSecret, (err, decoded) => {
        if (err) {
          return reject(err);
        }

        return resolve(parseUserByDecodedJwtToken({ data: decoded, node }));
      });
    });
  });
}

function authWithLoginToken(token, secret) {
  return new Promise((resolve, reject) => {
    JWT.verify(token, secret, (err, decoded) => {
      if (err) {
        return reject(err);
      }
      return resolve(decoded);
    });
  });
}

const verifyAccessKey = async ({ keyId, stamp, signature, node, blockletDid, info }) => {
  const { teamDid, isFromBlocklet, accessKey } = await checkAccessKeySource({ node, keyId, info, blockletDid });

  if (!accessKey) {
    throw new Error(`Access Key ${keyId} does not exist`);
  }

  const { accessKeyPublic, passport, remark, expireAt, authType } = accessKey;

  if (authType !== 'signature') {
    throw new Error(`Access Key ${keyId} is not a signature type`);
  }

  if (expireAt && new Date(expireAt).getTime() < new Date().getTime()) {
    throw new Error(`Access Key ${keyId} has expired`);
  }

  const role = getRoleFromLocalPassport({ name: passport });
  const wallet = fromPublicKey(accessKeyPublic);
  if (!(await wallet.verify(`${stamp}-${keyId}`, signature))) {
    throw new Error(`verify failed. keyId: ${keyId}, stamp: ${stamp}, signature: ${signature}`);
  }

  await node.refreshLastUsed({ teamDid, accessKeyId: keyId });
  const blockletRole = isSystemRole(role) ? `blocklet-${role}` : role;

  const user = accessKey.createdBy ? await node.getUser({ teamDid, user: { did: accessKey.createdBy } }) : null;

  return {
    did: accessKey.createdBy || keyId,
    pk: user?.pk,
    role: isFromBlocklet ? blockletRole : role,
    elevated: true,
    blockletDid,
    fullName: remark || keyId,
    provider: 'accessKey',
  };
};

async function authWithAccessKeySignature({
  keyId,
  stamp,
  signature,
  node,
  blockletDid,
  alg,
  componentDid = '',
  token = '',
}) {
  const info = await node.getNodeInfo({ useCache: true });

  if (!blockletDid) {
    // 此时，可能是 node 的 accessKey 在访问 node 的接口
    return verifyAccessKey({ keyId, stamp, signature, node, blockletDid, info });
  }

  // request from blocklet
  const blocklet = await node.getBlocklet({ did: blockletDid, useCache: true });
  if (!blocklet) {
    throw new Error(`blocklet is not valid: ${blockletDid}`);
  }

  const { name, wallet } = getBlockletInfo(blocklet, info.sk);
  // For components sharing state with parent, always use root app's wallet (blockletDid is the root)
  const accessWallet = getBlockletWallet(blocklet.appDid || blocklet.meta.did, info.sk, undefined, 2);

  // compatible with previous version
  const verifyWallet = keyId === accessWallet.address ? accessWallet : wallet;

  if (verifyWallet.address === keyId) {
    // Generate BLOCKLET_APP_EK using the same logic as getRuntimeEnvironments
    const secretKeyBuffer = toBuffer(verifyWallet.secretKey);

    if (alg === 'totp') {
      const valid = signer.totp.verify(secretKeyBuffer, signature);
      if (!valid) {
        throw new Error(`verify failed. keyId: ${keyId}, date: ${Date.now()}, signature: ${signature}`);
      }
    } else if (alg === 'sha256') {
      const valid = signer.sha256.verify(secretKeyBuffer, signature);
      if (!valid) {
        throw new Error(`verify failed. keyId: ${keyId}, date: ${Date.now()}, signature: ${signature}`);
      }
    } else {
      // For wallet signature verification, use BLOCKLET_APP_EK
      const valid = await verifyWallet.verify(`${stamp}-${keyId}`, signature);
      if (!valid) {
        throw new Error(`verify failed. keyId: ${keyId}, stamp: ${stamp}, signature: ${signature}`);
      }
    }

    let userInfo = {};
    if (token) {
      try {
        const appInfo = await getApplicationInfo({ node, nodeInfo: info, teamDid: blockletDid });
        userInfo = await authWithLoginToken(token, appInfo.secret);
      } catch (err) {
        throw new Error('Authentication failed');
      }
    }

    return {
      did: blockletDid,
      pk: wallet.publicKey,
      role: SERVER_ROLES.BLOCKLET_SDK,
      elevated: true,
      blockletDid,
      fullName: name,
      componentDid,
      userInfo,
      provider: 'accessKey',
    };
  }

  return verifyAccessKey({ keyId, stamp, signature, node, blockletDid, info });
}

module.exports = {
  createToken,
  createRefreshToken,
  createSessionToken,
  authWithJwt,
  authWithAccessKeySignature,
  authWithLauncherSignature,
  getUser,
  parseUserByDecodedJwtToken,
  checkAccessKeySource,
};
