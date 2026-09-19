const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const childProcess = require("node:child_process");
const { promisify } = require("node:util");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-profile-auth-"));
process.env.FORKDECK_DATA_DIR = path.join(temporary, "app data");
process.env.GIT_CONFIG_GLOBAL = path.join(temporary, "isolated-gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.FORKDECK_DESKTOP_TOKEN;
const authStatePath = path.join(temporary, "fake-auth.json");
const secret = "ghp_ForkDeckFakeCredentialForRegressionOnly123456789";
const authCalls = [];
let fakeFailure = "";
let failGitEmail = false;
const realExecFile = childProcess.execFile;

// Simulate gh only. Every Git command and credential-helper lookup is real,
// with configuration and state confined to this temporary test directory.
childProcess.execFile = function (file, args, options, callback) {
  if (failGitEmail && /^git(?:\.exe)?$/i.test(path.basename(file)) && args.includes("--replace-all") && args.includes("user.email")) {
    failGitEmail = false;
    queueMicrotask(() => callback(Object.assign(new Error("simulated configuration write error"), { code: 1 }), "", "simulated configuration write error"));
    return;
  }
  if (!/^gh(?:\.exe)?$/i.test(path.basename(file))) return realExecFile.call(this, file, args, options, callback);
  authCalls.push(args);
  let stdout = "";
  let stderr = "";
  let error = null;
  try {
    if (fakeFailure && args.includes(fakeFailure)) throw new Error(`simulated gh failure: password=${secret}`);
    const state = JSON.parse(fs.readFileSync(authStatePath, "utf8"));
    if (args[0] === "--version") stdout = "gh version simulated-test\n";
    else if (args[1] === "status") stderr = `github.com\n  ✓ Logged in to github.com account ${state.user} (keyring)\n  - Active account: true\n  - Git operations protocol: https\n`;
    else if (args[1] === "switch") {
      state.user = args[args.indexOf("--user") + 1];
      fs.writeFileSync(authStatePath, JSON.stringify(state));
    } else if (args[1] === "setup-git") {
      runGit("config", "--global", "--replace-all", "credential.https://github.com.helper", "");
      runGit("config", "--global", "--add", "credential.https://github.com.helper", credentialHelper);
    } else throw new Error(`Unexpected simulated gh command: ${args.join(" ")}`);
  } catch (failure) {
    stderr = failure.message;
    error = Object.assign(new Error(stderr), { code: 1 });
  }
  queueMicrotask(() => callback(error, stdout, stderr));
};
childProcess.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
  childProcess.execFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});

const { resolveCommand } = require("../server/commands");
const { createServer } = require("../server/app");
const { PROFILE_FILE, REPO_FILE } = require("../server/config");
const { ensureRepos, updateRepos } = require("../server/storage");
const { parseGitHubRemote, parseGhAuthStatus } = require("../server/services/githubAuthService");
const { redactSensitive } = require("../server/redact");
const gitExecutable = resolveCommand("git");
function runGit(...args) { return childProcess.execFileSync(gitExecutable, args, { env: process.env, stdio: "pipe" }).toString().trim(); }
const helperPath = path.join(temporary, "credential-helper.cjs");
fs.writeFileSync(helperPath, `const fs = require('node:fs'); const s = JSON.parse(fs.readFileSync(${JSON.stringify(authStatePath)}, 'utf8')); process.stdin.resume(); process.stdin.on('end', () => { if (process.argv[2] === 'get') process.stdout.write('username=' + (s.stale ? 'wrong-account' : s.user) + '\\npassword=${secret}\\n\\n'); });`);
const credentialHelper = `!"${process.execPath.replace(/\\/g, "/")}" "${helperPath.replace(/\\/g, "/")}"`;
fs.writeFileSync(authStatePath, JSON.stringify({ user: "old-account", stale: false }));

function request(server, route, method = "GET", body) {
  const content = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route, method,
      headers: { "content-type": "application/json", "x-forkdeck-request": "1", ...(content ? { "content-length": Buffer.byteLength(content) } : {}) }
    }, (res) => {
      let output = "";
      res.on("data", (chunk) => { output += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: output, data: JSON.parse(output) }));
    });
    req.on("error", reject);
    req.end(content);
  });
}

test("profile, identity, store and simulated GitHub-auth regression flows", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    childProcess.execFile = realExecFile;
    await fsp.rm(temporary, { recursive: true, force: true });
  });
  const profile = { label: "Work", name: "Commit Author", email: "author@example.invalid", github: "@target-user", color: "#123456" };
  let saved;
  const repo = path.join(temporary, "repository café");
  const another = path.join(temporary, "another repository");
  fs.mkdirSync(repo);
  fs.mkdirSync(another);
  runGit("init", "-b", "main", repo);
  runGit("init", "-b", "main", another);
  runGit("config", "--global", "user.name", "Global Author");
  runGit("config", "--global", "user.email", "global@example.invalid");

  await t.test("CRUD preserves IDs and rejects invalid, duplicate and missing profiles", async () => {
    const created = await request(server, "/api/profiles", "POST", profile);
    assert.equal(created.status, 200, created.body);
    saved = created.data.profile;
    assert.equal(saved.github, "target-user");
    assert.equal((await request(server, "/api/profiles", "POST", { ...profile, label: "work" })).status, 409);
    for (const invalid of [{ name: {} }, { email: "bad-email" }, { github: "invalid/user" }, { label: "line\nbreak" }, { id: {} }, { name: "Bad <Author>" }]) {
      assert.equal((await request(server, "/api/profiles", "POST", { ...profile, ...invalid })).status, 400);
    }
    const edited = await request(server, "/api/profiles", "POST", { ...saved, label: "Updated Work" });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.profile.id, saved.id);
    assert.equal(edited.data.profiles.length, 1);
    assert.equal((await request(server, "/api/profiles", "POST", { ...saved, id: "missing" })).status, 404);
    assert.equal((await request(server, "/api/profiles/%invalid", "DELETE")).status, 400);
    assert.equal((await request(server, "/api/profiles/missing", "DELETE")).status, 404);
  });

  await t.test("concurrent profile creates and edits do not lose stored profiles", async () => {
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => request(server, "/api/profiles", "POST", { ...profile, label: `Concurrent ${i}` })));
    assert.ok(results.every((response) => response.status === 200));
    let profiles = (await request(server, "/api/profiles")).data.profiles;
    assert.equal(profiles.length, 25);
    assert.equal(new Set(profiles.map((item) => item.id)).size, 25);
    await Promise.all(profiles.map((item) => request(server, "/api/profiles", "POST", { ...item, label: `${item.label} edited` })));
    profiles = (await request(server, "/api/profiles")).data.profiles;
    assert.ok(profiles.every((item) => item.label.endsWith(" edited")));
    const deleted = await request(server, `/api/profiles/${profiles[1].id}`, "DELETE");
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.profiles.length, 24);
  });

  await t.test("real Git identity switch applies only to selected repository and actual new commits", async () => {
    assert.equal((await request(server, "/api/switch", "POST", { profileId: saved.id })).status, 400);
    const applied = await request(server, "/api/switch", "POST", { profileId: saved.id, path: repo });
    assert.equal(applied.status, 200, applied.body);
    assert.deepEqual(applied.data.identity, { name: profile.name, email: profile.email });
    assert.equal(runGit("-C", repo, "config", "user.name"), profile.name);
    assert.equal(runGit("-C", another, "config", "user.name"), "Global Author");
    assert.equal(runGit("config", "--global", "user.email"), "global@example.invalid");
    runGit("-C", repo, "commit", "--allow-empty", "-m", "Commit with selected identity");
    assert.equal(runGit("-C", repo, "log", "-1", "--format=%an <%ae>"), `${profile.name} <${profile.email}>`);
    const alternatives = (await request(server, "/api/profiles")).data.profiles.slice(0, 8);
    await Promise.all(alternatives.map((item, i) => request(server, "/api/profiles", "POST", { ...item, name: `Name ${i}`, email: `email${i}@example.invalid` })));
    await Promise.all(alternatives.map((item) => request(server, "/api/switch", "POST", { profileId: item.id, path: repo })));
    const name = runGit("-C", repo, "config", "user.name");
    assert.equal(runGit("-C", repo, "config", "user.email"), `email${name.split(" ")[1]}@example.invalid`);
    failGitEmail = true;
    const failed = await request(server, "/api/switch", "POST", { profileId: alternatives[0].id, path: repo });
    assert.equal(failed.status, 400);
    assert.equal(runGit("-C", repo, "config", "user.name"), name);
    assert.equal(runGit("-C", repo, "config", "user.email"), `email${name.split(" ")[1]}@example.invalid`);
  });

  await t.test("concurrent repository transactions retain every record and recover after failure", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateRepos((store) => { store.repos.push({ root: `repo-${i}` }); })));
    assert.equal((await ensureRepos()).repos.length, 20);
    await assert.rejects(updateRepos(() => { throw new Error("simulated failure"); }));
    await updateRepos((store) => { store.repos.push({ root: "after-failure" }); });
    assert.equal((await ensureRepos()).repos.length, 21);
  });

  await t.test("auth repair rejects bad paths and SSH remotes before simulated gh mutation", async () => {
    const before = authCalls.length;
    for (const body of [{ path: repo, user: "bad/user" }, { path: "", user: "target-user" }, { path: path.join(temporary, "missing"), user: "target-user" }, { path: repo, user: {} }]) {
      assert.equal((await request(server, "/api/auth/github/fix", "POST", body)).status, 400);
    }
    runGit("-C", repo, "remote", "add", "origin", "git@github.com:owner/project.git");
    const ssh = await request(server, "/api/auth/github/fix", "POST", { path: repo, user: "target-user" });
    assert.equal(ssh.status, 400);
    assert.match(ssh.data.error, /SSH/);
    assert.equal(authCalls.length, before);
    runGit("-C", repo, "remote", "set-url", "origin", "https://github.com/owner/project.git");
    runGit("-C", repo, "config", "remote.origin.pushurl", "git@github.com:owner/project.git");
    assert.equal((await request(server, "/api/auth/github/fix", "POST", { path: repo, user: "target-user" })).status, 400);
    assert.equal(authCalls.length, before);
    runGit("-C", repo, "config", "--unset", "remote.origin.pushurl");
  });

  await t.test("simulated gh repair checks real repository credential resolution without exposing secrets", async () => {
    runGit("-C", repo, "remote", "set-url", "origin", `https://${secret}:fake-password@github.com/owner/project.git`);
    runGit("-C", repo, "config", "credential.helper", credentialHelper);
    const checked = await request(server, `/api/auth/github?path=${encodeURIComponent(repo)}`);
    assert.equal(checked.status, 200, checked.body);
    assert.equal(checked.data.credential.username, "");
    assert.equal(checked.data.credential.hasPassword, true);
    assert.ok(!checked.body.includes(secret));
    assert.ok(!checked.body.includes("fake-password"));
    assert.equal((await request(server, "/api/auth/github/fix", "POST", { path: repo, user: "target-user" })).status, 409);
    runGit("-C", repo, "remote", "set-url", "origin", "https://github.com/owner/project.git");
    const fixed = await request(server, "/api/auth/github/fix", "POST", { path: repo, user: "target-user" });
    assert.equal(fixed.status, 200, fixed.body);
    assert.equal(fixed.data.gh.activeUser, "target-user");
    assert.equal(fixed.data.credential.username, "target-user");
    assert.ok(!fixed.body.includes(secret));
    assert.ok(!fixed.body.includes(helperPath));
    fs.writeFileSync(authStatePath, JSON.stringify({ user: "target-user", stale: true }));
    const stale = await request(server, "/api/auth/github/fix", "POST", { path: repo, user: "target-user" });
    assert.equal(stale.status, 409, stale.body);
    fakeFailure = "switch";
    const failed = await request(server, "/api/auth/github/fix", "POST", { path: repo, user: "target-user" });
    assert.equal(failed.status, 400);
    assert.ok(!failed.body.includes(secret));
    fakeFailure = "";
    fs.writeFileSync(authStatePath, JSON.stringify({ user: "target-user", stale: false }));
    const concurrent = await Promise.all(["first-user", "second-user", "third-user"].map((user) => request(server, "/api/auth/github/fix", "POST", { path: repo, user })));
    assert.ok(concurrent.every((response) => response.status === 200), JSON.stringify(concurrent));
    assert.deepEqual(concurrent.map((response) => response.data.credential.username), ["first-user", "second-user", "third-user"]);
  });

  await t.test("corrupt stores are preserved and writes resume after restoration", async () => {
    const original = await fsp.readFile(PROFILE_FILE, "utf8");
    for (const broken of ["{broken", '{"profiles":[null]}', '{"profiles":[{"id":"x"}]}']) {
      await fsp.writeFile(PROFILE_FILE, broken);
      assert.ok((await request(server, "/api/profiles", "POST", profile)).status >= 400);
      assert.equal(await fsp.readFile(PROFILE_FILE, "utf8"), broken);
    }
    await fsp.writeFile(PROFILE_FILE, original);
    assert.equal((await request(server, "/api/profiles", "POST", { ...profile, label: "After restoration" })).status, 200);
    await fsp.writeFile(REPO_FILE, '{"repos":[null]}');
    await assert.rejects(updateRepos((store) => { store.repos.push({ root: "do-not-write" }); }));
    assert.equal(await fsp.readFile(REPO_FILE, "utf8"), '{"repos":[null]}');
    assert.ok((await fsp.readdir(process.env.FORKDECK_DATA_DIR)).every((name) => !name.endsWith(".tmp")));
  });
});

test("GitHub remote parsing and diagnostic redaction cover credentials and SSH URL variants", () => {
  for (const remote of ["https://github.com/owner/project.git/", "ssh://git@github.com/owner/project.git", "git@github.com:owner/project.git"]) {
    assert.equal(parseGitHubRemote(remote).repo, "project");
  }
  assert.equal(parseGitHubRemote("https://github.com/owner/repo\nusername=evil").host, "");
  assert.equal(parseGitHubRemote("https://notgithub.com/owner/project.git").host, "");
  assert.equal(parseGhAuthStatus("Logged in to company.example account enterprise-user\nActive account: true").activeUser, "");
  const redacted = redactSensitive(`https://user:${secret}@github.com/owner/repo?token=secret-value authorization=Bearer ${secret}`);
  for (const secretValue of [secret, "secret-value", "Bearer", "user:"]) assert.ok(!redacted.includes(secretValue));
});
