const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const { CustomError } = require('@blocklet/error');
const { LOGIN_PROVIDER } = require('@blocklet/constant');
const { DEBOS_BLOCKLET_DID, ROLES } = require('@abtnode/constant');
const getRequestIP = require('@abtnode/util/lib/get-request-ip');

const logger = require('./logger');

const LEDGER_VERSION = 1;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;

let ledgerLock = Promise.resolve();

const toInt = (value, fallback) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const toBool = (value, fallback = false) => {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const csv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const getPolicy = () => ({
  enabled: process.env.DEBOS_LAUNCH_GUARD_ENABLED !== 'false',
  requireVerifiedGoogleEmail: process.env.DEBOS_LAUNCH_REQUIRE_VERIFIED_GOOGLE_EMAIL !== 'false',
  maxActivePerIdentity: toInt(process.env.DEBOS_LAUNCH_MAX_ACTIVE_PER_IDENTITY, 1),
  maxAttemptsPerIdentityPerDay: toInt(process.env.DEBOS_LAUNCH_MAX_ATTEMPTS_PER_IDENTITY_PER_DAY, 2),
  maxAttemptsPerIpPerHour: toInt(process.env.DEBOS_LAUNCH_MAX_ATTEMPTS_PER_IP_PER_HOUR, 5),
  maxFailedPerIpPerDay: toInt(process.env.DEBOS_LAUNCH_MAX_FAILED_PER_IP_PER_DAY, 10),
  maxPendingLaunches: toInt(process.env.DEBOS_LAUNCH_MAX_PENDING, 3),
  pendingTtlMs: toInt(process.env.DEBOS_LAUNCH_PENDING_TTL_MS, DEFAULT_PENDING_TTL_MS),
  activeWindowMs: toInt(process.env.DEBOS_LAUNCH_ACTIVE_WINDOW_DAYS, 30) * DAY,
  ledgerRetentionMs: toInt(process.env.DEBOS_LAUNCH_LEDGER_RETENTION_DAYS, 90) * DAY,
  minFreeMemoryMb: toInt(process.env.DEBOS_LAUNCH_MIN_FREE_MEMORY_MB, 0),
  minFreeDiskMb: toInt(process.env.DEBOS_LAUNCH_MIN_FREE_DISK_MB, 0),
  blocklists: {
    emails: csv(process.env.DEBOS_LAUNCH_BLOCKED_EMAILS),
    domains: csv(process.env.DEBOS_LAUNCH_BLOCKED_EMAIL_DOMAINS),
    dids: csv(process.env.DEBOS_LAUNCH_BLOCKED_DIDS),
    ips: csv(process.env.DEBOS_LAUNCH_BLOCKED_IPS),
  },
  strictCapacity: toBool(process.env.DEBOS_LAUNCH_STRICT_CAPACITY, false),
});

const getDataDir = (node) =>
  node?.dataDirs?.data || process.env.ABT_NODE_DATA_DIR || path.join(os.tmpdir(), 'abtnode-debos-launch-guard');

const getLedgerPath = (node) => path.join(getDataDir(node), 'debos-launch-guard.json');

const isDebosMeta = (blocklet) => blocklet?.meta?.did === DEBOS_BLOCKLET_DID || blocklet?.did === DEBOS_BLOCKLET_DID;

const isRecent = (record, now, ageMs) => {
  const timestamp = new Date(record.createdAt || record.updatedAt || 0).getTime();
  return Number.isFinite(timestamp) && now - timestamp <= ageMs;
};

const isPendingActive = (record, now, policy) =>
  record.status === 'pending' && isRecent(record, now, policy.pendingTtlMs);

const isInstalledActive = (record, now, policy) =>
  record.status === 'installed' && (!policy.activeWindowMs || isRecent(record, now, policy.activeWindowMs));

const pruneLedger = (ledger, now, policy) => ({
  version: LEDGER_VERSION,
  records: (ledger.records || []).filter((record) => {
    if (record.status === 'pending') {
      return isRecent(record, now, policy.pendingTtlMs);
    }
    if (record.status === 'installed') {
      return !policy.activeWindowMs || isRecent(record, now, policy.activeWindowMs);
    }
    return isRecent(record, now, policy.ledgerRetentionMs);
  }),
});

const readLedger = async (node) => {
  const file = getLedgerPath(node);
  if (!(await fs.pathExists(file))) {
    return { version: LEDGER_VERSION, records: [] };
  }

  const ledger = await fs.readJson(file);
  return {
    version: LEDGER_VERSION,
    records: Array.isArray(ledger.records) ? ledger.records : [],
  };
};

const writeLedger = async (node, ledger) => {
  const file = getLedgerPath(node);
  await fs.ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeJson(tmp, ledger, { spaces: 2 });
  await fs.move(tmp, file, { overwrite: true });
};

const withLedger = (node, fn) => {
  const run = async () => {
    const policy = getPolicy();
    const now = Date.now();
    const ledger = pruneLedger(await readLedger(node), now, policy);
    try {
      return await fn(ledger, policy, now);
    } finally {
      await writeLedger(node, ledger);
    }
  };

  ledgerLock = ledgerLock.then(run, run);
  return ledgerLock;
};

const hashUserAgent = (value) =>
  value ? crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16) : '';

const normalizeProvider = (provider) => String(provider || '').toLowerCase();

const getConnectedAccount = (user, provider) => {
  if (user?.connectedAccount?.provider === provider) {
    return user.connectedAccount;
  }
  return (user?.connectedAccounts || []).find((item) => item.provider === provider) || null;
};

const normalizeEmail = (email) =>
  String(email || '')
    .trim()
    .toLowerCase();

const getLaunchIdentity = ({ provider, userDid, user, googleProfile }) => {
  const normalizedProvider = normalizeProvider(provider);

  if (normalizedProvider === LOGIN_PROVIDER.GOOGLE) {
    const connectedAccount = getConnectedAccount(user, LOGIN_PROVIDER.GOOGLE);
    const googleSub = googleProfile?.sub || connectedAccount?.id || user?.connectedAccount?.id;
    const email = normalizeEmail(googleProfile?.email || user?.email || connectedAccount?.userInfo?.email);
    const emailVerified =
      googleProfile?.emailVerified === true ||
      user?.emailVerified === true ||
      connectedAccount?.userInfo?.emailVerified === true;

    return {
      provider: LOGIN_PROVIDER.GOOGLE,
      key: googleSub ? `${LOGIN_PROVIDER.GOOGLE}:${googleSub}` : `${LOGIN_PROVIDER.GOOGLE}:${userDid}`,
      did: userDid,
      email,
      emailVerified,
      display: email || userDid,
    };
  }

  return {
    provider: normalizedProvider || LOGIN_PROVIDER.WALLET,
    key: `${normalizedProvider || LOGIN_PROVIDER.WALLET}:${userDid}`,
    did: userDid,
    email: normalizeEmail(user?.email),
    emailVerified: user?.emailVerified === true,
    display: user?.email || userDid,
  };
};

const getIp = ({ req, context }) => context?.ip || (req ? getRequestIP(req) : '');

const getUserAgent = ({ req, context }) => context?.ua || (req?.get ? req.get('user-agent') : '') || '';

const assertBlocklist = ({ identity, ip, policy }) => {
  const email = normalizeEmail(identity.email);
  const domain = email.includes('@') ? email.split('@').pop() : '';
  const did = String(identity.did || '').toLowerCase();
  const requestIp = String(ip || '').toLowerCase();

  if (email && policy.blocklists.emails.includes(email)) {
    throw new CustomError(403, 'This email is not allowed to launch DeBOS on this server');
  }
  if (domain && policy.blocklists.domains.includes(domain)) {
    throw new CustomError(403, 'This email domain is not allowed to launch DeBOS on this server');
  }
  if (did && policy.blocklists.dids.includes(did)) {
    throw new CustomError(403, 'This wallet is not allowed to launch DeBOS on this server');
  }
  if (requestIp && policy.blocklists.ips.includes(requestIp)) {
    throw new CustomError(403, 'This network is not allowed to launch DeBOS on this server');
  }
};

const assertIdentity = ({ identity, ip, policy }) => {
  assertBlocklist({ identity, ip, policy });

  if (identity.provider === LOGIN_PROVIDER.GOOGLE && policy.requireVerifiedGoogleEmail && !identity.emailVerified) {
    throw new CustomError(403, 'A verified Google email is required to launch DeBOS');
  }
};

const checkCapacity = async ({ node, ledger, policy, now }) => {
  const pending = ledger.records.filter((record) => isPendingActive(record, now, policy)).length;
  if (policy.maxPendingLaunches && pending >= policy.maxPendingLaunches) {
    throw new CustomError(429, 'Too many DeBOS launches are already in progress. Please try again soon.');
  }

  const freeMemoryMb = os.freemem() / 1024 / 1024;
  if (policy.minFreeMemoryMb && freeMemoryMb < policy.minFreeMemoryMb) {
    throw new CustomError(503, 'DeBOS launches are temporarily paused while the server is under memory pressure.');
  }

  if (policy.minFreeDiskMb && fs.statfs) {
    try {
      const stat = await fs.statfs(getDataDir(node));
      const freeDiskMb = (stat.bavail * stat.bsize) / 1024 / 1024;
      if (freeDiskMb < policy.minFreeDiskMb) {
        throw new CustomError(503, 'DeBOS launches are temporarily paused because server disk space is low.');
      }
    } catch (error) {
      if (error instanceof CustomError || error?.status || error?.statusCode) {
        throw error;
      }
      logger.warn('failed to check DeBOS launch disk capacity', { error: error.message });
      if (policy.strictCapacity) {
        throw new CustomError(503, 'DeBOS launches are temporarily paused while server capacity is checked.');
      }
    }
  }
};

const countActiveRecords = ({ records, identity, policy, now }) =>
  records.filter(
    (record) =>
      record.identityKey === identity.key &&
      record.blockletDid === DEBOS_BLOCKLET_DID &&
      (isPendingActive(record, now, policy) || isInstalledActive(record, now, policy))
  ).length;

const countRecentIdentityAttempts = ({ records, identity, now }) =>
  records.filter(
    (record) =>
      record.identityKey === identity.key &&
      record.blockletDid === DEBOS_BLOCKLET_DID &&
      ['pending', 'installed', 'failed'].includes(record.status) &&
      isRecent(record, now, DAY)
  ).length;

const countRecentIpAttempts = ({ records, ip, now }) =>
  ip
    ? records.filter(
        (record) =>
          record.ip === ip &&
          record.blockletDid === DEBOS_BLOCKLET_DID &&
          ['pending', 'installed', 'failed'].includes(record.status) &&
          isRecent(record, now, HOUR)
      ).length
    : 0;

const countRecentIpFailures = ({ records, ip, now }) =>
  ip
    ? records.filter(
        (record) =>
          record.ip === ip &&
          record.blockletDid === DEBOS_BLOCKLET_DID &&
          record.status === 'failed' &&
          isRecent(record, now, DAY)
      ).length
    : 0;

const createRecord = ({ identity, ip, userAgent, appDid, status, reason, sessionId }) => {
  const nowIso = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    version: LEDGER_VERSION,
    provider: identity.provider,
    identityKey: identity.key,
    userDid: identity.did,
    email: identity.email || '',
    ip: ip || '',
    userAgentHash: hashUserAgent(userAgent),
    blockletDid: DEBOS_BLOCKLET_DID,
    appDid: appDid || '',
    sessionId: sessionId || '',
    status,
    reason: reason || '',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
};

const recordDenied = ({ ledger, identity, ip, userAgent, appDid, reason }) => {
  ledger.records.push(createRecord({ identity, ip, userAgent, appDid, status: 'denied', reason }));
};

const assertDebosLaunchLoginAllowed = ({ provider, userDid, user, googleProfile, req, context }) => {
  const policy = getPolicy();
  if (!policy.enabled) {
    return null;
  }

  const identity = getLaunchIdentity({ provider, userDid, user, googleProfile });
  const ip = getIp({ req, context });
  assertIdentity({ identity, ip, policy });
  return identity;
};

const shouldGuardLaunch = ({ blocklet, role }) => role === ROLES.GUEST && isDebosMeta(blocklet);

const reserveDebosLaunch = ({ node, blocklet, appDid, role, provider, userDid, user, req, context }) => {
  const policy = getPolicy();
  if (!policy.enabled || !shouldGuardLaunch({ blocklet, role })) {
    return null;
  }

  const identity = getLaunchIdentity({ provider, userDid, user });
  const ip = getIp({ req, context });
  const userAgent = getUserAgent({ req, context });

  return withLedger(node, async (ledger, freshPolicy, now) => {
    try {
      assertIdentity({ identity, ip, policy: freshPolicy });
      await checkCapacity({ node, ledger, policy: freshPolicy, now });

      if (
        freshPolicy.maxActivePerIdentity &&
        countActiveRecords({ records: ledger.records, identity, policy: freshPolicy, now }) >=
          freshPolicy.maxActivePerIdentity
      ) {
        throw new CustomError(429, 'This account already has an active DeBOS launch on this server');
      }

      if (
        freshPolicy.maxAttemptsPerIdentityPerDay &&
        countRecentIdentityAttempts({ records: ledger.records, identity, now }) >=
          freshPolicy.maxAttemptsPerIdentityPerDay
      ) {
        throw new CustomError(429, 'This account has reached the daily DeBOS launch limit');
      }

      if (
        freshPolicy.maxAttemptsPerIpPerHour &&
        countRecentIpAttempts({ records: ledger.records, ip, now }) >= freshPolicy.maxAttemptsPerIpPerHour
      ) {
        throw new CustomError(429, 'Too many DeBOS launches from this network. Please try again later.');
      }

      if (
        freshPolicy.maxFailedPerIpPerDay &&
        countRecentIpFailures({ records: ledger.records, ip, now }) >= freshPolicy.maxFailedPerIpPerDay
      ) {
        throw new CustomError(429, 'Too many failed DeBOS launches from this network. Please try again later.');
      }

      const record = createRecord({ identity, ip, userAgent, appDid, status: 'pending' });
      ledger.records.push(record);
      logger.info('debos-launch-guard.reserved', {
        id: record.id,
        provider: record.provider,
        userDid: record.userDid,
        appDid,
      });
      return record;
    } catch (error) {
      recordDenied({ ledger, identity, ip, userAgent, appDid, reason: error.message });
      throw error;
    }
  });
};

const updateLaunchRecord = async ({ node, launchId, sessionId, appDid, status, reason }) => {
  if (!launchId && !sessionId && !appDid) {
    return;
  }

  try {
    await withLedger(node, (ledger) => {
      const record = [...ledger.records]
        .reverse()
        .find(
          (item) =>
            (launchId && item.id === launchId) ||
            (sessionId && item.sessionId === sessionId) ||
            (appDid && item.appDid === appDid)
        );
      if (!record) {
        return;
      }

      if (sessionId) {
        record.sessionId = sessionId;
      }
      if (appDid) {
        record.appDid = appDid;
      }
      if (status) {
        record.status = status;
      }
      if (reason) {
        record.reason = reason;
      }
      record.updatedAt = new Date().toISOString();
    });
  } catch (error) {
    logger.warn('failed to update DeBOS launch guard record', { error: error.message, launchId, sessionId, appDid });
  }
};

module.exports = {
  assertDebosLaunchLoginAllowed,
  getLaunchIdentity,
  getLedgerPath,
  getPolicy,
  reserveDebosLaunch,
  updateLaunchRecord,
};
