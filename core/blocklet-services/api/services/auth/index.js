/* eslint-disable arrow-parens */
const get = require('lodash/get');
const cookie = require('cookie');
const bearerToken = require('@abtnode/util/lib/express-bearer-token');

const validators = require('@blocklet/sdk/lib/validators');
const { NODE_SERVICES, ROLES, WELLKNOWN_SERVICE_PATH_PREFIX } = require('@abtnode/constant');
const { BLOCKLET_MODES } = require('@blocklet/constant');
const { setUserInfoHeaders } = require('@abtnode/auth/lib/auth');

const { createConnectToDidSpacesRoute } = require('@abtnode/auth/lib/connect-to-did-spaces');
const logger = require('../../libs/logger')('auth');
const initJwt = require('../../libs/jwt');
const initAuth = require('../../libs/connect/v1');

const createLoginRoutes = require('./connect/login');
const createLoginDebosLaunchRoutes = require('./connect/login-debos-launch');
const createBindWallerRoutes = require('./connect/bind-wallet');
const createInviteRoutes = require('./connect/invite');
const createIssuePassportAuth = require('./connect/issue-passport');
const createExchangePassportAuth = require('./connect/exchange-passport');
const createLostPassportListAuth = require('./connect/lost-passport-list');
const createLostPassportIssueAuth = require('./connect/lost-passport-issue');
const createPreSetupAuth = require('./connect/pre-setup');
const createSetupAuth = require('./connect/setup');
const createSwitchProfileAuth = require('./connect/switch-profile');
const createSwitchPassportAuth = require('./connect/switch-passport');
const createRotateKeyPairAuth = require('./connect/rotate-key-pair');
const createCheckHasProjectIdAuth = require('./connect/check-has-project-id');
const createFuelAuth = require('./connect/fuel');
const createMigrateToStructV2Routes = require('./connect/migrate-app-to-struct-v2');
const createTransferAppOwnerRoutes = require('./connect/transfer-app-owner');
const createIssueKycAuth = require('./connect/issue-kyc');
const createUpdateKycAuth = require('./connect/update-kyc');
const createVerifyElevatedAuth = require('./connect/verify-elevated');
const createVerifyDestroyAuth = require('./connect/verify-destroy');
const createDestroyMyselfAuth = require('./connect/destroy-self');
const createReceiveTransferAppOwnerRoutes = require('./connect/receive-transfer-app-owner');
const createConfigVaultAuth = require('./connect/config-vault');
const createApproveVaultAuth = require('./connect/approve-vault');
const createSessionRoutes = require('./session');
const createPassportRoutes = require('./passport');
const createPasskeyRoutes = require('./passkey');
const createGenAccessKeyRoutes = require('./connect/gen-access-key');
const createDebosGoogleLoginRoutes = require('./debos-google-login');

const { getRedirectUrl, shouldIgnoreUrl, redirectWithoutCache } = require('../../util');
const { createConnectToDidSpacesForUserRoute } = require('./connect/connect-to-did-spaces-for-user');
const { isEmailKycRequired, isPhoneKycRequired } = require('../../libs/kyc');

const getTokenFromWsConnect = (req, options) => {
  const cookies = cookie.parse(req.headers.cookie || '');
  if (cookies[options.sessionTokenKey]) {
    return cookies[options.sessionTokenKey];
  }

  const { searchParams } = new URL(req.url, `http://${req.headers.host || 'unknown'}`);
  return searchParams.get('token');
};

const isDevWsConnect = async (req) => {
  const blocklet = await req.getBlocklet();
  const devUrls = ['/sockjs-node', '/ws'];
  const mode = get(blocklet, 'mode');
  return mode === BLOCKLET_MODES.DEVELOPMENT && devUrls.includes(req.url);
};

const REASON_404 = 'Not Found';
const REASON_401 = 'Unauthorized';
const REASON_403 = 'Forbidden';

const init = ({ node, options }) => {
  const { createSessionToken, verifySessionToken } = initJwt(node, options);

  /**
   * @typedef {object} CheckAuthRes
   * @property {boolean} [blocked]
   * @property {boolean} [authenticated]
   * @property {boolean} [authorized]
   * @property {boolean} [ignored]
   * @property {string} [ignoreReason]
   * @property {string} [payable]
   * @property {Array<{
   *   name: string;
   *   title: string;
   *   description: string;
   * }>} [requiredRoles]
   */

  /**
   * @returns {CheckAuthRes} res
   */
  const checkAuth = async ({ req } = {}) => {
    const serviceConfig = (await req.getServiceConfig(NODE_SERVICES.AUTH)) || {};

    const ignoreUrls = (get(serviceConfig, 'ignoreUrls') || []).filter(Boolean);

    // default public url
    // developers need not config the following urls in blocklet.yml
    ignoreUrls.push('/api/public/**');

    const shouldIgnore = shouldIgnoreUrl(req.url, ignoreUrls);
    if (shouldIgnore) {
      return { ignored: true, ignoreReason: 'ignoreUrls' };
    }

    const teamDid = req.getBlockletDid();

    const rbac = await node.getRBAC(teamDid);
    const [allRoles, { accessPolicyConfig }] = await Promise.all([rbac.getRoles(teamDid), req.getSecurityConfig()]);

    const accessRoles = accessPolicyConfig?.accessPolicy?.roles || null;
    const accessReverse = accessPolicyConfig?.accessPolicy?.reverse || false;

    // public 公开权限，不做任何拦截
    if (accessRoles === null && accessReverse === false) {
      // 如果当前应用配置了拦截未登录的请求，则应该拦截
      if (serviceConfig.blockUnauthenticated && !req.user) {
        return { blocked: true, authenticated: false };
      }
      return { ignored: true };
    }

    // invite only, 需要被邀请才能访问的情况
    // HACK: 不是公开的情况下，就是需要有通行证才能访问，此时只需要判断 req.user 是否存在即可
    // FIXME: 这里最严谨的处理应该需要加上当前用户的登录状态是否有对应的 passport，否则也应该拦截 (此处先沿用上一版本的设定，只判断用户是否已登录)
    // if (accessRoles.length === 0 && accessReverse === true) {}
    if (!req.user) {
      const payableRole = allRoles.find((x) => x.extra?.acquire?.pay);
      return {
        blocked: true,
        authenticated: false,
        payable: payableRole?.extra?.acquire?.pay,
      };
    }

    // 指定 role 访问权限
    if (accessRoles.length > 0) {
      const roles = accessReverse
        ? allRoles.filter((role) => !accessRoles.includes(role.name)).map((role) => role.name)
        : accessRoles;
      if (!roles.includes(req.user.role)) {
        return {
          blocked: true,
          authenticated: true,
          authorized: false,
          requiredRoles: roles
            .map((item) => {
              if (item.name === ROLES.OWNER) {
                return {
                  name: item.name,
                  title: 'Owner',
                  description: 'Owner',
                };
              }
              const findRole = allRoles.find((x) => x.name === item);
              if (!findRole) {
                return null;
              }

              return {
                name: findRole.name,
                title: findRole.title,
                description: findRole.description,
                payable: findRole?.extra?.acquire?.pay,
              };
            })
            .filter((x) => x),
        };
      }
    }

    if (!serviceConfig.blockUnauthorized) {
      return { ignored: true };
    }

    // FIXME: 恢复原来的代码，暂不知道具体用途，先保留
    // const rule = await req.getRoutingRule();
    // if (rule.to && rule.to.interfaceName) {
    //   const permissionName = genPermissionName(rule.to.interfaceName);

    //   if (await rbac.can(req.user.role, ...permissionName.split('_'))) {
    //     return {};
    //   }

    //   return { blocked: true, authenticated: true, authorized: false };
    // }

    return {};
  };

  const { authenticator, handlers } = initAuth(node, options);

  const middlewares = {};
  const routes = {};

  // auth middleware for http request
  middlewares.sessionBearerToken = bearerToken({
    queryKey: options.sessionTokenKey,
    headerKey: 'Bearer',
    cookie: {
      signed: true,
      secret: options.sessionSecret,
      key: options.sessionTokenKey,
    },
  });

  middlewares.refreshBearerToken = bearerToken({
    headerKey: 'Bearer',
    reqKey: 'refreshToken',
  });

  // set user info to req.user and req.headers
  middlewares.userInfo = async (req, res, next) => {
    const { token } = req;
    await req.ensureUser({ token });

    // Saved for oauth server
    if (req.user) {
      res.locals.user = req.user;
    }

    setUserInfoHeaders(req);

    next();
  };

  // did-auth api
  routes.attachDidAuthHandlers = (app) => {
    handlers.forEach((handler) => {
      handler.attach(Object.assign({ app }, createLoginRoutes(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createLoginDebosLaunchRoutes(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createBindWallerRoutes(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createConnectToDidSpacesRoute(node, authenticator, createSessionToken)));
      handler.attach(
        Object.assign({ app }, createConnectToDidSpacesForUserRoute(node, authenticator, createSessionToken))
      );
      handler.attach(Object.assign({ app }, createInviteRoutes(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createIssuePassportAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createExchangePassportAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createLostPassportListAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createLostPassportIssueAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createPreSetupAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createSetupAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createSwitchProfileAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createSwitchPassportAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createRotateKeyPairAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createFuelAuth(authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createMigrateToStructV2Routes(node, options)));
      handler.attach(Object.assign({ app }, createTransferAppOwnerRoutes(node, options)));
      handler.attach(Object.assign({ app }, createReceiveTransferAppOwnerRoutes(node, options, createSessionToken)));
      handler.attach(Object.assign({ app }, createConfigVaultAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createApproveVaultAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createCheckHasProjectIdAuth(node, options, createSessionToken)));
      handler.attach(Object.assign({ app }, createIssueKycAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createUpdateKycAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createVerifyElevatedAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createVerifyDestroyAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createDestroyMyselfAuth(node, authenticator, createSessionToken)));
      handler.attach(Object.assign({ app }, createGenAccessKeyRoutes(node)));
    });
  };

  // public http api
  routes.createPassportRoutes = createPassportRoutes;
  routes.createPasskeyRoutes = {
    init: (router) => createPasskeyRoutes.init(router, node, options, createSessionToken),
  };
  routes.createSessionRoutes = {
    // eslint-disable-next-line no-shadow
    init: (router, node) =>
      createSessionRoutes.init(router, node, createSessionToken, {
        ...options,
        middlewares,
        createSessionToken,
        verifySessionToken,
      }),
  };
  routes.createCommonRoutes = {
    init: (router) => {
      createDebosGoogleLoginRoutes.init(router, node, createSessionToken, options);

      router.get(`${WELLKNOWN_SERVICE_PATH_PREFIX}/redirect-with-login`, async (req, res) => {
        if (req.query.setupToken) {
          await req
            .attachSetupToken({ res, token: req.query.setupToken, visitorId: req.query.visitorId })
            .catch((error) => {
              logger.error('attach login token failed when redirecting with login', { error }); // 不阻塞跳转
            });
        }

        redirectWithoutCache(res, '/');
      });
    },
  };

  const ensureWsUser = async (req) => {
    const token = getTokenFromWsConnect(req, options);

    // ignore some dev path in dev mode
    if (await isDevWsConnect(req)) {
      return;
    }

    await req.ensureUser({ token });
  };

  // auth middleware for websocket connect
  middlewares.ensureWsAuth = async (req, socket, head, next) => {
    const token = getTokenFromWsConnect(req, options);

    // ignore some dev path in dev mode
    if (await isDevWsConnect(req)) {
      next();
      return;
    }

    await req.ensureUser({ token });

    setUserInfoHeaders(req);

    const { blocked } = await checkAuth({ req });

    if (blocked) {
      const component = await req.getComponent();
      if (component?.mode === 'development') {
        socket.write(`HTTP/1.1 401 ${REASON_401}\r\n\r\n`);
        socket.destroy();
        return;
      }
      // Security principles: user should not known the reason
      socket.write(`HTTP/1.1 404 ${REASON_404}\r\n\r\n`);
      socket.destroy();
      return;
    }

    next();
  };

  middlewares.checkKyc = async (req, res, next) => {
    if (res.locals?.auth?.ignored && res.locals?.auth?.ignoreReason === 'ignoreUrls') {
      return next();
    }

    if (req.user) {
      if (req.user?.provider === 'accessKey') {
        return next();
      }

      const component = await req.getComponent();
      if (component?.mode === 'development') {
        return next();
      }

      const blocklet = await req.getBlocklet();
      if (isEmailKycRequired(blocklet) && !req.user.emailVerified) {
        if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') {
          return redirectWithoutCache(res, getRedirectUrl({ req, pagePath: '/kyc/email', params: { updateKyc: 1 } }));
        }

        // Security principles: user should not known the reason
        return res.status(403).json({ code: 403, error: REASON_403, reason: 'email_not_verified' });
      }

      if (isPhoneKycRequired(blocklet) && !req.user.phoneVerified) {
        if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') {
          return redirectWithoutCache(res, getRedirectUrl({ req, pagePath: '/kyc/phone', params: { updateKyc: 1 } }));
        }

        // Security principles: user should not known the reason
        return res.status(403).json({ code: 403, error: REASON_403, reason: 'phone_not_verified' });
      }
    }

    return next();
  };

  // 检查是否符合访问权限控制，不符合的就进行重定向
  middlewares.checkAuth = async (req, res, next) => {
    res.locals.auth = await checkAuth({ req });
    const { blocked, authenticated, authorized, payable, requiredRoles } = res.locals.auth;

    if (blocked) {
      if (!authenticated) {
        if (req.accepts(['html', 'json']) === 'html') {
          redirectWithoutCache(res, getRedirectUrl({ req, pagePath: '/login', params: { payable } }));
        } else {
          const component = await req.getComponent();
          if (component?.mode === 'development') {
            res.status(401).json({ code: 401, error: REASON_401 });
          } else {
            // Security principles: user should not known the reason
            res.status(404).json({ code: 404, error: REASON_404 });
          }
        }
        return;
      }

      if (!authorized) {
        if (req.accepts(['html', 'json']) === 'html') {
          redirectWithoutCache(
            res,
            getRedirectUrl({
              req,
              pagePath: '/login',
              params: {
                authenticated: 1,
                payable,
                requiredRoles: JSON.stringify(requiredRoles),
              },
            })
          );
        } else {
          const component = await req.getComponent();
          if (component?.mode === 'development') {
            res.status(403).json({ code: 403, error: REASON_403 });
          } else {
            // Security principles: user should not known the reason
            res.status(404).json({ code: 404, error: REASON_404 });
          }
        }
        return;
      }
    }

    next();
  };

  return {
    middlewares,
    routes,
    ensureWsUser,
  };
};

module.exports = {
  init,
  validators,
  getTokenFromWsConnect,
};
