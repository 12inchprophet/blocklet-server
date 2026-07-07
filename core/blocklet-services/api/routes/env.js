const get = require('lodash/get');
const { joinURL } = require('ufo');
const { WELLKNOWN_SERVICE_PATH_PREFIX, MAX_UPLOAD_FILE_SIZE } = require('@abtnode/constant');
const { BLOCKLET_CONFIGURABLE_KEY } = require('@blocklet/constant');
const { getDidDomainForBlocklet } = require('@abtnode/util/lib/get-domain-for-blocklet');

module.exports = {
  init(server, node, opts) {
    server.get(`**${WELLKNOWN_SERVICE_PATH_PREFIX}/api/env`, async (req, res) => {
      res.type('js');

      const [blockletInfo, blocklet, info] = await Promise.all([
        req.getBlockletInfo(),
        req.getBlocklet(),
        req.getNodeInfo(),
      ]);
      const pathPrefix = req.headers['x-path-prefix'] || '/';
      const groupPathPrefix = req.headers['x-group-path-prefix'];

      const passportColor = get(
        (blocklet.environments || []).find((x) => x.key === BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_PASSPORT_COLOR),
        'value',
        'auto'
      );

      const serverPort = info.routing?.httpsPort && info.routing?.httpsPort !== 443 ? `:${info.routing.httpsPort}` : '';
      const serverEndpoint = joinURL(
        `https://${getDidDomainForBlocklet({ did: info.did })}${serverPort}`,
        info.routing?.adminPath || '/'
      );
      const isSessionHardeningEnabled = blocklet?.settings?.enableSessionHardening;
      const componentId =
        req.headers['x-blocklet-component-id'] ||
        blocklet?.environmentObj?.BLOCKLET_COMPONENT_DID ||
        blocklet?.environments?.find((x) => x.key === 'BLOCKLET_COMPONENT_DID')?.value ||
        '';
      const debosGoogleBrokerUrl = process.env.DEBOS_GOOGLE_BROKER_URL || serverEndpoint;

      res.send(`window.env = {
  did: "${blockletInfo.did}",
  appId: "${blocklet.appDid}",
  appName: "${blockletInfo.name}",
  componentId: ${JSON.stringify(componentId)},
  pathPrefix: "${pathPrefix}",
  apiPrefix: "${pathPrefix.replace(/\/+$/, '')}${WELLKNOWN_SERVICE_PATH_PREFIX}",
  ${groupPathPrefix ? `groupPathPrefix: "${groupPathPrefix}",` : ''}
  webWalletUrl: "${info.webWalletUrl || opts.webWalletUrl}",
  nftDomainUrl: "${info.nftDomainUrl || ''}",
  passportColor: "${passportColor}",
  serverDid: "${info.did}",
  enableDocker: "${info.enableDocker}",
  enableDockerNetwork: "${info.enableDockerNetwork}",
  serverEndpoint: "${serverEndpoint}",
  serverVersion: "${info.version}",
  mode: "${info.mode}",
  enableSessionHardening: ${isSessionHardeningEnabled || false},
  debosGoogleLogin: {
    brokerUrl: ${JSON.stringify(debosGoogleBrokerUrl)},
  },
  ownerNft: ${JSON.stringify(info.ownerNft || '')},
  launcher: ${JSON.stringify(info.launcher || '')},
  maxUploadFileSize: ${Number(info.routing?.maxUploadFileSize) || MAX_UPLOAD_FILE_SIZE},
  runtimeConfig: {
    blockletMaxMemoryLimit: ${info.runtimeConfig?.blockletMaxMemoryLimit},
    daemonMaxMemoryLimit: ${info.runtimeConfig?.daemonMaxMemoryLimit},
  },
  gateway: {
    wafPolicy: {
      enabled: ${info?.routing?.wafPolicy?.enabled},
    },
  }
}`);
    });
  },
};
