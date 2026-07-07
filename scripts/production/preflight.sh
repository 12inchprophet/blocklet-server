#!/usr/bin/env bash
set -euo pipefail

# Read-only production inspection before touching the live Blocklet Server.
#
# Required/optional environment:
#   PROD_HOST=root@165.227.28.128
#   PROD_ADMIN_ORIGIN=https://165-227-28-128.ip.abtnet.io
#   SERVER_HOME=/root/.blocklet-server            # optional; auto-detected when omitted
#   PROTECTED_URLS=$'https://debos.12inchapps.com/?locale=en\nhttps://appstore.12inchapps.com/?locale=en'

PROD_HOST="${PROD_HOST:-root@165.227.28.128}"
PROD_ADMIN_ORIGIN="${PROD_ADMIN_ORIGIN:-https://165-227-28-128.ip.abtnet.io}"
SERVER_HOME="${SERVER_HOME:-}"
PROD_SSH_KEY="${PROD_SSH_KEY:-${HOME}/.ssh/debos_azure_smoke}"
if [[ -z "${SSH_OPTS:-}" ]]; then
  SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10"
  [[ -f "${PROD_SSH_KEY}" ]] && SSH_OPTS="-i ${PROD_SSH_KEY} ${SSH_OPTS}"
fi

if [[ -n "${PROTECTED_URLS:-}" ]]; then
  PROTECTED_URL_LIST=()
  while IFS= read -r line; do
    PROTECTED_URL_LIST+=("${line}")
  done <<<"${PROTECTED_URLS}"
else
  PROTECTED_URL_LIST=(
    "https://debos.12inchapps.com/?locale=en"
    "https://appstore.12inchapps.com/?locale=en"
  )
fi

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

note "Production host"
echo "${PROD_HOST}"

note "Protected public URLs"
for url in "${PROTECTED_URL_LIST[@]}"; do
  [[ -z "${url}" ]] && continue
  code="$(curl -kLsS -o /dev/null -w '%{http_code}' --max-time 20 "${url}" || true)"
  echo "${code} ${url}"
  if [[ ! "${code}" =~ ^(200|301|302|304)$ ]]; then
    echo "Protected URL is not healthy before deploy: ${url}" >&2
    exit 1
  fi
done

note "Admin origin"
admin_code="$(curl -kLsS -o /dev/null -w '%{http_code}' --max-time 20 "${PROD_ADMIN_ORIGIN}/.well-known/server/admin/" || true)"
echo "${admin_code} ${PROD_ADMIN_ORIGIN}/.well-known/server/admin/"
if [[ ! "${admin_code}" =~ ^(200|301|302|304)$ ]]; then
  echo "Production admin origin is not reachable: ${PROD_ADMIN_ORIGIN}" >&2
  exit 1
fi

note "Remote server inventory"
ssh ${SSH_OPTS} "${PROD_HOST}" "SERVER_HOME='${SERVER_HOME}' bash -s" <<'REMOTE'
set -euo pipefail

detect_server_home() {
  local candidates=()
  [[ -n "${SERVER_HOME:-}" ]] && candidates+=("${SERVER_HOME}")
  candidates+=(
    "/srv/blocklet-server/.blocklet-server"
    "${HOME}/.blocklet-server"
    "/root/.blocklet-server"
    "/data/blocklet-server/.blocklet-server"
    "/opt/blocklet-server/.blocklet-server"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "${candidate}/config.yml" || -d "${candidate}/core" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  find /root /home /srv /data /opt -maxdepth 6 -type f -path '*/.blocklet-server/config.yml' 2>/dev/null \
    | head -n 1 \
    | sed 's#/config.yml$##'
}

SERVER_HOME="$(detect_server_home || true)"
echo "hostname: $(hostname)"
echo "date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "server_home: ${SERVER_HOME:-not-detected}"
echo

echo "disk:"
df -h /
echo

echo "node:"
node --version 2>/dev/null || true
echo

echo "blocklet:"
blocklet --version 2>/dev/null || true
echo

echo "pm2:"
PM2_BIN="$(command -v pm2 || true)"
[[ -z "${PM2_BIN}" && -x /usr/lib/node_modules/@blocklet/cli/node_modules/.bin/pm2 ]] && PM2_BIN="/usr/lib/node_modules/@blocklet/cli/node_modules/.bin/pm2"
if [[ -n "${PM2_BIN}" ]]; then
  PM2_HOME="${PM2_HOME:-/root/.arcblock/abtnode}" "${PM2_BIN}" list || true
else
  echo "pm2 not found"
fi
echo

if [[ -n "${SERVER_HOME}" ]]; then
  db="${SERVER_HOME}/core/server.db"
  echo "database: ${db}"
  if [[ -f "${db}" && "$(command -v sqlite3 || true)" ]]; then
    sqlite3 -header -column "${db}" \
      "SELECT json_extract(meta,'$.title') AS title, appDid, status, installedAt, updatedAt FROM blocklets ORDER BY installedAt DESC LIMIT 20;" \
      || true
  fi
fi
REMOTE

note "Preflight passed"
