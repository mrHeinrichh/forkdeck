const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createPreferenceStore, validatePreferences } = require("../desktop/preferences");

async function fixture(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "forkdeck-preferences-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, "user-data", "preferences.json");
  return { scratch, file, store: createPreferenceStore(file) };
}

test("preferences survive a fresh store and keep repository and folder selections independent", async (t) => {
  const { scratch, file, store } = await fixture(t);
  assert.deepEqual(await store.get(), { repoPath: "", browserPath: "" });
  const repoPath = path.join(scratch, "a repo with spaces");
  await store.set({ repoPath });
  await store.set({ browserPath: scratch });
  assert.deepEqual(await createPreferenceStore(file).get(), { repoPath, browserPath: scratch });
  await store.set({ repoPath: "" });
  assert.deepEqual(await store.get(), { repoPath: "", browserPath: scratch });
});

test("overlapping preference changes serialize without losing either key", async (t) => {
  const { scratch, file, store } = await fixture(t);
  await Promise.all([store.set({ repoPath: path.join(scratch, "first") }), store.set({ browserPath: scratch }), store.set({ repoPath: path.join(scratch, "second") })]);
  await store.flush();
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { repoPath: path.join(scratch, "second"), browserPath: scratch });
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["preferences.json"]);
});

test("invalid stored preferences are preserved instead of overwritten", async (t) => {
  const { scratch, file, store } = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{broken");
  await assert.rejects(store.get(), /could not be read/);
  await assert.rejects(store.set({ browserPath: scratch }), /could not be read/);
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});

test("native preferences accept only bounded absolute path fields", () => {
  assert.deepEqual(validatePreferences({ repoPath: "/projects/demo" }, false, path.posix), { repoPath: "/projects/demo", browserPath: "" });
  assert.deepEqual(validatePreferences({ browserPath: "C:\\Projects" }, true, path.win32), { browserPath: "C:\\Projects" });
  assert.deepEqual(validatePreferences({ repoPath: "\\\\server\\share\\repo" }, true, path.win32), { repoPath: "\\\\server\\share\\repo" });
  for (const value of [null, [], "a string", { file: "/tmp" }, { repoPath: 2 }, { repoPath: "relative/path" }, { repoPath: "/tmp/\0bad" }, { repoPath: "/".repeat(32769) }]) assert.throws(() => validatePreferences(value));
});
