#!/usr/bin/env bash
set -euo pipefail

# Build and deploy the forked @abtnode/webapp runtime to the existing production server.
# This script is DRY-RUN by default. Use --apply only after:
#   1) DigitalOcean snapshot is complete
#   2) preflight passes
#   3) marketing page health is confirmed
#
# Usage:
#   ./scripts/production/deploy-fork.sh
#   SNAPSHOT_CONFIRMED=yes ./scripts/production/deploy-fork.sh --apply

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date -u '+%Y%m%d-%H%M%S')"

PROD_HOST="${PROD_HOST:-root@165.227.28.128}"
PROD_ADMIN_ORIGIN="${PROD_ADMIN_ORIGIN:-https://165-227-28-128.ip.abtnet.io}"
SNAPSHOT_CONFIRMED="${SNAPSHOT_CONFIRMED:-no}"
REMOTE_RELEASE_ROOT="${REMOTE_RELEASE_ROOT:-/root/blocklet-fork-releases}"
REMOTE_BACKUP_ROOT="${REMOTE_BACKUP_ROOT:-/root/blocklet-fork-backups}"
WEBAPP_DIR="${WEBAPP_DIR:-}"
PROD_SSH_KEY="${PROD_SSH_KEY:-${HOME}/.ssh/debos_azure_smoke}"
if [[ -z "${SSH_OPTS:-}" ]]; then
  SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10"
  [[ -f "${PROD_SSH_KEY}" ]] && SSH_OPTS="-i ${PROD_SSH_KEY} ${SSH_OPTS}"
fi
APPLY="no"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY="yes"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

note() {
  printf '\n==> %s\n' "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd ssh
require_cmd scp
require_cmd tar

note "Running preflight"
"${ROOT_DIR}/scripts/production/preflight.sh"

note "Building webapp daemon bundle"
(
  cd "${ROOT_DIR}/core/webapp"
  bun run build:daemon
)

note "Building blocklet-services bundle"
(
  cd "${ROOT_DIR}/core/blocklet-services"
  bun run build
)

ARTIFACT_DIR="${ROOT_DIR}/.deploy-artifacts/${STAMP}"
ARTIFACT="${ARTIFACT_DIR}/abtnode-webapp-${STAMP}.tgz"
mkdir -p "${ARTIFACT_DIR}/@abtnode/webapp"
cp "${ROOT_DIR}/core/webapp/blocklet.js" "${ARTIFACT_DIR}/@abtnode/webapp/blocklet.js"
if [[ -d "${ROOT_DIR}/core/webapp/dist" ]]; then
  cp -a "${ROOT_DIR}/core/webapp/dist" "${ARTIFACT_DIR}/@abtnode/webapp/dist"
fi
mkdir -p "${ARTIFACT_DIR}/@abtnode/auth/lib"
cp "${ROOT_DIR}/core/auth/lib/server.js" "${ARTIFACT_DIR}/@abtnode/auth/lib/server.js"
cp "${ROOT_DIR}/core/auth/lib/debos-google-grant.js" "${ARTIFACT_DIR}/@abtnode/auth/lib/debos-google-grant.js"
mkdir -p "${ARTIFACT_DIR}/@abtnode/state/lib/util"
cp "${ROOT_DIR}/core/state/lib/util/launcher.js" "${ARTIFACT_DIR}/@abtnode/state/lib/util/launcher.js"
mkdir -p "${ARTIFACT_DIR}/@abtnode/blocklet-services/api/services/auth/connect"
mkdir -p "${ARTIFACT_DIR}/@abtnode/blocklet-services/api/routes/oauth"
cp "${ROOT_DIR}/core/blocklet-services/api/services/auth/index.js" "${ARTIFACT_DIR}/@abtnode/blocklet-services/api/services/auth/index.js"
cp "${ROOT_DIR}/core/blocklet-services/api/services/auth/connect/login-debos-launch.js" "${ARTIFACT_DIR}/@abtnode/blocklet-services/api/services/auth/connect/login-debos-launch.js"
cp "${ROOT_DIR}/core/blocklet-services/api/services/auth/debos-google-login.js" "${ARTIFACT_DIR}/@abtnode/blocklet-services/api/services/auth/debos-google-login.js"
cp "${ROOT_DIR}/core/blocklet-services/api/routes/env.js" "${ARTIFACT_DIR}/@abtnode/blocklet-services/api/routes/env.js"
cp "${ROOT_DIR}/core/blocklet-services/api/routes/oauth/client.js" "${ARTIFACT_DIR}/@abtnode/blocklet-services/api/routes/oauth/client.js"
if [[ -d "${ROOT_DIR}/core/blocklet-services/dist" ]]; then
  cp -a "${ROOT_DIR}/core/blocklet-services/dist" "${ARTIFACT_DIR}/@abtnode/blocklet-services/dist"
fi
mkdir -p "${ARTIFACT_DIR}/@abtnode/constant/dist"
cp "${ROOT_DIR}/core/constant/dist/index.cjs" "${ARTIFACT_DIR}/@abtnode/constant/dist/index.cjs"
cp "${ROOT_DIR}/core/constant/dist/index.mjs" "${ARTIFACT_DIR}/@abtnode/constant/dist/index.mjs"
tar -C "${ARTIFACT_DIR}" -czf "${ARTIFACT}" "./@abtnode/webapp" "./@abtnode/auth" "./@abtnode/state" "./@abtnode/blocklet-services" "./@abtnode/constant"
shasum -a 256 "${ARTIFACT}" | tee "${ARTIFACT}.sha256"

if [[ "${APPLY}" != "yes" ]]; then
  echo
  echo "Dry run complete. Artifact created:"
  echo "${ARTIFACT}"
  echo
  echo "To deploy:"
  echo "SNAPSHOT_CONFIRMED=yes ${ROOT_DIR}/scripts/production/deploy-fork.sh --apply"
  exit 0
fi

if [[ "${SNAPSHOT_CONFIRMED}" != "yes" ]]; then
  echo
  echo "DigitalOcean snapshot has not been confirmed."
  echo "Set SNAPSHOT_CONFIRMED=yes only after the droplet snapshot is complete."
  echo "Stopping before deploy."
  exit 1
fi

note "Uploading artifact"
ssh ${SSH_OPTS} "${PROD_HOST}" "mkdir -p '${REMOTE_RELEASE_ROOT}/${STAMP}' '${REMOTE_BACKUP_ROOT}/${STAMP}'"
scp ${SSH_OPTS} "${ARTIFACT}" "${ARTIFACT}.sha256" "${PROD_HOST}:${REMOTE_RELEASE_ROOT}/${STAMP}/"

note "Installing forked runtime"
ssh ${SSH_OPTS} "${PROD_HOST}" \
  "STAMP='${STAMP}' REMOTE_RELEASE_ROOT='${REMOTE_RELEASE_ROOT}' REMOTE_BACKUP_ROOT='${REMOTE_BACKUP_ROOT}' WEBAPP_DIR='${WEBAPP_DIR}' PROD_ADMIN_ORIGIN='${PROD_ADMIN_ORIGIN}' bash -s" <<'REMOTE'
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

RELEASE_DIR="${REMOTE_RELEASE_ROOT}/${STAMP}"
BACKUP_DIR="${REMOTE_BACKUP_ROOT}/${STAMP}"
ARTIFACT="$(find "${RELEASE_DIR}" -type f -name 'abtnode-webapp-*.tgz' | head -n 1)"

echo "Target webapp runtime: ${WEBAPP_DIR}"
echo "Backup dir: ${BACKUP_DIR}"

cp -f "${WEBAPP_DIR}/blocklet.js" "${BACKUP_DIR}/blocklet.js"
if [[ -d "${WEBAPP_DIR}/dist" ]]; then
  cp -a "${WEBAPP_DIR}/dist" "${BACKUP_DIR}/dist"
fi
ABTNODE_DIR="$(dirname "${WEBAPP_DIR}")"
if [[ -f "${ABTNODE_DIR}/auth/lib/server.js" ]]; then
  mkdir -p "${BACKUP_DIR}/auth/lib"
  cp -f "${ABTNODE_DIR}/auth/lib/server.js" "${BACKUP_DIR}/auth/lib/server.js"
  [[ -f "${ABTNODE_DIR}/auth/lib/debos-google-grant.js" ]] && cp -f "${ABTNODE_DIR}/auth/lib/debos-google-grant.js" "${BACKUP_DIR}/auth/lib/debos-google-grant.js"
fi
if [[ -f "${ABTNODE_DIR}/state/lib/util/launcher.js" ]]; then
  mkdir -p "${BACKUP_DIR}/state/lib/util"
  cp -f "${ABTNODE_DIR}/state/lib/util/launcher.js" "${BACKUP_DIR}/state/lib/util/launcher.js"
fi
if [[ -d "${ABTNODE_DIR}/blocklet-services" ]]; then
  mkdir -p "${BACKUP_DIR}/blocklet-services/api/services/auth/connect" "${BACKUP_DIR}/blocklet-services/api/routes/oauth"
  [[ -f "${ABTNODE_DIR}/blocklet-services/api/services/auth/index.js" ]] && cp -f "${ABTNODE_DIR}/blocklet-services/api/services/auth/index.js" "${BACKUP_DIR}/blocklet-services/api/services/auth/index.js"
  [[ -f "${ABTNODE_DIR}/blocklet-services/api/services/auth/connect/login-debos-launch.js" ]] && cp -f "${ABTNODE_DIR}/blocklet-services/api/services/auth/connect/login-debos-launch.js" "${BACKUP_DIR}/blocklet-services/api/services/auth/connect/login-debos-launch.js"
  [[ -f "${ABTNODE_DIR}/blocklet-services/api/services/auth/debos-google-login.js" ]] && cp -f "${ABTNODE_DIR}/blocklet-services/api/services/auth/debos-google-login.js" "${BACKUP_DIR}/blocklet-services/api/services/auth/debos-google-login.js"
  [[ -f "${ABTNODE_DIR}/blocklet-services/api/routes/env.js" ]] && cp -f "${ABTNODE_DIR}/blocklet-services/api/routes/env.js" "${BACKUP_DIR}/blocklet-services/api/routes/env.js"
  [[ -f "${ABTNODE_DIR}/blocklet-services/api/routes/oauth/client.js" ]] && cp -f "${ABTNODE_DIR}/blocklet-services/api/routes/oauth/client.js" "${BACKUP_DIR}/blocklet-services/api/routes/oauth/client.js"
  if [[ -d "${ABTNODE_DIR}/blocklet-services/dist" ]]; then
    mkdir -p "${BACKUP_DIR}/blocklet-services"
    cp -a "${ABTNODE_DIR}/blocklet-services/dist" "${BACKUP_DIR}/blocklet-services/dist"
  fi
fi
if [[ -d "${ABTNODE_DIR}/constant/dist" ]]; then
  mkdir -p "${BACKUP_DIR}/constant/dist"
  cp -f "${ABTNODE_DIR}/constant/dist/index.cjs" "${BACKUP_DIR}/constant/dist/index.cjs"
  cp -f "${ABTNODE_DIR}/constant/dist/index.mjs" "${BACKUP_DIR}/constant/dist/index.mjs"
fi

tar -C "$(dirname "$(dirname "${WEBAPP_DIR}")")" -xzf "${ARTIFACT}"

CONFIG_FILE="${ABT_NODE_DATA_DIR:-/srv/blocklet-server/.blocklet-server}/config.yml"
if [[ -f "${CONFIG_FILE}" ]] && command -v python3 >/dev/null 2>&1; then
  CONFIG_FILE="${CONFIG_FILE}" PROD_ADMIN_ORIGIN="${PROD_ADMIN_ORIGIN}" python3 - <<'PY'
import os
import re
from pathlib import Path

path = Path(os.environ['CONFIG_FILE'])
text = path.read_text()
if not re.search(r'^\s*DEBOS_GOOGLE_BROKER_URL\s*:', text, re.M):
    broker = os.environ['PROD_ADMIN_ORIGIN'].rstrip('/') + '/.well-known/server/admin'
    suffix = '' if text.endswith('\n') else '\n'
    path.write_text(text + suffix + f"DEBOS_GOOGLE_BROKER_URL: '{broker}'\n")
PY
  # Export only the fork-specific launcher OAuth keys for the PM2 restart. The
  # command substitution captures stdout, so secrets are not printed.
  eval "$(
    CONFIG_FILE="${CONFIG_FILE}" python3 - <<'PY'
import os
import re
import shlex
from pathlib import Path

text = Path(os.environ['CONFIG_FILE']).read_text()
for key in ['DEBOS_GOOGLE_CLIENT_ID', 'DEBOS_GOOGLE_CLIENT_SECRET', 'DEBOS_GOOGLE_BROKER_URL']:
    match = re.search(rf'^\s*{re.escape(key)}\s*:\s*(.+?)\s*$', text, re.M)
    if not match:
        continue
    value = match.group(1).strip()
    if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
        value = value[1:-1].replace("''", "'")
    print(f'export {key}={shlex.quote(value)}')
PY
  )"
fi

PM2_BIN="$(command -v pm2 || true)"
[[ -z "${PM2_BIN}" && -x /usr/lib/node_modules/@blocklet/cli/node_modules/.bin/pm2 ]] && PM2_BIN="/usr/lib/node_modules/@blocklet/cli/node_modules/.bin/pm2"
if [[ -n "${PM2_BIN}" ]]; then
  PM2_HOME="${PM2_HOME:-/root/.arcblock/abtnode}" "${PM2_BIN}" restart abt-node-service --update-env
  PM2_HOME="${PM2_HOME:-/root/.arcblock/abtnode}" "${PM2_BIN}" restart abt-node-daemon --update-env
  PM2_HOME="${PM2_HOME:-/root/.arcblock/abtnode}" "${PM2_BIN}" restart abt-node-router --update-env
else
  echo "pm2 not found; restart Blocklet Server manually" >&2
  exit 1
fi

echo "BACKUP_DIR=${BACKUP_DIR}"
REMOTE

note "Running post-deploy smoke test"
"${ROOT_DIR}/scripts/production/smoke-test.sh"

note "Deploy completed"
