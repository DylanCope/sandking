#!/usr/bin/env bash

set -euo pipefail

codex_auth_source="${CODEX_AUTH_SOURCE:-${HOME}/.sandcastle-secrets/codex-auth.json}"
codex_home="${CODEX_HOME:-${HOME}/.codex}"

mkdir -p "${codex_home}"
cp "${codex_auth_source}" "${codex_home}/auth.json"
chmod 600 "${codex_home}/auth.json"
