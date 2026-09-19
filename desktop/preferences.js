const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const keys = ["repoPath", "browserPath"];
const defaults = () => ({ repoPath: "", browserPath: "" });

function validatePreferences(input, partial = false, pathApi = path) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !keys.includes(key))) throw new Error("Invalid workspace preferences.");
  const result = partial ? {} : defaults();
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (typeof value !== "string" || value.length > 32768 || value.includes("\0") ||
        (value !== "" && !pathApi.isAbsolute(value))) throw new Error(`Invalid ${key} preference.`);
    result[key] = value;
  }
  return result;
}

function createPreferenceStore(file) {
  let pending = Promise.resolve();
  async function read() {
    try { return validatePreferences(JSON.parse(await fs.readFile(file, "utf8"))); }
    catch (error) {
      if (error.code === "ENOENT") return defaults();
      throw new Error("ForkDeck workspace preferences could not be read. Restore preferences.json from a backup before saving changes.", { cause: error });
    }
  }
  return {
    async get() { await pending.catch(() => {}); return read(); },
    set(input) {
      const changes = validatePreferences(input, true);
      const operation = pending.catch(() => {}).then(async () => {
        const preferences = { ...await read(), ...changes };
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(preferences, null, 2), { mode: 0o600 });
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
        return preferences;
      });
      pending = operation;
      return operation;
    },
    async flush() { await pending; }
  };
}

module.exports = { createPreferenceStore, validatePreferences };
