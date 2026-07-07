const { DEBOS_BLOCKLET_DID, ROLES } = require('@abtnode/constant');

const isLaunchBlockletReferer = req => {
  const referrer = req.get('referer') || req.get('referrer');
  if (!referrer) {
    return false;
  }

  try {
    const { pathname } = new URL(referrer, `${req.protocol}://${req.get('host') || 'localhost'}`);
    return pathname.includes('/launch-blocklet');
  } catch {
    return false;
  }
};

const isLaunchOnlyGuestAllowedRequest = req => {
  const requestPath = `${req.baseUrl || ''}${req.path || req.url || ''}`;

  if (
    requestPath.includes('/api/oauth/debos-launch') ||
    requestPath.includes('/oauth/debos-launch') ||
    requestPath.includes('/oauth/debos-login')
  ) {
    return true;
  }

  if (
    requestPath.includes('/api/did/session') ||
    requestPath.includes('/api/did/refreshSession') ||
    requestPath.includes('/api/gql')
  ) {
    return isLaunchBlockletReferer(req);
  }

  return false;
};

const isDebosLaunchGuest = user =>
  user?.role === ROLES.GUEST && user.purpose === 'debos-launch' && user.launchBlockletDid === DEBOS_BLOCKLET_DID;

const restrictGuestDashboardSession = req => {
  if (req.user?.role === ROLES.GUEST && (!isDebosLaunchGuest(req.user) || !isLaunchOnlyGuestAllowedRequest(req))) {
    req.user = null;
  }
};

module.exports = {
  isDebosLaunchGuest,
  isLaunchBlockletReferer,
  isLaunchOnlyGuestAllowedRequest,
  restrictGuestDashboardSession,
};
