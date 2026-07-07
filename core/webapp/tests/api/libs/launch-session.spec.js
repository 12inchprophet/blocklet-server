const { describe, expect, test } = require('bun:test');
const { DEBOS_BLOCKLET_DID, ROLES } = require('@abtnode/constant');

const { restrictGuestDashboardSession } = require('../../../api/libs/launch-session');

const createReq = ({ path = '/api/gql', referer = 'https://server.example/launch-blocklet/install', user } = {}) => ({
  baseUrl: '',
  path,
  protocol: 'https',
  user,
  get: name => {
    if (name === 'referer' || name === 'referrer') {
      return referer;
    }
    if (name === 'host') {
      return 'server.example';
    }
    return undefined;
  },
});

const launchGuest = {
  role: ROLES.GUEST,
  purpose: 'debos-launch',
  launchBlockletDid: DEBOS_BLOCKLET_DID,
};

describe('DeBOS launch guest session restrictions', () => {
  test('allows a purpose-bound launch guest on the launch GraphQL flow', () => {
    const req = createReq({ user: { ...launchGuest } });

    restrictGuestDashboardSession(req);

    expect(req.user).toEqual(launchGuest);
  });

  test('rejects a generic guest even when the referrer looks like the launch flow', () => {
    const req = createReq({ user: { role: ROLES.GUEST } });

    restrictGuestDashboardSession(req);

    expect(req.user).toBeNull();
  });

  test('rejects a launch token scoped to a different blocklet', () => {
    const req = createReq({
      user: { ...launchGuest, launchBlockletDid: 'zDifferentBlocklet' },
    });

    restrictGuestDashboardSession(req);

    expect(req.user).toBeNull();
  });

  test('rejects a valid launch guest on a server dashboard route', () => {
    const req = createReq({
      path: '/blocklets',
      referer: 'https://server.example/blocklets',
      user: { ...launchGuest },
    });

    restrictGuestDashboardSession(req);

    expect(req.user).toBeNull();
  });
});
