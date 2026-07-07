const path = require('node:path');
const fs = require('node:fs');
const cors = require('cors');
const express = require('express');
const expandTilde = require('expand-tilde');
const Cookie = require('cookie');
const crypto = require('node:crypto');
require('express-async-errors');
const { minimatch } = require('minimatch');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const bearerToken = require('@abtnode/util/lib/express-bearer-token');
const graphqlUploadExpress = require('graphql-upload/graphqlUploadExpress.js');
const { joinURL } = require('ufo');
const get502Template = require('@abtnode/router-templates/lib/502');
const { getBlockletNotRunningTemplate } = require('@abtnode/router-templates/lib/blocklet-not-running');
const { getStatusFromError, CustomError } = require('@blocklet/error');
const {
  MAX_UPLOAD_FILE_SIZE,
  WELLKNOWN_SERVER_ADMIN_PATH,
  USER_AVATAR_URL_PREFIX,
  USER_AVATAR_PATH_PREFIX,
  NODE_MODES,
} = require('@abtnode/constant');
const http = require('http');
const { setUserInfoHeaders } = require('@abtnode/auth/lib/auth');
const log = require('@abtnode/logger');
const certificateManager = require('@abtnode/certificate-manager');
const createInvite = require('@abtnode/auth/lib/invitation');
const normalizePathPrefix = require('@abtnode/util/lib/normalize-path-prefix');
const { buildThemeStyles, buildThemeScript } = require('@blocklet/theme');
const { RESOURCE_PATTERN } = require('@blocklet/constant');

const { createConnectToDidSpacesRoute } = require('@abtnode/auth/lib/connect-to-did-spaces');
const { authBySimpleAccessKey, isAccessKey, isLoginToken } = require('@abtnode/util/lib/auth-simple-access-key');
const { authWithJwt, authWithAccessKeySignature, authWithLauncherSignature } = require('./libs/login');
const { context, handlers } = require('./libs/auth');
const { protectGQL } = require('./libs/security');
const gql = require('./gql');
const createWebSocketServer = require('./ws');
const createRelayServer = require('./ws/relay');
const { restrictGuestDashboardSession } = require('./libs/launch-session');

const logger = log('webapp:index');

const createLoginAuth = require('./routes/auth/login');
const createExchangePassportAuth = require('./routes/auth/exchange-passport');
const createSwitchProfileAuth = require('./routes/auth/switch-profile');
const createSwitchPassportAuth = require('./routes/auth/switch-passport');
const createConnectOwnerAuth = require('./routes/auth/connect-owner');
const createVerifyOwnerAuth = require('./routes/auth/verify-owner');
const createAcceptServerAuth = require('./routes/auth/accept-server');
const createIssuePassportAuth = require('./routes/auth/issue-passport');
const createLostPassportListAuth = require('./routes/auth/lost-passport-list');
const createLostPassportIssueAuth = require('./routes/auth/lost-passport-issue');
const createInviteAuth = require('./routes/auth/invite');
const createLoginDebosLaunchAuth = require('./routes/auth/login-debos-launch');
const googleDebosLaunchRoutes = require('./routes/auth/google-debos-launch');
const createLaunchFreeBlockletBySessionAuth = require('./routes/auth/launch-free-blocklet-by-session');
const createLaunchFreeBlockletByLauncherAuth = require('./routes/auth/launch-free-blocklet-by-launcher');
const createBindWalletAuth = require('./routes/auth/bind-wallet');
const createDelegateTransferOwnerNFTAuth = require('./routes/auth/delegate-transfer-owner-nft');
const createVerifyAppOwnershipAuth = require('./routes/auth/verify-app-ownership');
const createRotateKeyPairAuth = require('./routes/auth/rotate-key-pair');
const createMigrateAppToStructV2Auth = require('./routes/auth/migrate-app-to-struct-v2');
const verifyRestoreServerlessNftAuth = require('./routes/auth/verify-restore-by-nft');
const createVerifyElevatedAuth = require('./routes/auth/verify-elevated');
const createVerifyDestroyAuth = require('./routes/auth/verify-destroy');

const sessionRoutes = require('./routes/session');
const didConnectRoutes = require('./routes/did-connect');
const blockletInfoRoutes = require('./routes/blocklet-info');
const blockletServiceMediaRoutes = require('./routes/media');
const blockletSeoRoutes = require('./routes/blocklet-seo');
const blockletPreferenceRoutes = require('./routes/blocklet-preference');
const blockletProjectRoutes = require('./routes/blocklet-project');
const blockletProxyRoutes = require('./routes/blocklet-proxy');
const blockletOauthRoutes = require('./routes/blocklet-oauth');
const passportRoutes = require('./routes/passport');
const didResolverRoutes = require('./routes/did-resolver');
const dnsResolverRoutes = require('./routes/dns-resolver');
const blacklistRoutes = require('./routes/blacklist');
const userRoutes = require('./routes/user');
const logRoutes = require('./routes/log');
const launchRoutes = require('./routes/launch');
const pwaManifestRoutes = require('./routes/manifest');
const analyticsRoutes = require('./routes/analytics');
const passkeyRoutes = require('./routes/passkey');
const healthCheckRoutes = require('./routes/health');
const { getBaseUrl } = require('./util');

process.on('unhandledRejection', (reason, promise) => {
  // If it's a SQLite “database is locked” error, just log and continue
  if (reason && (reason.code === 'SQLITE_BUSY' || reason.message.includes('SQLITE_BUSY'))) {
    console.error('SQLite busy, skipping exit:', reason.message);
    return;
  }

  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const getLoginTokenFromCookie = cookies => {
  if (cookies) {
    try {
      // Parse the cookies
      const parsedCookies = Cookie.parse(cookies || '');
      if (parsedCookies?.login_token) {
        return parsedCookies.login_token;
      }
      return null;
    } catch (err) {
      logger.error('Failed to parse login_token from cookie', { error: err });
      return null;
    }
  }
  return null;
};

const generateETag = content => {
  const hash = crypto.createHash('sha1');
  hash.update(content);
  return `W/"${hash.digest('base64')}"`;
};

module.exports = function createServer(node) {
  const isTestBuild = process.env.TEST_BUILD && JSON.parse(process.env.TEST_BUILD);
  const isProduction = process.env.NODE_ENV === 'production' || isTestBuild;

  if (!process.env.ABT_NODE_DATA_DIR) {
    throw new Error('Cannot start application without process.env.ABT_NODE_DATA_DIR');
  }
  process.env.ABT_NODE_DATA_DIR = expandTilde(process.env.ABT_NODE_DATA_DIR);

  let nodeMode = '';

  context.set('node', node);

  // Create and config express application
  const app = express();
  const maxUploadSize = Number(process.env.MAX_UPLOAD_FILE_SIZE) || MAX_UPLOAD_FILE_SIZE;

  app.set('trust proxy', 'loopback');
  // FIXME: webapp 暂不具备配置 security headers 的能力，先保留这个 disable
  app.disable('x-powered-by');
  app.use(cors());
  app.use(cookieParser());
  app.use(
    bodyParser.json({
      limit: `${maxUploadSize}mb`,
      verify: (req, res, buf) => {
        try {
          JSON.parse(buf);
        } catch (e) {
          res.status(400).json('JSON parse error');
          throw new CustomError(400, 'JSON parse error');
        }
      },
    })
  );
  app.use(bodyParser.urlencoded({ extended: true, limit: `${maxUploadSize}mb` }));

  app.use(async (req, res, next) => {
    if (!nodeMode) {
      const info = await node.getNodeInfo();
      nodeMode = info.mode || NODE_MODES.PRODUCTION;
    }

    req.nodeMode = nodeMode;

    next();
  });

  app.get('/error/502', async (req, res) => {
    try {
      res.type('html');
      res.status(502);

      const blockletDid = req.get('x-did');
      const nodeInfo = await node.getNodeInfo();
      const info = { version: nodeInfo.version, mode: nodeInfo.mode };

      if (blockletDid) {
        const blocklet = await node.getBlocklet({ did: blockletDid, attachConfig: false });
        if (!blocklet) {
          return res.send(get502Template(info));
        }

        return res.send(getBlockletNotRunningTemplate(blocklet, nodeInfo));
      }

      return res.send(get502Template(info));
    } catch (error) {
      logger.error('render 502 page failed', { error });
      return res.send('502 Error');
    }
  });

  log.setupAccessLogger(app, isProduction ? log.getAccessLogStream(process.env.ABT_NODE_LOG_DIR) : undefined);

  app.use(bearerToken());
  app.use(async (req, res, next) => {
    const { token, headers } = req;

    if (token) {
      if (isLoginToken(token)) {
        try {
          // request by login user
          const user = await authWithJwt(token, node);
          // parse user avatar
          if (user && user.avatar && user.avatar.startsWith(USER_AVATAR_URL_PREFIX)) {
            const nodeInfo = await node.getNodeInfo();

            const adminPath =
              process.env.NODE_ENV === 'development' ? '' : nodeInfo.routing?.adminPath || WELLKNOWN_SERVER_ADMIN_PATH;

            user.avatar = joinURL(
              adminPath,
              USER_AVATAR_PATH_PREFIX,
              nodeInfo.did,
              user.avatar.split('/').slice(-1)[0]
            );
          }

          req.user = user;
        } catch (error) {
          // Do nothing
        }
      } else if (isAccessKey(token)) {
        try {
          const user = await authBySimpleAccessKey(token, node);

          req.user = user;
        } catch (error) {
          res.status(error.status || 400).jsonp({ error: error.message });
          return;
        }
      }
    } else if (headers['x-access-key-id'] && headers['x-access-signature']) {
      // 针对 SDK 的请求都会走到这里
      // request by accessKey
      try {
        const user = await authWithAccessKeySignature({
          keyId: headers['x-access-key-id'],
          stamp: headers['x-access-stamp'],
          signature: headers['x-access-signature'],
          node,
          blockletDid: headers['x-access-blocklet'],
          componentDid: headers['x-component-did'],
          alg: headers['x-access-alg'],
          token: getLoginTokenFromCookie(headers.cookie), // 在需要 token 认证的时候需要传入
        });
        req.user = user;
      } catch (error) {
        logger.error('authWithAccessKeySignature error', error);
        res.status(error.status || 400).jsonp({ error: error.message });
        return;
      }
    } else if (headers['x-launcher-sig']) {
      // request by launcher
      const user = await authWithLauncherSignature(headers['x-launcher-sig'], node);
      req.user = user;
    }

    restrictGuestDashboardSession(req);

    next();
  });

  app.use((req, res, next) => {
    setUserInfoHeaders(req);
    next();
  });
  app.use(certificateManager.createRoutes(node.dataDirs.certManagerModule));

  const router = express.Router();

  handlers.attach(Object.assign({ app: router }, createLoginAuth(node)));
  handlers.attach(Object.assign({ app: router }, createExchangePassportAuth(node)));
  handlers.attach(Object.assign({ app: router }, createSwitchProfileAuth(node)));
  handlers.attach(Object.assign({ app: router }, createSwitchPassportAuth(node)));
  handlers.attach(Object.assign({ app: router }, createConnectOwnerAuth(node)));
  handlers.attach(Object.assign({ app: router }, createConnectToDidSpacesRoute(node)));
  handlers.attach(Object.assign({ app: router }, createVerifyOwnerAuth(node)));
  handlers.attach(Object.assign({ app: router }, createAcceptServerAuth(node)));
  handlers.attach(Object.assign({ app: router }, createIssuePassportAuth(node)));
  handlers.attach(Object.assign({ app: router }, createLostPassportListAuth(node)));
  handlers.attach(Object.assign({ app: router }, createLostPassportIssueAuth(node)));
  handlers.attach(Object.assign({ app: router }, createInviteAuth(node)));
  handlers.attach(Object.assign({ app: router }, createLoginDebosLaunchAuth(node)));
  googleDebosLaunchRoutes.init(router, node);
  handlers.attach(Object.assign({ app: router }, createVerifyAppOwnershipAuth(node, 'spaces')));
  handlers.attach(Object.assign({ app: router }, createVerifyAppOwnershipAuth(node, 'disk')));
  handlers.attach(Object.assign({ app: router }, createRotateKeyPairAuth(node)));
  handlers.attach(Object.assign({ app: router }, createLaunchFreeBlockletBySessionAuth(node)));
  handlers.attach(Object.assign({ app: router }, createLaunchFreeBlockletByLauncherAuth(node)));
  handlers.attach(Object.assign({ app: router }, createBindWalletAuth(node)));
  handlers.attach(Object.assign({ app: router }, createDelegateTransferOwnerNFTAuth(node)));
  handlers.attach(Object.assign({ app: router }, createMigrateAppToStructV2Auth(node)));
  handlers.attach(Object.assign({ app: router }, verifyRestoreServerlessNftAuth(node)));
  handlers.attach(Object.assign({ app: router }, createVerifyElevatedAuth(node)));
  handlers.attach(Object.assign({ app: router }, createVerifyDestroyAuth(node)));

  sessionRoutes.init(router, node);
  didConnectRoutes.init(router, node);
  blockletInfoRoutes.init(router, node);
  blockletServiceMediaRoutes.init(router, node);
  blockletSeoRoutes.init(router, node);
  blockletPreferenceRoutes.init(router, node);
  blockletProjectRoutes.init(router, node);
  blockletProxyRoutes.init(router, node);
  blockletOauthRoutes.init(router, node);
  passportRoutes.init(router, node);
  didResolverRoutes.init(router, node);
  dnsResolverRoutes.init(router, node);
  blacklistRoutes.init(router, node);
  createInvite.init(app, node, { prefix: '/api' });
  userRoutes.init(router, node);
  logRoutes.init(router, node);
  launchRoutes.init(router, node);
  pwaManifestRoutes.init(router, node);
  analyticsRoutes.init(router, node);
  passkeyRoutes.init(router, node);
  healthCheckRoutes.init(router, node);

  // serve abt node gql
  const gqlConfig = gql.genConfig(node);
  app.use(
    '/api/gql',
    graphqlUploadExpress({ maxFileSize: maxUploadSize * 1024 * 1024, maxFiles: 10 }),
    protectGQL(node, gqlConfig),
    gql(gqlConfig, !isProduction)
  );

  // A simple websocket router
  const wsRoutingRules = [];
  const wsRouter = {
    use(mountPoint, handler) {
      wsRoutingRules.push({ path: mountPoint, handle: handler });
    },
  };

  const httpServer = http.createServer(app);
  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'unknown'}`);
    const routes = wsRoutingRules.filter(x => minimatch(normalizePathPrefix(pathname), normalizePathPrefix(x.path)));

    let routeIndex = 0;
    const next = () => {
      const route = routes[routeIndex];
      if (route) {
        routeIndex++;
        route.handle(req, socket, head, next);
      }
    };

    next();
  });

  const wsServer = createWebSocketServer({ node });
  const relayServer = createRelayServer({ node });

  wsServer.attachWs(wsRouter);
  relayServer.attachWs(wsRouter);
  relayServer.attachHttp(router);

  if (isProduction) {
    app.use(router);

    const staticDir = path.resolve(__dirname, './dist');

    app.use(express.static(staticDir, { maxAge: '365d', index: false }));

    app.use(async (req, res, next) => {
      try {
        // res.sendFile('index.html', { root: staticDir });
        // return;
        const filePath = staticDir ? path.join(staticDir, 'index.html') : 'index.html';
        if (
          !(req.method === 'GET' || req.method === 'HEAD') ||
          !req.accepts('html') ||
          RESOURCE_PATTERN.test(req.path)
        ) {
          next();
          return;
        }

        let source = await fs.promises.readFile(filePath, 'utf8');
        const baseUrl = getBaseUrl(req);
        if (baseUrl) {
          source = source.replace('<base href="/"', `<base href="${baseUrl}"`);
        }
        const HEAD_END_TAG = '</head>';
        // Inject theme styles and script
        const themeStyles = buildThemeStyles();
        const themeScript = buildThemeScript({ prefer: 'system' });

        // 注入主题样式
        if (!source.includes('<style id="blocklet-theme">')) {
          source = source.replace(HEAD_END_TAG, `${themeStyles}${HEAD_END_TAG}`);
        }

        // 注入主题切换脚本
        if (!source.includes('<script id="blocklet-theme-script">')) {
          source = source.replace(HEAD_END_TAG, `${themeScript}${HEAD_END_TAG}`);
        }
        const etag = generateETag(source);
        res.setHeader('Surrogate-Control', 'no-store');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Expires', '0');

        res.setHeader('X-Cache', 'MISS');
        res.setHeader('ETag', etag);

        res.type('html');
        res.send(source);
      } catch (error) {
        logger.error('render index.html failed', { error });
        next(error);
      }
    });

    app.use((req, res) => {
      res.status(404).send('NOT FOUND');
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      logger.error('Something broke', { error: err });
      res.status(getStatusFromError(err)).send(`Daemon: Something broke! ${err.message}`);
    });
  } else {
    app.use(router);
  }

  httpServer.app = app;

  return httpServer;
};
