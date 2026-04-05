#!/bin/sh
set -eu

HERMES_HOME="${HERMES_HOME:-/opt/data}"
INSTALL_DIR="/opt/hermes"
BOOTSTRAP_CONFIG="/opt/hermes-local/config.yaml"
YAMS_ROOT="${HERMES_HOME}/yams"
YAMS_CONFIG_DIR="${YAMS_ROOT}/config"
YAMS_DATA_DIR="${YAMS_ROOT}/data"
YAMS_SOCKET="${YAMS_DAEMON_SOCKET:-/tmp/yams-daemon.sock}"

mkdir -p "${HERMES_HOME}"/cron "${HERMES_HOME}"/sessions "${HERMES_HOME}"/logs \
  "${HERMES_HOME}"/hooks "${HERMES_HOME}"/memories "${HERMES_HOME}"/skills
mkdir -p "${YAMS_CONFIG_DIR}" "${YAMS_DATA_DIR}" /root/.config /root/.local/share

ln -sfn "${YAMS_CONFIG_DIR}" /root/.config/yams
ln -sfn "${YAMS_DATA_DIR}" /root/.local/share/yams

if [ ! -f "${HERMES_HOME}/.env" ]; then
  cp "${INSTALL_DIR}/.env.example" "${HERMES_HOME}/.env"
fi

if [ ! -f "${HERMES_HOME}/config.yaml" ]; then
  cp "${BOOTSTRAP_CONFIG}" "${HERMES_HOME}/config.yaml"
fi

if [ ! -f "${HERMES_HOME}/SOUL.md" ]; then
  cp "${INSTALL_DIR}/docker/SOUL.md" "${HERMES_HOME}/SOUL.md"
fi

if [ -d "${INSTALL_DIR}/skills" ]; then
  python3 "${INSTALL_DIR}/tools/skills_sync.py"
fi

if [ ! -f "${YAMS_CONFIG_DIR}/config.toml" ]; then
  yams init --auto
fi

yams daemon start --socket "${YAMS_SOCKET}" --pid-file /tmp/yams-daemon.pid --restart

exec hermes "$@"
