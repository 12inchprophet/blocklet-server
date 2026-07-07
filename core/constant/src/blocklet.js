// application is a container, components have no hierarchy and are tiled in application
export const APP_STRUCT_VERSION = '2';

export const BLOCKLET_LAUNCHER_URL = 'https://launcher.arcblock.io/';

export const DEBOS_BLOCKLET_DID = 'z8iZzXUyiJYiDZP3nhMVMN3eeXnZZ6dokUk2B';

export const BLOCKLET_PROXY_PATH_PREFIX = '/.blocklet/proxy';
export const BLOCKLET_SITE_GROUP_SUFFIX = '.blocklet-domain-group';

export const BLOCKLET_INSTALL_TYPE = {
  STORE: 'store',
  URL: 'url',
  DEV: 'dev',
  CREATE: 'create',
  RESTORE: 'restore',
};

export const INSTALL_ACTIONS = {
  INSTALL: 'install',
  INSTALL_COMPONENT: 'installComponent',
  UPGRADE_COMPONENT: 'upgradeComponent',
};

export const SERVERLESS_BLOCKLET_DATA_RETENTION_DAYS = 30;

export const LAUNCH_SESSION_STATUS = /* #__PURE__ */ Object.freeze({
  created: 0,
  selected: 10,
  connected: 20,
  timeout: 25,
  paid: 30,
  nftMinted: 35,
  allocated: 40,
  consuming: 46,
  installed: 50,
  overdue: 60,
  canceled: 65,
  terminated: 70,
  transferred: 90,
});

export const NAVIGATION_I18N_FIELDS = /* #__PURE__ */ Object.freeze(['title', 'description', 'link']);

// NOTICE: keep sync with @blocklet/constant
export const USER_SESSION_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  EXPIRED: 'expired',
};

export const STUDIO_CONNECTED_STORE = 'studio_connected_store';
export const STUDIO_CONNECTED_AND_DEVELOPED = 'studio_connected_and_developed';

// in multi-tenant mode, these allowlisted methods skip RBAC
export const STUDIO_ALLOWED_METHODS = {
  getBlocklet: true,
  createProject: true,
  getProjects: true,
  getProject: true,
  updateProject: true,
  deleteProject: true,
  getReleases: true,
  getRelease: true,
  createRelease: true,
  deleteRelease: true,
  addBlockletStore: true,
  deleteBlockletStore: true,
  publishToStore: true,
  connectToStore: true,
  connectByStudio: true,
  disconnectFromStore: true,
  getSelectedResources: true,
  updateSelectedResources: true,
  // FIXME: these two GET methods could be restricted; frontend should conditionally avoid calling them
  getBlockletRuntimeHistory: true,
  checkDomains: true,
  isDidDomain: true,
};

export const SDK_ALLOWED_METHODS = {
  configBlocklet: true,
  configNavigations: true,
  addRoutingRule: true,
  updateRoutingRule: true,
  deleteRoutingRule: true,
};
