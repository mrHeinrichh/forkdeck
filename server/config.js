const path = require("node:path");

const PORT = Number(process.env.PORT || 4173);
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DATA_DIR = path.join(__dirname, "..", "data");
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

module.exports = { PORT, ROOT, PUBLIC_DIR, DATA_DIR, PROFILE_FILE, REPO_FILE, MIME };
