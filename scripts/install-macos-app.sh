#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This installer is for macOS. On Windows, use the ForkDeck .exe release installer."
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="$(uname -m)"
if [[ "${ARCH}" == "arm64" ]]; then
  APP_SOURCE="${PROJECT_ROOT}/dist/mac-arm64/ForkDeck.app"
  BUILD_ARCH="arm64"
else
  APP_SOURCE="${PROJECT_ROOT}/dist/mac/ForkDeck.app"
  BUILD_ARCH="x64"
fi

INSTALL_DIR="${FORKDECK_INSTALL_DIR:-${HOME}/Applications}"
APP_DEST="${INSTALL_DIR}/ForkDeck.app"
if [[ ! -d "${APP_SOURCE}" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    print -u2 "Building from source requires Node.js and npm. Download the ready-made .dmg from https://github.com/mrHeinrichh/forkdeck/releases/latest instead."
    exit 1
  fi
  cd "${PROJECT_ROOT}"
  npm ci
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --"${BUILD_ARCH}" --dir --publish never
fi

# Verify the real executable before changing an existing installation.
if [[ ! -x "${APP_SOURCE}/Contents/MacOS/ForkDeck" ]]; then
  print -u2 "The packaged ForkDeck executable is missing. Run npm run dist:mac and try again."
  exit 1
fi
mkdir -p "${INSTALL_DIR}"
if [[ -e "${APP_DEST}" ]]; then
  BACKUP_DIR="${HOME}/Library/Application Support/ForkDeck/Backups"
  mkdir -p "${BACKUP_DIR}"
  BACKUP_APP="${BACKUP_DIR}/ForkDeck-$(date +%Y%m%d-%H%M%S)-$$.app"
  mv "${APP_DEST}" "${BACKUP_APP}"
  print "Previous app preserved at ${BACKUP_APP}"
fi
/usr/bin/ditto "${APP_SOURCE}" "${APP_DEST}"
print "Installed ${APP_DEST}"
print "Open ForkDeck from Applications. Node.js is not required to run it; Git is required."
