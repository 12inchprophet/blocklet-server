const path = require('path');
const fs = require('fs-extra');
const express = require('express');
const get = require('lodash/get');
const camelCase = require('lodash/camelCase');
const pick = require('lodash/pick');
const defaults = require('lodash/defaults');
const isEmpty = require('lodash/isEmpty');
const omitBy = require('lodash/omitBy');
const cors = require('cors');
const md5 = require('@abtnode/util/lib/md5');
const { isValid: isValidDid } = require('@arcblock/did');

const { toBase58 } = require('@ocap/util');
const { getBlockletLogos } = require('@abtnode/util/lib/blocklet');
const { signResponse } = require('@blocklet/meta/lib/security');
const { getBlurhash } = require('@blocklet/images');
const {
  attachSendLogoContext,
  ensureBlockletExist,
  ensureCustomSquareLogo,
  ensureCustomSquareDarkLogo,
  ensureBundleLogo,
  fallbackLogo,
  ensureCustomFavicon,
  ensureCustomRectLogo,
  ensureCustomRectDarkLogo,
  ensureCustomSplashPortrait,
  ensureCustomSplashLandscape,
  cacheError,
  ensureCustomOgImage,
} = require('@abtnode/util/lib/logo-middleware');
const normalizePathPrefix = require('@abtnode/util/lib/normalize-path-prefix');
const {
  BLOCKLET_PREFERENCE_PREFIX,
  fromBlockletStatus,
  BLOCKLET_CONFIGURABLE_KEY,
  BLOCKLET_TENANT_MODES,
  BUILTIN_PROVIDER_PUBLIC_FIELDS,
  LOGIN_PROVIDER,
  OAUTH_PROVIDER_PUBLIC_FIELDS,
} = require('@blocklet/constant');
const { getBlockletInfo } = require('@blocklet/meta/lib/info');
const { isPreferenceKey, findComponentById, findComponentByIdV2, getMountPoints } = require('@blocklet/meta/lib/util');
const { getConfigs } = require('@blocklet/meta/lib/util-config');
const { getBlockletLanguages } = require('@blocklet/env/lib/util');
const {
  DEBOS_BLOCKLET_DID,
  SESSION_CACHE_TTL,
  SESSION_TTL,
  WELLKNOWN_SERVICE_PATH_PREFIX,
} = require('@abtnode/constant');
const { getEmailServiceProvider } = require('@abtnode/auth/lib/email');
const { withTrailingSlash } = require('ufo');
const { onUploadComponent } = require('@abtnode/util/lib/upload-component');
const { blockletInfoShortCache, getBlockletInfoCachePrefixKey } = require('@abtnode/util/lib/blocklet-cache');

const { initLocalStorageServer } =
  process.env.NODE_ENV === 'test'
    ? { initLocalStorageServer: () => ({ handle: () => {} }) }
    : // eslint-disable-next-line import/no-unresolved
      require('@blocklet/uploader-server');

const logger = require('@abtnode/logger')(require('../../package.json').name);

const { wallet } = require('../libs/auth');
const { getBlockletNavigation } = require('../util/navigation');
const mutateBlockletPermission = require('../middlewares/mutate-blocklet-permission');

const getEnvironmentValue = (blocklet, key) =>
  blocklet?.environmentObj?.[key] || (blocklet?.environments || []).find(item => item.key === key)?.value;

const isDebosBlocklet = ({ blocklet, component, componentId }) => {
  const dids = [
    blocklet?.did,
    blocklet?.appDid,
    blocklet?.appPid,
    blocklet?.meta?.did,
    component?.did,
    component?.appDid,
    component?.appPid,
    component?.meta?.did,
    getEnvironmentValue(blocklet, 'BLOCKLET_COMPONENT_DID'),
    ...String(componentId || '')
      .split('/')
      .filter(Boolean),
    ...(blocklet?.componentMountPoints || []).map(item => item.did),
    ...(blocklet?.children || []).map(item => item?.meta?.did || item?.did),
  ].filter(Boolean);

  try {
    dids.push(...(getMountPoints(blocklet) || []).map(item => item?.did || item?.meta?.did).filter(Boolean));
  } catch (err) {
    logger.debug('Failed to inspect blocklet mount points for DeBOS auth metadata', { err });
  }

  return dids.includes(DEBOS_BLOCKLET_DID);
};

const withDebosGoogleAuthentication = (authentication, { blocklet, component, componentId }) => {
  if (!isDebosBlocklet({ blocklet, component, componentId })) {
    return authentication;
  }

  const providers = Object.values(authentication || {});
  const maxOrder = providers.reduce((max, item) => Math.max(max, Number.isFinite(item?.order) ? item.order : -1), -1);
  return {
    ...authentication,
    [LOGIN_PROVIDER.GOOGLE]: {
      enabled: true,
      order: authentication?.[LOGIN_PROVIDER.GOOGLE]?.order ?? maxOrder + 1,
      type: 'oauth',
    },
  };
};

const getLogoKey = type => {
  if (type === 'favicon') {
    return BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_LOGO_FAVICON;
  }
  if (type === 'rect') {
    return BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_LOGO_RECT;
  }
  if (type === 'rect-dark') {
    return BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_LOGO_RECT_DARK;
  }
  if (type === 'square-dark') {
    return BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_LOGO_SQUARE_DARK;
  }
  if (type === 'splash-portrait') {
    return BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_SPLASH_PORTRAIT;
  }
  if (type === 'splash-landscape') {
    return BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_SPLASH_LANDSCAPE;
  }
  if (type === 'og-image') {
    return BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_OG_IMAGE;
  }
  return BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_LOGO_SQUARE;
};

module.exports = {
  init(app, node) {
    // logo

    const isDev = process.env.NODE_ENV === 'development';
    // staticDir in development is ../../public
    const staticDir = isDev ? path.resolve(__dirname, '../../public') : path.resolve(__dirname, './dist');

    const onSendFallbackLogo = ({ res, sendOptions }) => {
      res.sendFile('/images/blocklet.png', { root: staticDir, ...sendOptions });
    };

    const onSendFallbackSplashPortrait = ({ res, sendOptions }) => {
      res.sendFile('/images/splash-portrait.png', { root: staticDir, ...sendOptions });
    };

    const onSendFallbackSplashLandscape = ({ res, sendOptions }) => {
      res.sendFile('/images/splash-landscape.png', { root: staticDir, ...sendOptions });
    };

    const onSendFallbackOgImage = ({ res, sendOptions }) => {
      res.sendFile('/images/og-image.jpg', { root: staticDir, ...sendOptions });
    };

    const attachSendLogoFn = (req, res, next) => {
      res.sendLogoFile = res.sendFile;
      next();
    };

    const logoWorkflow = (...chain) => [
      attachSendLogoContext({
        onSendFallbackLogo,
        onGetBlocklet: ({ req, res }) => {
          const { did } = req.params;
          if (!isValidDid(did)) {
            res.status(400).json({ code: 'bad_request', error: 'The provided blocklet DID format is invalid' });
            return undefined;
          }
          return node.getBlocklet({ did });
        },
      }),
      attachSendLogoFn,
      ensureBlockletExist,
      ...chain,
      cacheError,
    ];

    app.get('/blocklet/logo/:did', ...logoWorkflow(ensureCustomSquareLogo, ensureBundleLogo, fallbackLogo));
    app.get(
      '/blocklet/logo-dark/:did',
      ...logoWorkflow(ensureCustomSquareDarkLogo, ensureCustomSquareLogo, ensureBundleLogo, fallbackLogo)
    );
    app.get(
      '/blocklet/logo-favicon/:did',
      ...logoWorkflow(ensureCustomFavicon, ensureCustomSquareLogo, ensureBundleLogo, fallbackLogo)
    );
    app.get(
      '/blocklet/logo-rect/:did',
      ...logoWorkflow(ensureCustomRectLogo, ensureCustomSquareLogo, ensureBundleLogo, fallbackLogo)
    );
    app.get(
      '/blocklet/logo-rect-dark/:did',
      ...logoWorkflow(
        ensureCustomRectDarkLogo,
        ensureCustomSquareDarkLogo,
        ensureCustomRectLogo,
        ensureCustomSquareLogo,
        ensureBundleLogo,
        fallbackLogo
      )
    );
    app.get(
      '/blocklet/splash/portrait/:did',
      ...logoWorkflow(ensureCustomSplashPortrait, onSendFallbackSplashPortrait)
    );
    app.get(
      '/blocklet/splash/landscape/:did',
      ...logoWorkflow(ensureCustomSplashLandscape, onSendFallbackSplashLandscape)
    );
    app.get('/blocklet/og-image/:did', ...logoWorkflow(ensureCustomOgImage, onSendFallbackOgImage));

    app.get(
      '/blocklet/logo-bundle/**',
      attachSendLogoContext({
        onSendFallbackLogo,
        onGetBlocklet: async ({ req, res }) => {
          const dids = req.url.split('?')[0].replace('/blocklet/logo-bundle/', '').split('/').filter(Boolean);
          if (!isValidDid(dids[0])) {
            res.status(400).json({ code: 'bad_request', error: 'The provided blocklet DID format is invalid' });
            return undefined;
          }
          const blocklet = await node.getBlocklet({ did: dids[0] });
          return findComponentById(blocklet, dids);
        },
      }),

      attachSendLogoFn,
      ensureBlockletExist,
      ensureBundleLogo,
      fallbackLogo,
      cacheError
    );

    // logo-uploader

    const localStorageServer = initLocalStorageServer({
      path: node.dataDirs.tmp,
      express,
      onUploadFinish: (req, res, uploadMetadata) => {
        // 通过中间件预先设置的处理函数来处理上传
        if (typeof req.handleUpload !== 'function') {
          throw new Error('Upload handler not found');
        }
        return req.handleUpload(uploadMetadata);
      },
    });

    /**
     * 处理 logo 图片上传
     */
    const handleLogoUpload = async (req, uploadMetadata) => {
      const {
        id: filename,
        size,
        metadata: { filename: originalname, filetype: mimetype },
      } = uploadMetadata;

      const srcFile = path.join(node.dataDirs.tmp, filename);
      if (!fs.existsSync(srcFile)) {
        throw new Error(`file not found: ${filename}`);
      }

      const { did, logoType } = req;
      const blocklet = await node.getBlocklet({ did });

      // update logo config
      const key = getLogoKey(logoType);
      await node.configBlocklet({
        did,
        configs: [
          {
            key,
            value: filename,
          },
        ],
      });

      // update logo file
      const destDir = path.join(blocklet.env.dataDir);
      await fs.ensureDir(destDir);
      await fs.copy(srcFile, path.join(destDir, filename));

      // update blurhash
      const blurhash = await getBlurhash(srcFile);
      const exist = await node.getBlockletBlurhash({ did });
      await node.setBlockletBlurhash({
        did,
        blurhash: { ...exist, [camelCase(logoType)]: blurhash },
      });

      return { filename, size, originalname, mimetype };
    };

    /**
     * 处理 org avatar 图片上传的逻辑
     */
    const ORG_AVATAR_MAX_SIZE = 5 * 1024 * 1024; // 5MB
    const ORG_AVATAR_ALLOWED_TYPES = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/bmp',
      'image/x-icon',
    ];

    const handleOrgAvatarUpload = async (req, uploadMetadata) => {
      const {
        id: filename,
        size,
        metadata: { filename: originalname, filetype: mimetype },
      } = uploadMetadata;

      // 验证文件类型
      if (!ORG_AVATAR_ALLOWED_TYPES.includes(mimetype)) {
        throw new Error(`Invalid file type: ${mimetype}. Allowed types: ${ORG_AVATAR_ALLOWED_TYPES.join(', ')}`);
      }

      // 验证文件大小
      if (size > ORG_AVATAR_MAX_SIZE) {
        throw new Error(`File size ${size} exceeds maximum allowed size ${ORG_AVATAR_MAX_SIZE} bytes`);
      }

      const srcFile = path.join(node.dataDirs.tmp, filename);
      if (!fs.existsSync(srcFile)) {
        throw new Error(`file not found: ${filename}`);
      }

      const { did } = req;

      const blocklet = await node.getBlocklet({ did });

      // 防止路径遍历攻击：对 filename 进行清理
      const sanitizedFilename = path.basename(filename);

      // 临时存储目录（直接在 orgs 下）
      const tempDir = path.join(blocklet.env.dataDir, 'orgs');

      // 确保路径在预期目录内
      const expectedDir = path.join(blocklet.env.dataDir, 'orgs');
      const destFilePath = path.join(tempDir, sanitizedFilename);

      if (!destFilePath.startsWith(expectedDir)) {
        throw new Error('invalid path');
      }

      await fs.ensureDir(tempDir);

      // 复制文件到临时目录
      await fs.copy(srcFile, destFilePath);

      // 返回文件名供前端使用（前端将在创建/更新 org 时提交这个文件名）
      return { avatarPath: sanitizedFilename, size, originalname, mimetype };
    };

    /**
     * 处理组件上传
     */
    const handleComponentUpload = async (req, uploadMetadata) => {
      const { did, user } = req;
      const blocklet = await node.getBlocklet({ did, useCache: true });
      try {
        return onUploadComponent(node, uploadMetadata, blocklet, user);
      } catch (error) {
        logger.error('handleComponentUpload failed', { did, error });
        throw new Error(error.message || 'upload component failed');
      }
    };

    const ensurePermission = mutateBlockletPermission(node);
    const ensureBlocklet = async (req, res, next) => {
      const { did, logoType, orgId } = req.params;
      if (!did) {
        return res.status(400).json({ code: 'bad_request', error: 'no blocklet did' });
      }

      if (!isValidDid(did)) {
        return res.status(400).json({ code: 'bad_request', error: 'The provided blocklet DID format is invalid' });
      }

      req.blocklet = await node.getBlocklet({ did, useCache: true });
      if (!req.blocklet) {
        return res.status(400).json({ code: 'bad_request', error: 'blocklet not found' });
      }

      if (orgId) {
        req.orgId = orgId;
      }

      req.did = did;
      req.logoType = logoType;
      return next();
    };

    // 处理 logo 图片上传的逻辑
    app.use(
      '/blocklet/logo/upload/:logoType/:did',
      ensurePermission,
      ensureBlocklet,
      (req, res, next) => {
        req.handleUpload = handleLogoUpload.bind(null, req);
        return next();
      },
      localStorageServer.handle
    );

    // 处理 org avatar 图片上传的逻辑（不需要 orgId，前端将在创建/更新时提交）
    app.use(
      '/blocklet/:did/orgs/avatar/upload',
      ensureBlocklet,
      (req, res, next) => {
        req.handleUpload = handleOrgAvatarUpload.bind(null, req);
        return next();
      },
      localStorageServer.handle
    );

    // 获取 org avatar 图片
    app.get('/blocklet/:did/orgs/avatar/:filename', async (req, res) => {
      try {
        const { did, filename } = req.params;

        if (!did || !isValidDid(did)) {
          return res.status(400).json({ code: 'bad_request', error: 'invalid blocklet did' });
        }

        // 防止路径遍历攻击：对 filename 进行清理
        const sanitizedFilename = path.basename(filename);

        const blocklet = await node.getBlocklet({ did, useCache: true });
        if (!blocklet) {
          return res.status(404).json({ code: 'not_found', error: 'blocklet not found' });
        }

        const avatarPath = path.resolve(blocklet.env.dataDir, 'orgs', sanitizedFilename);

        // 确保路径在预期目录内
        const expectedDir = path.resolve(blocklet.env.dataDir, 'orgs');

        if (!avatarPath.startsWith(expectedDir)) {
          return res.status(400).json({ code: 'bad_request', error: 'invalid path' });
        }

        if (!fs.existsSync(avatarPath)) {
          return res.status(404).json({ code: 'not_found', error: 'avatar not found' });
        }

        return res.sendFile(avatarPath);
      } catch (error) {
        logger.error('Failed to get org avatar', { error });
        return res.status(500).json({ code: 'internal_error', error: error.message });
      }
    });
    // 处理组件上传的逻辑
    app.use(
      '/blocklet/component/upload/:did',
      ensurePermission,
      ensureBlocklet,
      (req, res, next) => {
        req.handleUpload = handleComponentUpload.bind(null, req);
        return next();
      },
      localStorageServer.handle
    );

    // blocklet.js

    async function getBlockletData(req) {
      const did = req.headers['x-blocklet-did'] || '';
      if (!did) {
        return [[], null];
      }

      const componentId = req.headers['x-blocklet-component-id'] || '';
      const pathPrefix = normalizePathPrefix(req.headers['x-path-prefix']) || '/';
      const groupPathPrefix = normalizePathPrefix(req.headers['x-group-path-prefix']) || '/';
      const pageGroup = req.headers['x-page-group'] || '';

      let configs = [];
      let server = {};
      let blocklet = {};
      let component = {};
      let name;
      let description;
      let status;
      let appId;
      let appPk;
      let appPid;
      let appUrl;
      let tenantMode = BLOCKLET_TENANT_MODES.SINGLE;
      let passportColor;
      let languages = getBlockletLanguages('en');
      let alsoKnownAs = [];
      let trustedFactories = [];
      let settings = {};
      let domainAliases = [];
      let blurhash = {};

      try {
        [blocklet, server, blurhash] = await Promise.all([
          node.getBlocklet({ did, useCache: true, getOptionalComponents: true }),
          node.getNodeInfo({ useCache: true }),
          node.getBlockletBlurhash({ did }),
        ]);
        if (!blocklet) {
          return [[], null];
        }

        domainAliases = await node.getBlockletDomainAliases({ blocklet, nodeInfo: server });
        domainAliases = (domainAliases || []).map(x => x.value);
        component = findComponentByIdV2(blocklet, componentId);
        configs = getConfigs(blocklet, componentId);
        // NOTICE: 这里必须要 return wallet，才能获取到 appPk
        const blockletInfo = getBlockletInfo(blocklet, server.sk, { returnWallet: true });
        name = blockletInfo.name;
        description = blockletInfo.description;
        passportColor = blockletInfo.passportColor;
        tenantMode = blockletInfo.tenantMode;
        appId = blocklet.appDid;
        appPid = blocklet.appPid || appId;
        appUrl = blocklet.environmentObj?.BLOCKLET_APP_URL;
        status = fromBlockletStatus(blocklet.status);
        languages = getBlockletLanguages(blocklet.environmentObj?.BLOCKLET_APP_LANGUAGES);
        const federatedMaster = (blocklet.settings?.federated?.sites || []).find(item => item.isMaster !== false);
        const federatedCurrent = (blocklet.settings?.federated?.sites || []).find(item => item.appId === appId);
        const federatedConfig = blocklet.settings?.federated?.config || {};
        const org = blocklet.settings?.org || { enabled: false };
        const isEmailServiceEnabled = Boolean(getEmailServiceProvider(blocklet));

        let authentication = pick(
          omitBy(blocklet.settings?.authentication || {}, x => x.enabled !== true),
          [...OAUTH_PROVIDER_PUBLIC_FIELDS, ...BUILTIN_PROVIDER_PUBLIC_FIELDS]
        );
        authentication = withDebosGoogleAuthentication(authentication, { blocklet, component, componentId });
        const didConnect = blocklet.settings?.didConnect ?? {
          showDidColor: true,
          showAppInfo: true,
        };
        const actionConfig = blocklet.settings?.actionConfig ?? {};
        settings = {
          session: defaults(pick(blocklet.settings?.session || {}, ['ttl', 'cacheTtl']), {
            ttl: SESSION_TTL,
            cacheTtl: SESSION_CACHE_TTL, // 1h
          }),
          invite: blocklet.settings?.invite || { enabled: false },
          federated: {
            master: pick(federatedMaster, [
              'appId',
              'appPk',
              'appPid',
              'appName',
              'appDescription',
              'appUrl',
              'appLogo',
              'version',
            ]),
            config: {
              status: federatedCurrent?.status,
              // FIXME: 暂时先保留，之后移除 autoLogin 相关逻辑
              autoLogin: federatedConfig.autoLogin,
            },
          },
          // DEPRECATED: 已被 authentication 替代，后续移除，当前仅作旧版本兼容
          oauth: pick(blocklet.settings?.oauth || {}, OAUTH_PROVIDER_PUBLIC_FIELDS),
          authentication,
          didConnect,
          actionConfig,
          kyc: {
            email: blocklet.settings?.session?.email?.enabled && blocklet.settings?.session?.email?.requireVerified,
          },
          notification: {
            email: {
              enabled: isEmailServiceEnabled,
            },
            toastAlert: Boolean(blocklet.settings?.notification?.toastAlert),
          },
          org,
        };
        alsoKnownAs = (blocklet.migratedFrom || []).map(x => x.appDid);
        trustedFactories = (blocklet.trustedFactories || []).map(x => x.factoryAddress);
        appPk = toBase58(blockletInfo.wallet.publicKey);
      } catch (error) {
        logger.error('get __blocklet__.js failed', { did, componentId, error });
      }

      const { appLogo, appLogoDark, appLogoRect, appLogoRectDark, appSplashPortrait, appSplashLandscape } =
        getBlockletLogos(blocklet);

      const env = [
        ...configs.filter(x => !isPreferenceKey(x)),

        // Unify with backend sdk
        { key: 'appId', value: appId },
        { key: 'appPk', value: appPk },
        { key: 'appPid', value: appPid },
        { key: 'appName', value: name },
        { key: 'status', value: status },
        { key: 'tenantMode', value: tenantMode },
        { key: 'appDescription', value: description },
        { key: 'appUrl', value: appUrl },
        { key: 'domainAliases', value: domainAliases },
        { key: 'isComponent', value: did !== componentId },
        { key: 'alsoKnownAs', value: alsoKnownAs },
        { key: 'passportColor', value: passportColor },
        { key: 'trustedFactories', value: trustedFactories },
        { key: 'serverDid', value: server.did },
        { key: 'serverVersion', value: server.version },

        // Web only
        { key: 'prefix', value: pathPrefix },
        { key: 'groupPrefix', value: groupPathPrefix },
        { key: 'pageGroup', value: pageGroup },
        { key: 'version', value: get(component, 'meta.version', '') },
        { key: 'componentId', value: componentId },
        { key: 'did', value: did }, // deprecated
        { key: 'appLogo', value: appLogo },
        { key: 'appLogoDark', value: appLogoDark },
        { key: 'appLogoRect', value: appLogoRect },
        { key: 'appLogoRectDark', value: appLogoRectDark },
        { key: 'appSplashPortrait', value: appSplashPortrait },
        { key: 'appSplashLandscape', value: appSplashLandscape },
        { key: 'blurhash', value: blurhash },
        { key: 'webWalletUrl', value: server.webWalletUrl },

        {
          key: 'preferences',
          value: configs
            .filter(x => isPreferenceKey(x))
            .reduce((acc, x) => {
              acc[x.key.replace(BLOCKLET_PREFERENCE_PREFIX, '')] = x.value;
              return acc;
            }, {}),
        },
        { key: 'languages', value: languages },
        { key: 'settings', value: settings },
        { key: 'updatedAt', value: Date.now() },
      ];

      if (get(blocklet, 'meta.theme')) {
        env.push({ key: 'theme', value: blocklet.meta.theme });
      }

      const copyright = {};
      if (blocklet?.environmentObj?.BLOCKLET_APP_COPYRIGHT_OWNER) {
        copyright.owner = blocklet.environmentObj.BLOCKLET_APP_COPYRIGHT_OWNER;
      }
      if (blocklet?.environmentObj?.BLOCKLET_APP_COPYRIGHT_YEAR) {
        copyright.year = blocklet.environmentObj.BLOCKLET_APP_COPYRIGHT_YEAR;
      }
      if (!isEmpty(copyright)) {
        env.push({ key: 'copyright', value: copyright });
      } else if (get(blocklet, 'meta.copyright')) {
        env.push({ key: 'copyright', value: blocklet.meta.copyright });
      }

      env.push({ key: 'navigation', value: getBlockletNavigation(blocklet, groupPathPrefix) });
      env.push({ key: 'theme', value: blocklet.settings?.theme ?? {} });
      env.push({ key: 'optionalComponents', value: blocklet.optionalComponents });
      env.push({ key: 'enableDocker', value: blocklet.enableDocker });
      env.push({ key: 'enableDockerNetwork', value: blocklet.enableDockerNetwork });

      const componentMountPoints = getMountPoints(blocklet);
      env.push({ key: 'componentMountPoints', value: componentMountPoints });

      if (req.query.owner === '1') {
        const owner = await node.getOwner({ teamDid: appPid });
        env.push({ key: 'ownerDid', value: owner?.did });
      }

      if (component?.mode === 'development') {
        env.push({
          key: 'mode',
          value: 'development',
        });
      }

      const sharedComponents = (blocklet?.children || []).filter(child => {
        const enabledShared = child?.configs?.find(x => {
          if (x.key === 'SERVICE_WORKER_SHARING_ENABLED' && x.value === 'true') {
            return true;
          }
          return false;
        });
        return !!enabledShared;
      });
      const mountPoints = componentMountPoints.map(x => withTrailingSlash(x.mountPoint));
      const sharedMountPoints = sharedComponents.map(x => withTrailingSlash(x.mountPoint));

      env.push({
        key: 'sw',
        value: {
          options:
            component?.meta && component?.mountPoint
              ? {
                  did: component.meta.did,
                  scope: component.mountPoint,
                  mountPoints,
                  sharedMountPoints,
                }
              : {},
        },
      });

      return [env, blocklet];
    }

    const parseResponse = (env, { req, type }) => {
      if (type === 'json' || req.query.type === 'json') {
        return signResponse(
          env.reduce((acc, x) => {
            acc[x.key] = x.value;
            return acc;
          }, {}),
          wallet
        );
      }

      const envStr = env.map(x => `${x.key}: ${JSON.stringify(x.value)}`).join(',');
      const jsStr = `window.blocklet = {${envStr}};`;

      const registerSwStr = `if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    const isServicePage = window.location.pathname.startsWith('${WELLKNOWN_SERVICE_PATH_PREFIX}');
    if (isServicePage) return;

    const wb = await import('${WELLKNOWN_SERVICE_PATH_PREFIX}/static/share/workbox-v7.3.0/workbox-window.prod.mjs')
      .then(({ Workbox }) => {
        const scope = window.blocklet.prefix;
        const sw = (window.blocklet?.prefix || '/') + '__sw__.js';
        return new Workbox(sw, { scope, type: 'classic' });
      })
      .catch(error => {
        console.error(error);
        return undefined;
      });
    if (!wb) return;

    wb.register({ immediate: false });
    const registrations = await navigator.serviceWorker.getRegistrations();
    const keys = 'caches' in window ? await caches.keys() : [];
    registrations.forEach(registration => {
      const scopeUrl = new URL(registration.scope);
      const prefix = scopeUrl?.pathname || '/';
      if (!window.blocklet.sw.options.mountPoints.includes(prefix) && prefix !== '${WELLKNOWN_SERVICE_PATH_PREFIX}/') {
        registration.unregister();
        keys.forEach(key => {
          if (key.endsWith(registration.scope)) {
            caches.delete(key);
          }
        });
      }
    });
  });
}
`;
      const unregisterSwStr = `if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    const isServicePage = window.location.pathname.startsWith('${WELLKNOWN_SERVICE_PATH_PREFIX}');
    if (isServicePage) return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      registration.unregister();
      if ('caches' in window) {
        const keys = await caches.keys();
        keys.forEach(key => {
          if (key.endsWith(registration.scope)) {
            caches.delete(key);
          }
        });
      }
    }
  });
}
`;
      const enabledServiceWorkerEnv = env.find(x => x.key === 'ENABLED_SERVICE_WORKER');
      const modeEnv = env.find(x => x.key === 'mode');

      const strList = [jsStr];
      // FIXME: 暂时停止开发环境中的 sw 注入
      if (modeEnv?.value !== 'development') {
        if (enabledServiceWorkerEnv?.value === 'true') strList.push(registerSwStr);
        if (enabledServiceWorkerEnv?.value === 'false') strList.push(unregisterSwStr);
      }
      const out = strList.join('\n');
      return out;
    };

    app.get(/.*\/__(meta|blocklet)__\.js$/, cors({ credentials: true, origin: true }), async (req, res) => {
      const did = req.headers['x-blocklet-did'] || '';
      const componentId = req.headers['x-blocklet-component-id'] || '';
      const pathPrefix = normalizePathPrefix(req.headers['x-path-prefix']) || '/';
      const groupPathPrefix = normalizePathPrefix(req.headers['x-group-path-prefix']) || '/';
      const pageGroup = req.headers['x-page-group'] || '';
      const isOwnerOne = req.query.owner === '1';
      const jsonType = req.query.type === 'json';

      const cachePrefixKey = getBlockletInfoCachePrefixKey(did);
      const cacheKey = md5(
        JSON.stringify({
          did,
          componentId,
          type: jsonType ? 'json' : 'js',
          pathPrefix,
          groupPathPrefix,
          pageGroup,
          isOwnerOne,
        })
      );

      const respond = data => {
        if (jsonType) {
          res.json(data);
        } else {
          res.type('js').send(data);
        }
      };
      if (req.query.force === '1' || req.query.nocache === '1') {
        await blockletInfoShortCache.groupDel(cachePrefixKey, cacheKey);
      }

      const data = await blockletInfoShortCache.autoCacheGroup(cachePrefixKey, cacheKey, async () => {
        const [blockletData] = await getBlockletData(req);
        return parseResponse(blockletData, { req, res });
      });

      return respond(data);
    });
  },
};
