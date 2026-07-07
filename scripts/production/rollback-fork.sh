#!/usr/bin/env bash
set -euo pipefail

# Restore a prior forked runtime backup created by deploy-fork.sh.
#
# Usage:
#   PROD_HOST=root@165.227.28.128 BACKUP_DIR=/root/blocklet-fork-backups/20260706-123456 ./scripts/production/rollback-fork.sh

PROD_HOST="${PROD_HOST:-root@165.227.28.128}"
BACKUP_DIR="${BACKUP_DIR:-}"
WEBAPP_DIR="${WEBAPP_DIR:-}"
PROD_SSH_KEY="${PROD_SSH_KEY:-${HOME}/.ssh/debos_azure_smoke}"
if [[ -z "${SSH_OPTS:-}" ]]; then
  SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10"
  [[ -f "${PROD_SSH_KEY}" ]] && SSH_OPTS="-i ${PROD_SSH_KEY} ${SSH_OPTS}"
fi

if [[ -z "${BACKUP_DIR}" ]]; then
  echo "BACKUP_DIR is required, for example /root/blocklet-fork-backups/20260706-123456" >&2
  exit 1
fi

ssh ${SSH_OPTS} "${PROD_HOST}" "BACKUP_DIR='${BACKUP_DIR}' WEBAPP_DIR='${WEBAPP_DIR}' bash -s" <<'REMOTE'
set -euo pipefail

detect_webapp_dir() {
  if [[ -n "${WEBAPP_DIR:-}" && -f "${WEBAPP_DIR}/package.json" ]]; then
    echo "${WEBAPP_DIR}"
    return 0
  fi

  for base in /root /home /data /opt /usr/local /usr/lib; do
    [[ -d "${base}" ]] || continue
    find "${base}" -type f -path '*/node_modules/@abtnode/webapp/blocklet.js' 2>/dev/null
  done \
    | head -n 1 \
    | sed 's#/blocklet.js$##'
}

WEBAPP_DIR="$(detect_webapp_dir)"
if [[ -z "${WEBAPP_DIR}" || ! -d "${WEBAPP_DIR}" ]]; then
  echo "Could not detect @abtnode/webapp runtime directory" >&2
  exit 1
fi

echo "Restoring @abtnode/webapp from ${BACKUP_DIR}"
echo "Target: ${WEBAPP_DIR}"

if [[ -f "${BACKUP_DIR}/blocklet.js" ]]; then
  cp -f "${BACKUP_DIR}/blocklet.js" "${WEBAPP_DIR}/blocklet.js"
fi

if [[ -d "${BACKUP_DIR}/dist" ]]; then
  rm -rf "${WEBAPP_DIR}/dist"
  cp -a "${BACKUP_DIR}/dist" "${WEBAPP_DIR}/dist"
fi

ABTNODE_DIR="$(dirname "${WEBAPP_DIR}")"
if [[ -f "${BACKUP_DIR}/auth/lib/server.js" ]]; then
  cp -f "${BACKUP_DIR}/auth/lib/server.js" "${ABTNODE_DIR}/auth/lib/server.js"
fi
if [[ -f "${BACKUP_DIR}/auth/lib/debos-google-grant.js" ]]; then
  cp -f "${BACKUP_DIR}/auth/lib/debos-google-grant.js" "${ABTNODE_DIR}/auth/lib/debos-google-grant.js"
fi

if [[ -f "${BACKUP_DIR}/state/lib/util/launcher.js" ]]; then
  cp -f "${BACKUP_DIR}/state/lib/util/launcher.js" "${ABTNODE_DIR}/state/lib/util/launcher.js"
fi

if [[ -d "${BACKUP_DIR}/blocklet-services" ]]; then
  if [[ -f "${BACKUP_DIR}/blocklet-services/api/services/auth/index.js" ]]; then
    cp -f "${BACKUP_DIR}/blocklet-services/api/services/auth/index.js" "${ABTNODE_DIR}/blocklet-services/api/services/auth/index.js"
  fi
  if [[ -f "${BACKUP_DIR}/blocklet-services/api/services/auth/connect/login-debos-launch.js" ]]; then
    mkdir -p "${ABTNODE_DIR}/blocklet-services/api/services/auth/connect"
    cp -f "${BACKUP_DIR}/blocklet-services/api/services/auth/connect/login-debos-launch.js" "${ABTNODE_DIR}/blocklet-services/api/services/auth/connect/login-debos-launch.js"
  fi
  if [[ -f "${BACKUP_DIR}/blocklet-services/api/services/auth/debos-google-login.js" ]]; then
    cp -f "${BACKUP_DIR}/blocklet-services/api/services/auth/debos-google-login.js" "${ABTNODE_DIR}/blocklet-services/api/services/auth/debos-google-login.js"
  fi
  if [[ -f "${BACKUP_DIR}/blocklet-services/api/routes/env.js" ]]; then
    cp -f "${BACKUP_DIR}/blocklet-services/api/routes/env.js" "${ABTNODE_DIR}/blocklet-services/api/routes/env.js"
  fi
  if [[ -d "${BACKUP_DIR}/blocklet-services/dist" ]]; then
    rm -rf "${ABTNODE_DIR}/blocklet-services/dist"
    cp -a "${BACKUP_DIR}/blocklet-services/dist" "${ABTNODE_DIR}/blocklet-services/dist"
  fi
fi

if [[ -f "${BACKUP_DIR}/constant/dist/index.cjs" ]]; then
  cp -f "${BACKUP_DIR}/constant/dist/index.cjs" "${ABTNODE_DIR}/constant/dist/index.cjs"
fi

if [[ -f "${BACKUP_DIR}/constant/dist/index.mjs" ]]; then
  cp -f "${BACKUP_DIR}/constant/dist/index.mjs" "${ABTNODE_DIR}/constant/dist/index.mjs"
fi

PM2_BIN="$(command -v pm2 || true)"
[[ -z "${PM2_BIN}" && -x /usr/lib/node_modules/@blocklet/cli/node_modules/.bin/pm2 ]] && PM2_BIN="/usr/lib/node_modules/@blocklet/cli/node_modules/.bin/pm2"
if [[ -n "${PM2_BIN}" ]]; then
  PM2_HOME="${PM2_HOME:-/root/.arcblock/abtnode}" "${PM2_BIN}" restart abt-node-service --update-env || true
  PM2_HOME="${PM2_HOME:-/root/.arcblock/abtnode}" "${PM2_BIN}" restart abt-node-daemon --update-env || true
fi
REMOTE

"$(dirname "$0")/smoke-test.sh"
