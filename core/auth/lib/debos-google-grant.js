const crypto = require('node:crypto');
const path = require('node:path');

const { DBCache } = require('@abtnode/db-cache');
const { CustomError } = require('@blocklet/error');

const DEFAULT_TTL = 2 * 60 * 1000;
const GRANT_PREFIX = 'debos-google-login-grants';

const caches = new Map();

const hashGrant = (grant) => crypto.createHash('sha256').update(String(grant)).digest('base64url');

const getCacheOptions = ({ dataDir, prefix = GRANT_PREFIX, ttl = DEFAULT_TTL } = {}) => {
  const sqlitePath =
    process.env.ABT_NODE_CACHE_SQLITE_PATH ||
    (dataDir ? path.join(dataDir, '__debos-google-login-grants.db') : undefined) ||
    ':memory:';

  return {
    redisUrl: process.env.ABT_NODE_CACHE_REDIS_URL,
    sqlitePath,
    prefix,
    ttl,
  };
};

const getGrantCache = (options = {}) => {
  const cacheOptions = getCacheOptions(options);
  const key = JSON.stringify({
    redisUrl: cacheOptions.redisUrl || '',
    sqlitePath: cacheOptions.sqlitePath,
    prefix: cacheOptions.prefix,
    ttl: cacheOptions.ttl,
  });

  if (!caches.has(key)) {
    caches.set(key, new DBCache(() => cacheOptions));
  }

  return caches.get(key);
};

const createDebosGoogleLoginGrant = async (payload, options = {}) => {
  const grant = crypto.randomBytes(32).toString('base64url');
  const key = `grant:${hashGrant(grant)}`;
  const ttl = options.ttl || DEFAULT_TTL;
  const now = Date.now();

  const stored = await getGrantCache({ ...options, ttl }).set(
    key,
    {
      ...payload,
      createdAt: now,
      expiresAt: now + ttl,
    },
    { ttl, nx: true }
  );

  if (!stored) {
    throw new CustomError(500, 'Unable to create Google login grant');
  }

  return grant;
};

const consumeDebosGoogleLoginGrant = async (grant, { appDid, dataDir, ttl = DEFAULT_TTL } = {}) => {
  if (!grant) {
    throw new CustomError(400, 'Missing Google login grant');
  }

  const cache = getGrantCache({ dataDir, ttl });
  const hash = hashGrant(grant);
  const usedKey = `used:${hash}`;
  const grantKey = `grant:${hash}`;

  const locked = await cache.set(usedKey, Date.now(), { ttl, nx: true });
  if (!locked) {
    throw new CustomError(400, 'Google login grant has already been used');
  }

  const payload = await cache.get(grantKey);
  await cache.del(grantKey);

  if (!payload || payload.expiresAt < Date.now()) {
    throw new CustomError(400, 'Google login grant expired');
  }

  if (appDid && payload.appDid !== appDid) {
    throw new CustomError(403, 'Google login grant is not valid for this blocklet');
  }

  return payload;
};

module.exports = {
  DEFAULT_TTL,
  createDebosGoogleLoginGrant,
  consumeDebosGoogleLoginGrant,
  getGrantCache,
  hashGrant,
};
