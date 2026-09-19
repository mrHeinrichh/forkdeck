const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-server-test-"));
process.env.FORKDECK_DATA_DIR = path.join(temporary, "app data");
process.env.GIT_CONFIG_GLOBAL = path.join(temporary, "isolated-gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.FORKDECK_DESKTOP_TOKEN;
const { createServer } = require("../server/app");
const { resolveCommand } = require("../server/commands");
const { ensureProfiles, saveProfiles } = require("../server/storage");

function request(server, pathname, { method = "GET", headers = {}, body } = {}) {
  const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: server.address().port, path: pathname, method,
      headers: { ...(data ? { "content-length": Buffer.byteLength(data) } : {}), ...headers }
    }, (res) => {
      let output = "";
      res.on("data", (chunk) => { output += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: output,
        json: () => JSON.parse(output) }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("local browser and desktop API boundaries with real server requests", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    delete process.env.FORKDECK_DESKTOP_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(temporary, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const writeHeaders = { "content-type": "application/json", "x-forkdeck-request": "1", origin };

  await t.test("same-origin browser reads and protected writes work", async () => {
    assert.equal((await request(server, "/")).status, 200);
    const response = await request(server, "/api/profiles", { method: "POST", headers: writeHeaders,
      body: { label: "Test", name: "Test User", email: "test@example.invalid" } });
    assert.equal(response.status, 200);
    assert.equal((await request(server, "/api/profiles")).json().profiles.length, 1);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.match(response.headers["content-security-policy"], /script-src 'self'/);
  });

  await t.test("other websites and rebound hosts cannot read or mutate the API", async () => {
    for (const headers of [
      { origin: "https://example.com" }, { origin: "null" }, { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" }, { host: `evil.example:${server.address().port}` },
      { host: "127.0.0.1:1" }
    ]) {
      assert.equal((await request(server, "/api/profiles", { headers })).status, 403);
    }
    assert.equal((await request(server, "/api/profiles", { method: "POST", body: {} })).status, 403);
    assert.equal((await request(server, "/api/profiles", { method: "OPTIONS", headers: { origin: "https://example.com" } })).status, 403);
    assert.equal((await request(server, "/api/profiles")).json().profiles.length, 1);
  });

  await t.test("bad JSON and oversized bodies return useful client errors", async () => {
    assert.equal((await request(server, "/api/profiles", { method: "POST", headers: writeHeaders, body: "{broken" })).status, 400);
    assert.equal((await request(server, "/api/profiles", { method: "POST", headers: writeHeaders, body: [] })).status, 400);
    assert.equal((await request(server, "/api/profiles", { method: "POST", headers: writeHeaders, body: "a".repeat(1024 * 1024 + 1) })).status, 413);
  });

  await t.test("desktop APIs require the launch token even from another local client", async () => {
    process.env.FORKDECK_DESKTOP_TOKEN = "test-desktop-token";
    assert.equal((await request(server, "/api/profiles")).status, 401);
    assert.equal((await request(server, "/api/profiles", { headers: { "x-forkdeck-token": "wrong" } })).status, 401);
    assert.equal((await request(server, "/api/profiles", { headers: { "x-forkdeck-token": "test-desktop-token" } })).status, 200);
    delete process.env.FORKDECK_DESKTOP_TOKEN;
  });

  await t.test("Git snapshots work for repositories and filenames containing spaces and Unicode", async () => {
    const repo = path.join(temporary, "local repo café");
    await fsp.mkdir(repo);
    const run = (...args) => execFileSync(resolveCommand("git"), args, { cwd: repo, env: process.env, stdio: "pipe" });
    run("init", "-b", "main");
    run("config", "user.name", "ForkDeck Test");
    run("config", "user.email", "test@example.invalid");
    await fsp.writeFile(path.join(repo, "old name.txt"), "test\n");
    run("add", "--", "old name.txt");
    run("commit", "-m", "Initial commit");
    run("mv", "--", "old name.txt", "renamed café.txt");
    const response = await request(server, `/api/repo?path=${encodeURIComponent(repo)}`);
    assert.equal(response.status, 200, response.body);
    assert.equal(response.json().files[0].file, "renamed café.txt");
    assert.equal(response.json().files[0].originalFile, "old name.txt");
    assert.equal(response.json().branch, "main");
    run("commit", "-m", "Rename file");
    const hash = run("rev-parse", "HEAD").toString().trim();
    const files = await request(server, `/api/repo/commit-files?path=${encodeURIComponent(repo)}&hash=${hash}`);
    assert.equal(files.json().files[0].file, "renamed café.txt");
    assert.equal(files.json().files[0].label, "Renamed");
    const history = (await request(server, `/api/repo?path=${encodeURIComponent(repo)}`)).json();
    assert.equal(history.commits[1].subject, "Initial commit");
    assert.equal(history.commits[1].refs, "");
  });

  await t.test("profiles persist in user data and corrupted data is preserved", async () => {
    const data = await ensureProfiles();
    data.profiles[0].label = "Updated";
    await saveProfiles(data);
    assert.equal((await ensureProfiles()).profiles[0].label, "Updated");
    assert.ok((await fsp.readdir(process.env.FORKDECK_DATA_DIR)).every((name) => !name.endsWith(".tmp")));
    const profilePath = path.join(process.env.FORKDECK_DATA_DIR, "profiles.json");
    await fsp.writeFile(profilePath, "{broken");
    await assert.rejects(ensureProfiles());
    assert.equal(await fsp.readFile(profilePath, "utf8"), "{broken");
  });
});
