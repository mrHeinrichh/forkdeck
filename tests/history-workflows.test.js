const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-history-")));
for (const key of Object.keys(process.env)) if (/^(GIT_|GH_|GITHUB_|FORKDECK_)/.test(key)) delete process.env[key];
process.env.FORKDECK_DATA_DIR = path.join(temporary, "app data");
process.env.GIT_CONFIG_GLOBAL = path.join(temporary, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
const { createServer } = require("../server/app");
const { resolveCommand } = require("../server/commands");
const { PATCH_LIMIT } = require("../server/routes/history");

function run(repo, ...args) {
  return execFileSync(resolveCommand("git"), ["-C", repo, ...args], { env: process.env, stdio: "pipe" }).toString().replace(/\r?\n$/, "");
}
async function write(repo, file, contents) { await fsp.writeFile(path.join(repo, file), contents); }
async function commit(repo, file, contents, message) {
  await write(repo, file, contents);
  run(repo, "add", "--", file);
  run(repo, "commit", "-m", message);
  return run(repo, "rev-parse", "HEAD");
}
async function repository(name) {
  const root = path.join(temporary, name);
  await fsp.mkdir(root);
  run(root, "init", "-b", "main");
  run(root, "config", "user.name", "History QA");
  run(root, "config", "user.email", "qa@example.invalid");
  run(root, "config", "commit.gpgsign", "false");
  run(root, "config", "core.hooksPath", path.join(temporary, "empty-hooks"));
  await commit(root, "tracked.txt", "initial\n", "Initial commit");
  return root;
}
async function conflictRepository(name) {
  const root = await repository(name);
  run(root, "checkout", "-b", "feature");
  const feature = await commit(root, "tracked.txt", "feature\n", "Feature change");
  run(root, "checkout", "main");
  const main = await commit(root, "tracked.txt", "main\n", "Main change");
  return { root, feature, main };
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

test("history operations use isolated real repositories", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(temporary, { recursive: true, force: true });
  });
  const get = (route, params = {}) => request(server, `${route}?${new URLSearchParams(params)}`);
  const post = (route, body) => request(server, route, "POST", body);
  const ok = (response) => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  const integrate = (root, action, ref) => post("/api/repo/integrate", { path: root, action, ref });
  const operation = (root, action) => post("/api/repo/operation", { path: root, action });
  const resolve = (root, side = "theirs") => post("/api/repo/conflict/resolve", { path: root, file: "tracked.txt", action: side });

  await t.test("fast-forward and divergent merges produce the expected history", async () => {
    const root = await repository("merges");
    run(root, "checkout", "-b", "feature");
    const feature = await commit(root, "feature.txt", "feature\n", "Feature");
    run(root, "checkout", "main");
    const ff = ok(await integrate(root, "merge", "feature"));
    assert.equal(ff.head, feature);
    assert.equal(ff.outcome.status, "completed");
    assert.equal(ff.operation, null);
    run(root, "checkout", "feature");
    await commit(root, "feature.txt", "feature 2\n", "Feature 2");
    run(root, "checkout", "main");
    await commit(root, "main.txt", "main\n", "Main");
    const merged = ok(await integrate(root, "merge", "feature"));
    assert.equal(merged.commits.find((item) => item.hash === merged.head).parents.length, 2);
    assert.equal(await fsp.readFile(path.join(root, "feature.txt"), "utf8"), "feature 2\n");
  });

  await t.test("merge conflicts remain visible, can be aborted and can be resolved then continued", async () => {
    const { root, main } = await conflictRepository("merge conflict");
    const conflict = ok(await integrate(root, "merge", "feature"));
    assert.equal(conflict.outcome.status, "conflicts");
    assert.deepEqual(conflict.operation, { type: "merge", conflicts: 1, canContinue: false });
    assert.equal((await operation(root, "continue")).status, 409);
    assert.equal((await integrate(root, "cherry-pick", main)).status, 409);
    const aborted = ok(await operation(root, "abort"));
    assert.equal(aborted.operation, null);
    assert.equal(aborted.head, main);
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), "main\n");
    ok(await integrate(root, "merge", "feature"));
    assert.equal(ok(await resolve(root)).operation.canContinue, true);
    // Per-action overrides must win over inherited terminal editor settings.
    process.env.GIT_EDITOR = "forkdeck-editor-must-never-be-launched";
    process.env.GIT_SEQUENCE_EDITOR = "forkdeck-sequence-editor-must-never-be-launched";
    let merged;
    try { merged = ok(await operation(root, "continue")); }
    finally { delete process.env.GIT_EDITOR; delete process.env.GIT_SEQUENCE_EDITOR; }
    assert.equal(merged.operation, null);
    assert.equal(merged.commits.find((item) => item.hash === merged.head).parents.length, 2);
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), "feature\n");
  });

  await t.test("rebase applies current branch on target without an editor", async () => {
    const root = await repository("clean rebase");
    run(root, "checkout", "-b", "feature");
    await commit(root, "feature.txt", "feature\n", "Feature change");
    run(root, "checkout", "main");
    const target = await commit(root, "main.txt", "main\n", "Main change");
    run(root, "checkout", "feature");
    const rebased = ok(await integrate(root, "rebase", "main"));
    assert.equal(rebased.branch, "feature");
    assert.equal(run(root, "rev-parse", "HEAD^"), target);
    assert.equal(rebased.outcome.status, "completed");
    assert.equal(await fsp.readFile(path.join(root, "feature.txt"), "utf8"), "feature\n");
    run(root, "checkout", "--detach");
    assert.equal((await integrate(root, "rebase", "main")).status, 400);
  });

  await t.test("rebase conflict can abort to original branch and continue after resolution", async () => {
    const { root, main, feature } = await conflictRepository("rebase conflict");
    const conflict = ok(await integrate(root, "rebase", "feature"));
    assert.equal(conflict.operation.type, "rebase");
    assert.equal(conflict.operation.conflicts, 1);
    const aborted = ok(await operation(root, "abort"));
    assert.equal(aborted.branch, "main");
    assert.equal(aborted.head, main);
    ok(await integrate(root, "rebase", "feature"));
    ok(await resolve(root));
    const rebased = ok(await operation(root, "continue"));
    assert.equal(rebased.operation, null);
    assert.equal(rebased.branch, "main");
    assert.equal(run(root, "rev-parse", "HEAD^"), feature);
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), "main\n");
  });

  await t.test("cherry-pick and revert create commits and preserve source history", async () => {
    const root = await repository("cherry and revert");
    run(root, "checkout", "-b", "feature");
    const source = await commit(root, "picked.txt", "picked\n", "Pick me");
    run(root, "checkout", "main");
    await commit(root, "main.txt", "main\n", "Distinct parent");
    const picked = ok(await integrate(root, "cherry-pick", source));
    assert.equal(picked.outcome.status, "completed");
    assert.notEqual(picked.head, source);
    assert.equal(await fsp.readFile(path.join(root, "picked.txt"), "utf8"), "picked\n");
    const reverted = ok(await integrate(root, "revert", picked.head));
    assert.equal(reverted.operation, null);
    assert.equal(fs.existsSync(path.join(root, "picked.txt")), false);
    assert.match(reverted.commits.find((item) => item.hash === reverted.head).subject, /^Revert/);
    assert.equal(run(root, "rev-parse", "feature"), source);
  });

  await t.test("an empty cherry-pick remains a visible, abortable operation", async () => {
    const root = await repository("empty cherry pick");
    const head = run(root, "rev-parse", "HEAD");
    const paused = ok(await integrate(root, "cherry-pick", head));
    assert.equal(paused.outcome.status, "paused");
    assert.equal(paused.operation.type, "cherry-pick");
    assert.equal(paused.operation.canContinue, false);
    assert.match(paused.operation.message, /no staged changes left/);
    assert.match(ok(await get("/api/repo", { path: root })).operation.message, /Abort/);
    assert.equal((await operation(root, "continue")).status, 409);
    assert.ok(paused.outcome.message.length > 0);
    const aborted = ok(await operation(root, "abort"));
    assert.equal(aborted.head, head);
    assert.equal(aborted.operation, null);
    assert.deepEqual(aborted.files, []);
  });

  await t.test("rebase continue can report a subsequent conflict before finishing", async () => {
    const root = await repository("multi conflict rebase");
    await commit(root, "other.txt", "initial\n", "Second base file");
    run(root, "checkout", "-b", "feature");
    await commit(root, "tracked.txt", "feature\n", "Feature first");
    await commit(root, "other.txt", "feature\n", "Feature second");
    run(root, "checkout", "main");
    await commit(root, "tracked.txt", "main\n", "Main first");
    await commit(root, "other.txt", "main\n", "Main second");
    assert.equal(ok(await integrate(root, "rebase", "feature")).operation.conflicts, 1);
    ok(await resolve(root));
    const next = ok(await operation(root, "continue"));
    assert.equal(next.outcome.status, "conflicts");
    assert.equal(next.operation.type, "rebase");
    assert.equal(next.files.find((file) => file.label === "Conflict").file, "other.txt");
    ok(await post("/api/repo/conflict/resolve", { path: root, file: "other.txt", action: "theirs" }));
    assert.equal(ok(await operation(root, "continue")).operation, null);
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), "main\n");
    assert.equal(await fsp.readFile(path.join(root, "other.txt"), "utf8"), "main\n");
  });

  await t.test("cherry-pick and revert conflict recovery retains complete operation state", async () => {
    const { root, feature, main } = await conflictRepository("cherry conflict");
    let conflict = ok(await integrate(root, "cherry-pick", feature));
    assert.equal(conflict.operation.type, "cherry-pick");
    assert.equal(conflict.outcome.status, "conflicts");
    assert.equal(ok(await operation(root, "abort")).head, main);
    ok(await integrate(root, "cherry-pick", feature));
    ok(await resolve(root));
    const picked = ok(await operation(root, "continue"));
    assert.equal(picked.operation, null);
    await commit(root, "tracked.txt", "later edit\n", "Later edit");
    const later = run(root, "rev-parse", "HEAD");
    conflict = ok(await integrate(root, "revert", picked.head));
    assert.equal(conflict.operation.type, "revert");
    assert.equal(ok(await operation(root, "abort")).head, later);
    ok(await integrate(root, "revert", picked.head));
    ok(await resolve(root));
    assert.equal(ok(await operation(root, "continue")).operation, null);
    assert.equal(await fsp.readFile(path.join(root, "tracked.txt"), "utf8"), "main\n");
  });

  await t.test("dirty work, invalid references and unsupported merge-commit parents are protected", async () => {
    const root = await repository("protection");
    const head = run(root, "rev-parse", "HEAD");
    await write(root, "untracked.txt", "keep me\n");
    for (const action of ["merge", "rebase", "cherry-pick", "revert"]) assert.equal((await integrate(root, action, head)).status, 409);
    assert.equal(await fsp.readFile(path.join(root, "untracked.txt"), "utf8"), "keep me\n");
    await fsp.unlink(path.join(root, "untracked.txt"));
    for (const ref of ["--help", "HEAD\n--all", "missing", {}, ""]) assert.equal((await integrate(root, "merge", ref)).status, 400);
    assert.equal((await integrate(root, "reset", head)).status, 400);
    assert.equal((await operation(root, "continue")).status, 409);
    assert.equal((await operation(root, "skip")).status, 400);
    assert.equal(run(root, "rev-parse", "HEAD"), head);
    run(root, "checkout", "-b", "feature");
    await commit(root, "feature.txt", "feature\n", "Feature");
    run(root, "checkout", "main");
    run(root, "merge", "--no-ff", "feature", "-m", "Merge");
    for (const action of ["cherry-pick", "revert"]) assert.equal((await integrate(root, action, "HEAD")).status, 400);
  });

  await t.test("branch rename and safe deletion protect unmerged and checked-out branches", async () => {
    const root = await repository("branch names");
    run(root, "branch", "old");
    const renamed = ok(await post("/api/repo/branch/rename", { path: root, branch: "old", name: "renamed/café" }));
    assert.ok(renamed.branches.some((branch) => branch.name === "renamed/café"));
    assert.ok(!renamed.branches.some((branch) => branch.name === "old"));
    const deleted = ok(await post("/api/repo/branch/delete", { path: root, branch: "renamed/café" }));
    assert.ok(!deleted.branches.some((branch) => branch.name === "renamed/café"));
    assert.equal((await post("/api/repo/branch/delete", { path: root, branch: "main" })).status, 400);
    run(root, "checkout", "-b", "unmerged");
    const keep = await commit(root, "unmerged.txt", "keep\n", "Unmerged");
    run(root, "checkout", "main");
    assert.equal((await post("/api/repo/branch/delete", { path: root, branch: "unmerged" })).status, 400);
    assert.equal(run(root, "rev-parse", "unmerged"), keep);
    for (const branch of ["--force", "HEAD", "bad..name"]) assert.equal((await post("/api/repo/branch/delete", { path: root, branch })).status, 400);
    assert.equal((await post("/api/repo/branch/rename", { path: root, branch: "main", name: "unmerged" })).status, 400);
    assert.equal(ok(await post("/api/repo/branch/rename", { path: root, branch: "main", name: "trunk" })).branch, "trunk");
  });

  await t.test("comparison shows two-tip changes, rename metadata, divergence and bounded patches", async () => {
    const root = await repository("comparison");
    run(root, "checkout", "-b", "feature");
    run(root, "mv", "tracked.txt", "renamed café.txt");
    run(root, "commit", "-m", "Rename");
    run(root, "checkout", "main");
    await commit(root, "main.txt", "main\n", "Main");
    const compared = ok(await get("/api/repo/compare", { path: root, base: "main", target: "feature" }));
    assert.equal(compared.ahead, 1);
    assert.equal(compared.behind, 1);
    assert.ok(compared.files.some((file) => file.file === "renamed café.txt" && file.originalFile === "tracked.txt"));
    assert.match(compared.patch, /rename to renamed café.txt/);
    assert.equal(compared.truncated, false);
    assert.equal((await get("/api/repo/compare", { path: root, base: "--all", target: "feature" })).status, 400);
    await commit(root, "large.txt", "large line\n".repeat(60000), "Large file");
    const large = ok(await get("/api/repo/compare", { path: root, base: "HEAD^", target: "HEAD" }));
    assert.equal(large.truncated, true);
    assert.ok(Buffer.byteLength(large.patch) <= PATCH_LIMIT);
    assert.equal(large.files[0].file, "large.txt");
    assert.equal(large.ahead, 1);
    assert.equal(large.behind, 0);
  });

  await t.test("snapshots expose tags, omit remote symbolic aliases and detect linked-worktree operations", async () => {
    const { root } = await conflictRepository("snapshot refs");
    run(root, "tag", "v1");
    run(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    run(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const snapshot = ok(await get("/api/repo", { path: root }));
    assert.deepEqual(snapshot.remoteBranches, ["origin/main"]);
    assert.equal(snapshot.tags[0].name, "v1");
    const worktree = path.join(temporary, "linked worktree");
    run(root, "worktree", "add", "-b", "linked", worktree, "main");
    const conflict = ok(await integrate(worktree, "merge", "feature"));
    assert.equal(conflict.operation.type, "merge");
    assert.equal(ok(await get("/api/repo", { path: root })).operation, null);
    assert.equal(ok(await operation(worktree, "abort")).operation, null);
  });
});
