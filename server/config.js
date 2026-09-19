const path = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.PORT || 4173);
// Installed applications may start in an unwritable or nonexistent directory.
const ROOT = os.homedir();
const PUBLIC_DIR = path.join(__dirname, "..", "public");
function defaultDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "ForkDeck");
  if (platform === "win32") return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "ForkDeck");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "ForkDeck");
}

const DATA_DIR = process.env.FORKDECK_DATA_DIR
  ? path.resolve(process.env.FORKDECK_DATA_DIR)
  : defaultDataDir();
const PROFILE_FILE = path.join(DATA_DIR, "profiles.json");
const REPO_FILE = path.join(DATA_DIR, "repos.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png"
};

module.exports = { PORT, ROOT, PUBLIC_DIR, DATA_DIR, PROFILE_FILE, REPO_FILE, MIME, defaultDataDir };
