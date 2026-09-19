#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This installer is for macOS. On Windows, use the ForkDeck .exe release installer."
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ARCH="$(uname -m)"
[[ "${BUILD_ARCH}" == "arm64" ]] || BUILD_ARCH="x64"
VERSION="$(/usr/bin/plutil -extract version raw -o - "${PROJECT_ROOT}/package.json")"
ARCHIVE="${PROJECT_ROOT}/dist/ForkDeck-${VERSION}-mac-${BUILD_ARCH}.zip"
INSTALL_DIR="${FORKDECK_INSTALL_DIR:-${HOME}/Applications}"
APP_DEST="${INSTALL_DIR}/ForkDeck.app"

if [[ ! -f "${ARCHIVE}" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    print -u2 "Building from source requires Node.js and npm. Download the ready-made .dmg from https://github.com/mrHeinrichh/forkdeck/releases/latest instead."
    exit 1
  fi
  cd "${PROJECT_ROOT}"
  npm ci
  CSC_IDENTITY_AUTO_DISCOVERY=false node scripts/build-desktop.js --mac --"${BUILD_ARCH}"
fi

# Extract the delivered archive outside synced folders, and verify it before
# touching an existing install. Raw build directories may be stale or cloud-modified.
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/forkdeck-install.XXXXXX")"
trap 'rm -rf "${STAGING}"' EXIT
/usr/bin/ditto -x -k "${ARCHIVE}" "${STAGING}"
APP_SOURCE="${STAGING}/ForkDeck.app"
/usr/bin/codesign --verify --deep --strict "${APP_SOURCE}"
mkdir -p "${INSTALL_DIR}"
PENDING_APP="${INSTALL_DIR}/.ForkDeck-install-$$.app"
/usr/bin/ditto "${APP_SOURCE}" "${PENDING_APP}"
/usr/bin/codesign --verify --deep --strict "${PENDING_APP}"
if [[ -e "${APP_DEST}" ]]; then
  BACKUP_DIR="${HOME}/Library/Application Support/ForkDeck/Backups"
  mkdir -p "${BACKUP_DIR}"
  BACKUP_APP="${BACKUP_DIR}/ForkDeck-$(date +%Y%m%d-%H%M%S)-$$.app"
  mv "${APP_DEST}" "${BACKUP_APP}"
  print "Previous app preserved at ${BACKUP_APP}"
fi
mv "${PENDING_APP}" "${APP_DEST}"
/usr/bin/codesign --verify --deep --strict "${APP_DEST}"
print "Installed ${APP_DEST}"
print "Open ForkDeck from Applications. Node.js is not required to run it; Git is required."
