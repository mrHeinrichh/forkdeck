#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DEST="${HOME}/Desktop/ForkDeck.app"
APP_CONTENTS="${APP_DEST}/Contents"
APP_MACOS="${APP_CONTENTS}/MacOS"
APP_RESOURCES="${APP_CONTENTS}/Resources"
ICONSET="${APP_RESOURCES}/ForkDeck.iconset"
FAVICON="${PROJECT_ROOT}/public/favicon.png"

mkdir -p "${APP_MACOS}" "${APP_RESOURCES}" "${ICONSET}"

cat >"${APP_CONTENTS}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>ForkDeck</string>
  <key>CFBundleExecutable</key>
  <string>ForkDeckLauncher</string>
  <key>CFBundleIconFile</key>
  <string>ForkDeck</string>
  <key>CFBundleIdentifier</key>
  <string>com.mrheinrichh.forkdeck.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>ForkDeck</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

cat >"${APP_MACOS}/ForkDeckLauncher" <<'LAUNCHER'
#!/bin/zsh
set -u

APP_ROOT="__PROJECT_ROOT__"
PORT="${FORKDECK_PORT:-4173}"
URL="http://localhost:${PORT}/?t=$(date +%s)"
LOG_DIR="${HOME}/Library/Logs/ForkDeck"
PID_FILE="${LOG_DIR}/forkdeck.pid"
LOG_FILE="${LOG_DIR}/forkdeck.log"

mkdir -p "${LOG_DIR}"

find_node() {
  for candidate in "/opt/homebrew/bin/node" "/usr/local/bin/node" "/usr/bin/node"; do
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" command -v node
}

port_is_ready() {
  /usr/bin/curl -fsS "http://localhost:${PORT}/" >/dev/null 2>&1
}

show_error() {
  /usr/bin/osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"ForkDeck\""
}

NODE_BIN="$(find_node || true)"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  show_error "Node.js was not found. Install Node.js first, then open ForkDeck again."
  exit 1
fi

if [[ ! -f "${APP_ROOT}/server.js" ]]; then
  show_error "ForkDeck project folder was not found at ${APP_ROOT}."
  exit 1
fi

if ! port_is_ready; then
  cd "${APP_ROOT}" || exit 1
  FORKDECK_PORT="${PORT}" "${NODE_BIN}" server.js >>"${LOG_FILE}" 2>&1 &
  echo "$!" >"${PID_FILE}"

  for _ in {1..40}; do
    if port_is_ready; then
      break
    fi
    /bin/sleep 0.25
  done
fi

if port_is_ready; then
  /usr/bin/open "${URL}"
else
  show_error "ForkDeck could not start. Check ${LOG_FILE} for details."
  exit 1
fi
LAUNCHER

/usr/bin/perl -0pi -e 's#__PROJECT_ROOT__#'"${PROJECT_ROOT}"'#g' "${APP_MACOS}/ForkDeckLauncher"

chmod +x "${APP_MACOS}/ForkDeckLauncher"

if [[ -f "${FAVICON}" ]] && command -v sips >/dev/null && command -v iconutil >/dev/null; then
  for size in 16 32 128 256 512; do
    sips -z "${size}" "${size}" "${FAVICON}" --out "${ICONSET}/icon_${size}x${size}.png" >/dev/null
  done

  sips -z 32 32 "${FAVICON}" --out "${ICONSET}/icon_16x16@2x.png" >/dev/null
  sips -z 64 64 "${FAVICON}" --out "${ICONSET}/icon_32x32@2x.png" >/dev/null
  sips -z 256 256 "${FAVICON}" --out "${ICONSET}/icon_128x128@2x.png" >/dev/null
  sips -z 512 512 "${FAVICON}" --out "${ICONSET}/icon_256x256@2x.png" >/dev/null
  sips -z 1024 1024 "${FAVICON}" --out "${ICONSET}/icon_512x512@2x.png" >/dev/null
  iconutil -c icns "${ICONSET}" -o "${APP_RESOURCES}/ForkDeck.icns"
fi

touch "${APP_DEST}"
echo "Installed ${APP_DEST}"
