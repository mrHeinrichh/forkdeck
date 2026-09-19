const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-commit-workflows-")));
for (const key of Object.keys(process.env)) {
  if (/^(GIT_|FORKDECK_|GH_|GITHUB_TOKEN$)/.test(key)) delete process.env[key];
}
process.env.FORKDECK_DATA_DIR = path.join(temporary, "app data");
process.env.GIT_CONFIG_GLOBAL = path.join(temporary, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GH_CONFIG_DIR = path.join(temporary, "gh");
const { createServer } = require("../server/app");
const { resolveCommand } = require("../server/commands");

function run(repo, ...args) {
  return execFileSync(resolveCommand("git"), ["-C", repo, ...args], { env: process.env, stdio: "pipe" }).toString().replace(/\r?\n$/, "");
}
async function repository(name, initial = true) {
  const root = path.join(temporary, name);
  await fsp.mkdir(root);
  run(root, "init", "-b", "main");
  run(root, "config", "user.name", "ForkDeck QA");
  run(root, "config", "user.email", "qa@example.invalid");
  run(root, "config", "commit.gpgsign", "false");
  run(root, "config", "core.autocrlf", "false");
  run(root, "config", "core.hooksPath", path.join(temporary, "empty-hooks"));
  if (initial) {
    await fsp.writeFile(path.join(root, "tracked.txt"), "initial\n");
    run(root, "add", ".");
    run(root, "commit", "-m", "Initial commit");
  }
  return root;
}
function request(server, pathname, method = "GET", body) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: pathname, method,
      headers: data ? { "content-type": "application/json", "x-forkdeck-request": "1", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      let output = "";
      res.on("data", (chunk) => { output += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(output) }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("staging and commit HTTP workflows preserve working files in disposable repositories", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(temporary, { recursive: true, force: true });
  });
  const get = (route, params = {}) => request(server, `${route}?${new URLSearchParams(params)}`);
  const post = (action, body) => request(server, `/api/repo/${action}`, "POST", body);
  const ok = (response) => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  const staged = (repo) => run(repo, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean).sort();

  await t.test("unborn repositories stage and unstage one or all files without losing later edits", async () => {
    const root = await repository("unborn", false);
    await fsp.mkdir(path.join(root, "nested"));
    await fsp.writeFile(path.join(root, "nested/café.txt"), "staged version\n");
    await fsp.writeFile(path.join(root, "other.txt"), "other\n");
    let result = ok(await post("stage", { path: root, file: "nested/café.txt" }));
    assert.equal(result.repo.files.find((file) => file.file === "nested/café.txt").index, "A");
    assert.deepEqual(staged(root), ["nested/café.txt"]);
    await fsp.writeFile(path.join(root, "nested/café.txt"), "later unstaged version\n");
    ok(await post("unstage", { path: root, file: "nested/café.txt" }));
    assert.deepEqual(staged(root), []);
    assert.equal(await fsp.readFile(path.join(root, "nested/café.txt"), "utf8"), "later unstaged version\n");
    ok(await post("stage", { path: root }));
    assert.deepEqual(staged(root), ["nested/café.txt", "other.txt"]);
    result = ok(await post("unstage", { path: root }));
    assert.ok(result.repo.files.every((file) => file.index === "?"));
    assert.deepEqual(staged(root), []);
    assert.equal(await fsp.readFile(path.join(root, "other.txt"), "utf8"), "other\n");
    assert.equal((await get("/api/repo/commit-message", { path: root })).status, 400);
    assert.match((await post("commit", { path: root, message: "No changes" })).body.error, /Stage at least/);
    assert.match((await post("commit", { path: root, message: "Amend unborn", amend: true })).body.error, /first commit/);
    ok(await post("stage", { path: root }));
    result = ok(await post("commit", { path: root, message: "First commit", expectedHead: "" }));
    assert.equal(result.repo.files.length, 0);
    assert.equal(result.repo.commits.length, 1);
    assert.equal(result.hash, run(root, "rev-parse", "HEAD"));
  });

  await t.test("literal and leading-dash filenames never expand pathspecs or escape the repository", async () => {
    const root = await repository("literal files");
    for (const file of ["[one].txt", "o.txt", "--force.txt"]) await fsp.writeFile(path.join(root, file), `${file}\n`);
    ok(await post("stage", { path: root, file: "[one].txt" }));
    assert.deepEqual(staged(root), ["[one].txt"]);
    ok(await post("stage", { path: root, file: "--force.txt" }));
    assert.deepEqual(staged(root), ["--force.txt", "[one].txt"]);
    ok(await post("unstage", { path: root, file: "[one].txt" }));
    assert.deepEqual(staged(root), ["--force.txt"]);
    for (const file of ["../outside.txt", ".git/config", "", null, "*", ":(glob)*", "bad\0file", root]) {
      for (const action of ["stage", "unstage"]) {
        const response = await post(action, { path: root, file });
        assert.equal(response.status, 400, `${action} ${String(file)}: ${JSON.stringify(response.body)}`);
      }
    }
    assert.deepEqual(staged(root), ["--force.txt"]);
    ok(await post("unstage", { path: root }));
    assert.deepEqual(staged(root), []);
    assert.equal(await fsp.readFile(path.join(root, "--force.txt"), "utf8"), "--force.txt\n");
  });

  await t.test("commits include only the staged version and preserve unstaged and untracked work", async () => {
    const root = await repository("partial commit");
    const parent = run(root, "rev-parse", "HEAD");
    await fsp.writeFile(path.join(root, "tracked.txt"), "reviewed content\n");
    ok(await post("stage", { path: root, file: "tracked.txt" }));
    await fsp.writeFile(path.join(root, "tracked.txt"), "work in progress\n");
    await fsp.writeFile(path.join(root, "untracked.txt"), "not selected\n");
    const message = "--leading-dash subject\n\nA multiline explanation with `literal` and $(literal).";
    const result = ok(await post("commit", { path: root, message, expectedHead: parent }));
    assert.equal(run(root, "rev-parse", "HEAD^"), parent);
    assert.equal(run(root, "show", "HEAD:tracked.txt"), "reviewed content");
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), "work in progress\n");
    assert.equal(await fsp.readFile(path.join(root, "untracked.txt"), "utf8"), "not selected\n");
    assert.deepEqual(staged(root), []);
    assert.equal(result.repo.files.find((file) => file.file === "tracked.txt").worktree, "M");
    assert.equal(run(root, "show", "-s", "--format=%an <%ae>", "HEAD"), "ForkDeck QA <qa@example.invalid>");
    assert.equal(ok(await get("/api/repo/commit-message", { path: root })).message, message);
  });

  await t.test("deleted and renamed files unstage without restoring or discarding working files", async () => {
    const root = await repository("rename and deletion");
    await fsp.unlink(path.join(root, "tracked.txt"));
    let result = ok(await post("stage", { path: root, file: "tracked.txt" }));
    assert.equal(result.repo.files[0].index, "D");
    ok(await post("unstage", { path: root, file: "tracked.txt" }));
    assert.equal(fs.existsSync(path.join(root, "tracked.txt")), false);
    assert.deepEqual(staged(root), []);
    await fsp.writeFile(path.join(root, "tracked.txt"), "initial\n");
    run(root, "mv", "tracked.txt", "renamed café.txt");
    await fsp.writeFile(path.join(root, "renamed café.txt"), "later rename edit\n");
    result = ok(await post("unstage", { path: root, file: "renamed café.txt" }));
    assert.deepEqual(staged(root), []);
    assert.equal(fs.existsSync(path.join(root, "tracked.txt")), false);
    assert.equal(await fsp.readFile(path.join(root, "renamed café.txt"), "utf8"), "later rename edit\n");
    assert.ok(result.repo.files.some((file) => file.file === "tracked.txt" && file.worktree === "D"));
    ok(await post("stage", { path: root }));
    ok(await post("commit", { path: root, message: "Rename and edit" }));
    assert.equal(run(root, "show", "HEAD:renamed café.txt"), "later rename edit");
    await fsp.unlink(path.join(root, "renamed café.txt"));
    ok(await post("stage", { path: root }));
    result = ok(await post("commit", { path: root, message: "Remove renamed file" }));
    assert.equal(result.repo.files.length, 0);
  });

  await t.test("amend preserves original authorship, replaces only HEAD and respects staged selection", async () => {
    const root = await repository("amend");
    const original = run(root, "rev-parse", "HEAD");
    run(root, "config", "user.name", "Different Committer");
    run(root, "config", "user.email", "committer@example.invalid");
    let result = ok(await post("commit", { path: root, message: "Corrected first message", amend: true, expectedHead: original }));
    assert.notEqual(result.hash, original);
    assert.equal(run(root, "rev-list", "--count", "HEAD"), "1");
    assert.equal(run(root, "show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"), "ForkDeck QA <qa@example.invalid>|Different Committer <committer@example.invalid>");
    await fsp.writeFile(path.join(root, "tracked.txt"), "include in amended commit\n");
    ok(await post("stage", { path: root, file: "tracked.txt" }));
    await fsp.writeFile(path.join(root, "tracked.txt"), "do not include\n");
    const current = result.hash;
    const stale = await post("commit", { path: root, message: "Stale amendment", amend: true, expectedHead: original });
    assert.equal(stale.status, 409);
    assert.equal(run(root, "rev-parse", "HEAD"), current);
    assert.deepEqual(staged(root), ["tracked.txt"]);
    result = ok(await post("commit", { path: root, message: "Final amended message", amend: true, expectedHead: current }));
    assert.equal(run(root, "rev-list", "--count", "HEAD"), "1");
    assert.equal(run(root, "show", "HEAD:tracked.txt"), "include in amended commit");
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), "do not include\n");
    assert.equal(result.repo.files[0].worktree, "M");
  });

  await t.test("invalid commit input leaves HEAD, index and working files intact", async () => {
    const root = await repository("validation");
    const hash = run(root, "rev-parse", "HEAD");
    await fsp.writeFile(path.join(root, "tracked.txt"), "staged safely\n");
    ok(await post("stage", { path: root }));
    for (const input of [{ message: "" }, { message: " \n\t " }, { message: null }, { message: "bad\0message" }, { message: "x".repeat(16385) }, { message: "Good message", amend: "true" }]) {
      assert.equal((await post("commit", { path: root, ...input })).status, 400);
    }
    assert.equal((await post("commit", { path: root, message: "Wrong revision", expectedHead: "not HEAD" })).status, 409);
    assert.equal(run(root, "rev-parse", "HEAD"), hash);
    assert.equal(run(root, "show", ":tracked.txt"), "staged safely");
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), "staged safely\n");
  });

  await t.test("conflicts cannot be accidentally staged or committed; resolved operations require Continue", async () => {
    const root = await repository("conflicts");
    run(root, "checkout", "-b", "feature");
    await fsp.writeFile(path.join(root, "tracked.txt"), "feature\n");
    run(root, "commit", "-am", "Feature content");
    run(root, "checkout", "main");
    await fsp.writeFile(path.join(root, "tracked.txt"), "main\n");
    run(root, "commit", "-am", "Main content");
    assert.throws(() => run(root, "merge", "feature"));
    const unmerged = run(root, "ls-files", "--unmerged", "-z");
    const content = await fsp.readFile(path.join(root, "tracked.txt"), "utf8");
    for (const action of ["stage", "unstage"]) {
      assert.equal((await post(action, { path: root })).status, 400);
      assert.equal((await post(action, { path: root, file: "tracked.txt" })).status, 400);
    }
    assert.match((await post("commit", { path: root, message: "Should not commit" })).body.error, /conflicted/);
    assert.equal(run(root, "ls-files", "--unmerged", "-z"), unmerged);
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), content);
    await fsp.writeFile(path.join(root, "unrelated.txt"), "unrelated\n");
    ok(await post("stage", { path: root, file: "unrelated.txt" }));
    assert.equal(run(root, "show", ":unrelated.txt"), "unrelated");
    await fsp.writeFile(path.join(root, "tracked.txt"), "resolved manually\n");
    run(root, "add", "tracked.txt");
    for (const amend of [false, true]) {
      const response = await post("commit", { path: root, message: "Use Continue instead", amend });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /Continue or Abort/);
    }
  });

  await t.test("simultaneous staging requests serialize without index lock errors or lost selections", async () => {
    const root = await repository("parallel staging");
    const files = Array.from({ length: 5 }, (_, index) => `file ${index}.txt`);
    await Promise.all(files.map((file) => fsp.writeFile(path.join(root, file), `${file}\n`)));
    const results = await Promise.all(files.map((file) => post("stage", { path: root, file })));
    results.forEach(ok);
    assert.deepEqual(staged(root), files);
    ok(await post("commit", { path: root, message: "Commit all selected files" }));
    assert.deepEqual(staged(root), []);
    for (const file of files) assert.equal(run(root, "show", `HEAD:${file}`), file);
  });
});
