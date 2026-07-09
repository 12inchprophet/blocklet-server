const crypto = require('node:crypto');
const { DEBOS_BLOCKLET_DID, ROLES, WELLKNOWN_SERVICE_PATH_PREFIX } = require('@abtnode/constant');
const formatContext = require('@abtnode/util/lib/format-context');
const getRequestIP = require('@abtnode/util/lib/get-request-ip');
const { fromAppDid } = require('@arcblock/did-ext');
const { BLOCKLET_CONFIGURABLE_KEY, LOGIN_PROVIDER } = require('@blocklet/constant');
const { CustomError } = require('@blocklet/error');
const { joinURL, withQuery } = require('ufo');

const { OauthClient } = require('@abtnode/blocklet-services/api/libs/auth');
const OAuthGoogle = require('@abtnode/blocklet-services/api/libs/auth/adapters/google');
const { createDebosGoogleLoginGrant } = require('@abtnode/auth/lib/debos-google-grant');
const { assertDebosLaunchLoginAllowed } = require('@abtnode/auth/lib/debos-launch-guard');
const logger = require('@abtnode/logger')(require('../../../package.json').name);

const { createToken } = require('../../libs/login');
const { getBaseUrl } = require('../../util');
const { ensureDebosLaunchRequest } = require('./login-debos-launch');

const STATE_TTL = 10 * 60 * 1000;

const getGoogleConfig = () => {
  const clientId = process.env.DEBOS_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.DEBOS_GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};

const getRequestOrigin = req => {
  const protocol = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host')).split(',')[0].trim();
  return `${protocol}://${host}`;
};

const signState = (payload, secret) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

const verifyState = (state, secret) => {
  const [encoded, suppliedSignature] = String(state || '').split('.');
  if (!encoded || !suppliedSignature) {
    throw new CustomError(400, 'Invalid OAuth state');
  }

  const expectedSignature = crypto.createHmac('sha256', secret).update(encoded).digest();
  const supplied = Buffer.from(suppliedSignature, 'base64url');
  if (supplied.length !== expectedSignature.length || !crypto.timingSafeEqual(supplied, expectedSignature)) {
    throw new CustomError(400, 'Invalid OAuth state');
  }

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  if ((!payload.origin && payload.flow !== 'debos-login') || !payload.expiresAt || payload.expiresAt < Date.now()) {
    throw new CustomError(400, 'Expired OAuth state');
  }
  return payload;
};

const createGoogleClient = config =>
  new OauthClient({
    provider: OAuthGoogle(config),
  });

const getBrokerBaseUrl = req =>
  (process.env.DEBOS_GOOGLE_BROKER_URL || joinURL(getRequestOrigin(req), getBaseUrl(req))).replace(/\/+$/, '');

const getCallbackUrl = req => joinURL(getBrokerBaseUrl(req), '/oauth/debos-launch/callback/google');

const getEnvironmentValue = (blocklet, key) =>
  blocklet?.environmentObj?.[key] || (blocklet?.environments || []).find(x => x.key === key)?.value;

const ensureBlockletEnvironments = async (node, blocklet) => {
  if (!blocklet || blocklet.environments?.length || blocklet.environmentObj) {
    return blocklet;
  }

  const { all } = await node.getBlockletEnvironments(blocklet.did || blocklet.meta?.did);
  return {
    ...blocklet,
    environments: all,
    environmentObj: Object.fromEntries((all || []).map(item => [item.key, item.value])),
  };
};

const isDebosBlocklet = blocklet => {
  const dids = [
    blocklet?.did,
    blocklet?.appDid,
    blocklet?.appPid,
    blocklet?.meta?.did,
    blocklet?.environmentObj?.BLOCKLET_COMPONENT_DID,
    getEnvironmentValue(blocklet, 'BLOCKLET_COMPONENT_DID'),
    ...(blocklet?.componentMountPoints || []).map(item => item.did),
    ...(blocklet?.children || []).map(item => item?.meta?.did || item?.did),
  ].filter(Boolean);

  return dids.includes(DEBOS_BLOCKLET_DID);
};

const getTargetDebosBlocklet = async ({ node, appDid }) => {
  if (!appDid) {
    throw new CustomError(400, 'Missing target blocklet DID');
  }

  const blocklet = await ensureBlockletEnvironments(node, await node.getBlocklet({ did: appDid, attachConfig: false }));
  if (!blocklet) {
    throw new CustomError(404, 'Target blocklet not found');
  }

  if (!isDebosBlocklet(blocklet)) {
    throw new CustomError(403, 'Google re-entry is only available for DeBOS instances');
  }

  const appUrl =
    getEnvironmentValue(blocklet, BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_URL) ||
    getEnvironmentValue(blocklet, 'BLOCKLET_APP_URL');
  if (!appUrl) {
    throw new CustomError(400, 'Target blocklet does not have a public URL');
  }

  return { blocklet, appUrl };
};

const normalizeRelativeRedirect = value => {
  if (!value) {
    return '/';
  }

  try {
    const parsed = new URL(value, 'https://target.local');
    if (parsed.origin !== 'https://target.local') {
      throw new Error('absolute redirects are not allowed');
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
  } catch (error) {
    throw new CustomError(400, 'Invalid redirect URL');
  }
};

const normalizeDebosOauthPopup = ({ oauthPopup, oauthCallbackUrl, oauthState }, expectedOrigin) => {
  if (!oauthPopup) {
    return {};
  }

  let callback;
  let caller;
  try {
    callback = new URL(oauthCallbackUrl);
    caller = new URL(oauthState);
  } catch (error) {
    throw new CustomError(400, 'Invalid OAuth popup callback');
  }

  if (!['http:', 'https:'].includes(callback.protocol) || !['http:', 'https:'].includes(caller.protocol)) {
    throw new CustomError(400, 'Invalid OAuth popup callback');
  }

  if (callback.origin !== caller.origin) {
    throw new CustomError(400, 'Invalid OAuth popup caller');
  }

  if (callback.origin !== expectedOrigin) {
    throw new CustomError(400, 'OAuth popup callback does not belong to the target blocklet');
  }

  const expectedPath = joinURL(WELLKNOWN_SERVICE_PATH_PREFIX, '/oauth/callback/google');
  if (callback.pathname !== expectedPath) {
    throw new CustomError(400, 'Invalid OAuth popup callback');
  }

  return {
    oauthPopup: true,
    oauthCallbackUrl: callback.toString(),
    oauthState: caller.origin,
  };
};

const isOwnerUser = user => {
  if (!user || user.approved === false) {
    return false;
  }

  if (user.role === ROLES.OWNER || user.passport?.name === ROLES.OWNER || user.passport?.role === ROLES.OWNER) {
    return true;
  }

  return (user.passports || []).some(passport => passport.name === ROLES.OWNER || passport.role === ROLES.OWNER);
};

const assertTargetOwner = async ({ node, appDid, userDid, googleSub }) => {
  const user = await node.getUser({
    teamDid: appDid,
    user: { did: userDid },
    options: { enableConnectedAccount: true },
  });

  if (!isOwnerUser(user)) {
    throw new CustomError(403, 'This Google account is not the owner of the target DeBOS instance');
  }

  const connectedAccount = user.connectedAccount || {};
  if (
    connectedAccount.provider === LOGIN_PROVIDER.GOOGLE &&
    connectedAccount.id &&
    connectedAccount.id !== googleSub &&
    !String(connectedAccount.id).startsWith('email|')
  ) {
    throw new CustomError(403, 'This Google account does not match the owner account');
  }

  return user;
};

const sendPopupResponse = (res, { origin, code, state, error }) => {
  const payload = JSON.stringify({
    type: 'debos-google-oauth',
    code,
    state,
    error,
  }).replace(/</g, '\\u003c');
  const targetOrigin = JSON.stringify(origin).replace(/</g, '\\u003c');

  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Google sign-in</title></head>
  <body>
    <p>${error ? 'Google sign-in failed. You can close this window.' : 'Google sign-in complete.'}</p>
    <script>
      if (window.opener) {
        window.opener.postMessage(${payload}, ${targetOrigin});
      }
      window.close();
    </script>
  </body>
	</html>`);
};

const redirectDebosOauthPopup = (res, payload, params) => {
  if (!payload.oauthPopup) {
    return false;
  }

  res.redirect(
    withQuery(payload.oauthCallbackUrl, {
      ...params,
      state: payload.oauthState,
    })
  );
  return true;
};

module.exports = {
  init(router, node, { googleClientFactory = createGoogleClient } = {}) {
    router.get('/api/oauth/debos-launch/config', (req, res) => {
      res.json({
        google: {
          enabled: !!getGoogleConfig(),
          callbackUrl: getCallbackUrl(req),
          brokerUrl: getBrokerBaseUrl(req),
        },
      });
    });

    router.get('/oauth/debos-launch/google', async (req, res) => {
      const config = getGoogleConfig();
      if (!config) {
        throw new CustomError(503, 'Google sign-in is not configured');
      }

      const origin = getRequestOrigin(req);
      const referrer = req.get('referer');
      if (referrer && new URL(referrer).origin !== origin) {
        throw new CustomError(400, 'Invalid OAuth caller');
      }

      const state = signState(
        {
          origin,
          expiresAt: Date.now() + STATE_TTL,
          nonce: crypto.randomBytes(16).toString('hex'),
        },
        await node.getSessionSecret()
      );
      const client = googleClientFactory({
        ...config,
        callbackUrl: getCallbackUrl(req),
      });
      res.redirect(client.getAuthorizationUrl(state));
    });

    router.get('/oauth/debos-login/google', async (req, res) => {
      const config = getGoogleConfig();
      if (!config) {
        throw new CustomError(503, 'Google sign-in is not configured');
      }

      const appDid = String(req.query.appDid || '');
      const redirectPath = normalizeRelativeRedirect(req.query.redirect);
      const target = await getTargetDebosBlocklet({ node, appDid });
      const oauthPopup = normalizeDebosOauthPopup(req.query, new URL(target.appUrl).origin);

      const state = signState(
        {
          flow: 'debos-login',
          appDid,
          redirectPath,
          ...oauthPopup,
          expiresAt: Date.now() + STATE_TTL,
          nonce: crypto.randomBytes(16).toString('hex'),
        },
        await node.getSessionSecret()
      );
      const client = googleClientFactory({
        ...config,
        callbackUrl: getCallbackUrl(req),
      });
      res.redirect(client.getAuthorizationUrl(state));
    });

    router.get('/oauth/debos-launch/callback/google', async (req, res) => {
      const { code, error, state } = req.query;
      const payload = verifyState(state, await node.getSessionSecret());

      if (payload.flow === 'debos-login') {
        if (error) {
          if (
            redirectDebosOauthPopup(res, payload, {
              error: String(error),
              error_description: String(req.query.error_description || error),
            })
          ) {
            return;
          }
          throw new CustomError(400, String(error));
        }

        const config = getGoogleConfig();
        if (!config) {
          throw new CustomError(503, 'Google sign-in is not configured');
        }

        const target = await getTargetDebosBlocklet({ node, appDid: payload.appDid });
        const client = googleClientFactory({
          ...config,
          callbackUrl: getCallbackUrl(req),
        });
        const tokens = await client.getToken({ code });
        const profile = await client.getProfile(tokens);
        if (!profile?.sub) {
          throw new CustomError(400, 'Google did not return a valid user');
        }

        const info = await node.getNodeInfo();
        const userWallet = fromAppDid(profile.sub, info.sk);
        const userDid = userWallet.address;
        await assertTargetOwner({
          node,
          appDid: payload.appDid,
          userDid,
          googleSub: profile.sub,
        });

        const grant = await createDebosGoogleLoginGrant(
          {
            appDid: payload.appDid,
            userDid,
            provider: LOGIN_PROVIDER.GOOGLE,
            googleSub: profile.sub,
            redirectPath: payload.redirectPath,
          },
          { dataDir: node.dataDirs?.data }
        );

        logger.info('debos-google-login.grant.created', { userDid, appDid: payload.appDid });
        if (
          redirectDebosOauthPopup(res, payload, {
            code: grant,
          })
        ) {
          return;
        }

        res.redirect(
          withQuery(joinURL(target.appUrl, WELLKNOWN_SERVICE_PATH_PREFIX, '/login'), {
            debosGoogleGrant: grant,
            redirect: payload.redirectPath,
          })
        );
        return;
      }

      sendPopupResponse(res, {
        origin: payload.origin,
        code,
        state,
        error,
      });
    });

    router.post('/api/oauth/debos-launch/login', async (req, res) => {
      const config = getGoogleConfig();
      if (!config) {
        throw new CustomError(503, 'Google sign-in is not configured');
      }

      const { blockletMetaUrl, code, locale = 'en', state } = req.body;
      const statePayload = verifyState(state, await node.getSessionSecret());
      if (req.get('origin') !== statePayload.origin || getRequestOrigin(req) !== statePayload.origin) {
        throw new CustomError(400, 'Invalid OAuth caller');
      }
      await ensureDebosLaunchRequest({ node, blockletMetaUrl, locale });

      const client = googleClientFactory({
        ...config,
        callbackUrl: getCallbackUrl(req),
      });
      const tokens = await client.getToken({ code });
      const profile = await client.getProfile(tokens);
      if (!profile?.sub) {
        throw new CustomError(400, 'Google did not return a valid user');
      }

      const info = await node.getNodeInfo();
      const userWallet = fromAppDid(profile.sub, info.sk);
      const userDid = userWallet.address;
      await assertDebosLaunchLoginAllowed({
        node,
        provider: LOGIN_PROVIDER.GOOGLE,
        userDid,
        googleProfile: profile,
        req,
      });
      const existingUser = await node.getUser({
        teamDid: info.did,
        user: { did: userDid },
        options: { enableConnectedAccount: true },
      });
      if (existingUser && !existingUser.approved) {
        throw new CustomError(403, 'This account is not approved');
      }

      const connectedAccount = {
        provider: LOGIN_PROVIDER.GOOGLE,
        id: profile.sub,
        did: userDid,
        pk: userWallet.publicKey,
        userInfo: profile,
      };
      const doc = await node.loginUser({
        teamDid: info.did,
        user: {
          did: userDid,
          pk: userWallet.publicKey,
          approved: true,
          locale,
          fullName: profile.name || existingUser?.fullName,
          email: profile.email || existingUser?.email,
          emailVerified: profile.emailVerified === true,
          lastLoginIp: getRequestIP(req),
          connectedAccount,
        },
      });

      await node.createAuditLog(
        {
          action: 'login-debos-launch',
          args: {
            teamDid: info.did,
            userDid,
            provider: LOGIN_PROVIDER.GOOGLE,
            blockletDid: DEBOS_BLOCKLET_DID,
          },
          context: formatContext(Object.assign(req, { user: { ...doc, role: ROLES.GUEST } })),
          result: doc,
        },
        node
      );

      const { sessionToken, refreshToken } = await createToken(userDid, {
        secret: await node.getSessionSecret(),
        role: ROLES.GUEST,
        fullName: doc.fullName,
        elevated: false,
        provider: LOGIN_PROVIDER.GOOGLE,
        purpose: 'debos-launch',
        launchBlockletDid: DEBOS_BLOCKLET_DID,
      });

      logger.info('login-debos-launch.google.success', { userDid, blockletDid: DEBOS_BLOCKLET_DID });
      res.json({
        sessionToken,
        refreshToken,
        provider: LOGIN_PROVIDER.GOOGLE,
      });
    });
  },
};

module.exports.signState = signState;
module.exports.verifyState = verifyState;
