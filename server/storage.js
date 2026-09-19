const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { DATA_DIR, PROFILE_FILE, REPO_FILE } = require("./config");

async function readStore(file, key) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || !Array.isArray(value[key])) throw new Error(`ForkDeck's ${key} data is invalid. Restore it from a backup before saving changes.`);
    return value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const defaults = { [key]: [] };
    // Exclusive creation avoids overwriting a first save from another request.
    await fs.writeFile(file, JSON.stringify(defaults, null, 2), { flag: "wx", mode: 0o600 }).catch((createError) => {
      if (createError.code !== "EEXIST") throw createError;
    });
    if (await fs.readFile(file, "utf8") !== JSON.stringify(defaults, null, 2)) return readStore(file, key);
    return defaults;
  }
}

async function saveStore(file, payload) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

const ensureProfiles = () => readStore(PROFILE_FILE, "profiles");
const saveProfiles = (payload) => saveStore(PROFILE_FILE, payload);
const ensureRepos = () => readStore(REPO_FILE, "repos");
const saveRepos = (payload) => saveStore(REPO_FILE, payload);

function cleanProfile(input) {
  const color = String(input.color || "#2563eb").trim();
  const profile = {
    id: input.id || crypto.randomUUID(),
    label: String(input.label || "").trim(),
    github: String(input.github || "").trim().replace(/^@/, ""),
    name: String(input.name || "").trim(),
    email: String(input.email || "").trim(),
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb"
  };

  if (!profile.label || !profile.name || !profile.email) {
    const error = new Error("Profile needs a label, commit name, and commit email.");
    error.status = 400;
    throw error;
  }

  return profile;
}

module.exports = { ensureProfiles, saveProfiles, ensureRepos, saveRepos, cleanProfile };
