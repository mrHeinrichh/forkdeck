const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { DATA_DIR, PROFILE_FILE, REPO_FILE } = require("./config");

async function ensureProfiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(PROFILE_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const defaults = { profiles: [] };
    await fs.writeFile(PROFILE_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

async function saveProfiles(payload) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PROFILE_FILE, JSON.stringify(payload, null, 2));
}

async function ensureRepos() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(REPO_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const defaults = { repos: [] };
    await fs.writeFile(REPO_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

async function saveRepos(payload) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(REPO_FILE, JSON.stringify(payload, null, 2));
}

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
