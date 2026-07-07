#!/usr/bin/env bash
set -euo pipefail

# Public post-deploy smoke test. Safe to run anytime.
#
# Required/optional environment:
#   PROD_ADMIN_ORIGIN=https://165-227-28-128.ip.abtnet.io
#   PROTECTED_URLS=$'https://debos.12inchapps.com/?locale=en\nhttps://appstore.12inchapps.com/?locale=en'

PROD_ADMIN_ORIGIN="${PROD_ADMIN_ORIGIN:-https://165-227-28-128.ip.abtnet.io}"

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

check_url() {
  local label="$1"
  local url="$2"
  local expected="${3:-^(200|301|302|304)$}"
  local code

  code="$(curl -kLsS -o /dev/null -w '%{http_code}' --max-time 25 "${url}" || true)"
  echo "${code} ${label}: ${url}"
  if [[ ! "${code}" =~ ${expected} ]]; then
    echo "Smoke test failed for ${label}: ${url}" >&2
    return 1
  fi
}

note "Protected public URLs"
for url in "${PROTECTED_URL_LIST[@]}"; do
  [[ -z "${url}" ]] && continue
  check_url "protected" "${url}"
done

note "Production admin"
check_url "admin" "${PROD_ADMIN_ORIGIN}/.well-known/server/admin/"

note "DeBOS Google launch config"
config_url="${PROD_ADMIN_ORIGIN}/.well-known/server/admin/api/oauth/debos-launch/config"
config="$(curl -kLsS --max-time 25 "${config_url}" || true)"
echo "${config_url}"
echo "${config}"
if [[ "${config}" != *'"google"'* || "${config}" != *'"enabled":true'* ]]; then
  echo "Google DeBOS launch config is not enabled" >&2
  exit 1
fi

note "Smoke test passed"
