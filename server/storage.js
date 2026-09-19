const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { DATA_DIR, PROFILE_FILE, REPO_FILE } = require("./config");
const pendingUpdates = new Map();

async function readStore(file, key) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || !Array.isArray(value[key]) || value[key].some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new Error(`ForkDeck's ${key} data is invalid. Restore it from a backup before saving changes.`);
    }
    if (key === "profiles") {
      const ids = new Set();
      for (const profile of value.profiles) {
        cleanProfile(profile);
        if (!profile.id || ids.has(profile.id)) throw new Error("ForkDeck's profiles data has missing or duplicate IDs. Restore it from a backup before saving changes.");
        ids.add(profile.id);
      }
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { [key]: [] };
    if (error instanceof SyntaxError) throw new Error(`ForkDeck's ${key} data is invalid JSON. Restore it from a backup before saving changes.`);
    throw error;
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

// Serialize the entire read/modify/write transaction, not just the atomic write.
// Failed mutations must not prevent later requests from using the store.
function updateStore(file, key, mutate) {
  const update = (pendingUpdates.get(file) || Promise.resolve()).then(async () => {
    const store = await readStore(file, key);
    await mutate(store);
    await saveStore(file, store);
    return store;
  });
  const settled = update.catch(() => {});
  pendingUpdates.set(file, settled);
  settled.then(() => { if (pendingUpdates.get(file) === settled) pendingUpdates.delete(file); });
  return update;
}

const updateProfiles = (mutate) => updateStore(PROFILE_FILE, "profiles", mutate);
const updateRepos = (mutate) => updateStore(REPO_FILE, "repos", mutate);

function profileField(input, key, maxLength, fallback = "") {
  const raw = input[key] === undefined ? fallback : input[key];
  if (typeof raw !== "string" || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > maxLength) {
    throw Object.assign(new Error(`Profile ${key} must be text without control characters, up to ${maxLength} characters.`), { status: 400 });
  }
  return raw.trim();
}

function cleanProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Profile must be an object."), { status: 400 });
  const color = profileField(input, "color", 32, "#2563eb");
  const profile = {
    id: profileField(input, "id", 128) || crypto.randomUUID(),
    label: profileField(input, "label", 200),
    github: profileField(input, "github", 40).replace(/^@/, ""),
    name: profileField(input, "name", 200),
    email: profileField(input, "email", 320),
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb"
  };

  if (!profile.label || !profile.name || !profile.email) {
    const error = new Error("Profile needs a label, commit name, and commit email.");
    error.status = 400;
    throw error;
  }

  if (!/^[a-z\d_-]+$/i.test(profile.id) || /[<>]/.test(profile.name) ||
      !/^[^\s<>@]+@[^\s<>@]+$/.test(profile.email) ||
      (profile.github && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(profile.github))) {
    throw Object.assign(new Error("Enter a valid profile ID, commit name, email, and GitHub username."), { status: 400 });
  }

  return profile;
}

module.exports = { ensureProfiles, saveProfiles, updateProfiles, ensureRepos, saveRepos, updateRepos, cleanProfile };
