#!/bin/sh
set -eu

SAGE_RELEASE_DIR="/home/node/.openclaw/sage-main/target/release"

if [ -x "${SAGE_RELEASE_DIR}/sage" ]; then
  ln -sf "${SAGE_RELEASE_DIR}/sage" /usr/local/bin/sage
fi

if [ -x "${SAGE_RELEASE_DIR}/saged" ]; then
  ln -sf "${SAGE_RELEASE_DIR}/saged" /usr/local/bin/saged
fi

exec /usr/bin/tini -- "$@"
