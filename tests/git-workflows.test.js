const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");

// Native realpath expands Windows 8.3 aliases (e.g. RUNNER~1) just as Git does.
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-git-workflows-")));
process.env.FORKDECK_DATA_DIR = path.join(temporary, "app data");
process.env.GIT_CONFIG_GLOBAL = path.join(temporary, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
delete process.env.FORKDECK_DESKTOP_TOKEN;
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
      headers: data ? { "content-type": "application/json", "x-forkdeck-request": "1", "content-length": Buffer.byteLength(data) }
        : method === "DELETE" ? { "x-forkdeck-request": "1", "content-type": "application/json" } : {} }, (res) => {
      let output = "";
      res.on("data", (chunk) => { output += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(output) }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("repository HTTP workflows use disposable repositories and a local bare remote", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(temporary, { recursive: true, force: true });
  });
  const get = (route, params = {}) => request(server, `${route}?${new URLSearchParams(params)}`);
  const post = (route, body) => request(server, route, "POST", body);
  const ok = (response) => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };

  await t.test("browse/add/open/remove and concurrent additions preserve saved repositories", async () => {
    const names = ["browse café", "parallel one", "parallel two"];
    if (process.platform !== "win32") names.push("trailing space ");
    const roots = await Promise.all(names.map((name) => repository(name)));
    const browse = ok(await get("/api/fs", { path: roots[0] }));
    assert.equal(browse.path, roots[0]);
    assert.equal(browse.isGitRepo, true);
    assert.ok(!browse.directories.some((item) => item.name === ".git"));
    const added = await Promise.all(roots.map((root) => post("/api/repos", { path: root })));
    added.forEach(ok);
    let saved = ok(await get("/api/repos")).repos;
    roots.forEach((root) => assert.ok(saved.some((item) => item.root === root)));
    ok(await post("/api/repos", { path: roots[0] }));
    saved = ok(await get("/api/repos")).repos;
    assert.equal(saved.filter((item) => item.root === roots[0]).length, 1);
    const snapshot = ok(await get("/api/repo", { path: roots[0] }));
    assert.equal(snapshot.branch, "main");
    assert.deepEqual(snapshot.identity, { name: "ForkDeck QA", email: "qa@example.invalid" });
    ok(await request(server, `/api/repos/${encodeURIComponent(roots[0])}`, "DELETE"));
    assert.ok(!(ok(await get("/api/repos"))).repos.some((item) => item.root === roots[0]));
    assert.ok(fs.existsSync(path.join(roots[0], "tracked.txt")));
    assert.equal((await post("/api/repos", { path: temporary })).status, 400);
    assert.equal((await get("/api/repo")).status, 400);
  });

  await t.test("empty repositories and detached HEAD snapshots display correct state", async () => {
    const empty = await repository("empty", false);
    const snapshot = ok(await get("/api/repo", { path: empty }));
    assert.equal(snapshot.branch, "main");
    assert.deepEqual(snapshot.commits, []);
    const repo = await repository("detached");
    run(repo, "checkout", "--detach", "HEAD");
    assert.equal(ok(await get("/api/repo", { path: repo })).branch, "detached");
  });

  await t.test("credential-bearing remotes are redacted from snapshots, responses and persisted metadata", async () => {
    const repo = await repository("credential remote");
    run(repo, "remote", "add", "origin", "https://qa:private-secret@github.com/owner/repo.git");
    const added = ok(await post("/api/repos", { path: repo }));
    assert.doesNotMatch(JSON.stringify(added), /private-secret/);
    assert.doesNotMatch(JSON.stringify(ok(await get("/api/repo", { path: repo }))), /private-secret/);
    assert.doesNotMatch(await fsp.readFile(path.join(process.env.FORKDECK_DATA_DIR, "repos.json"), "utf8"), /private-secret/);
    assert.match(run(repo, "remote", "get-url", "origin"), /private-secret/);
  });

  await t.test("graph history excludes stash helper commits while retaining branches, tags, remotes, merges and detached HEAD", async () => {
    const repo = await repository("graph history");
    run(repo, "checkout", "-b", "feature");
    run(repo, "commit", "--allow-empty", "-m", "Feature commit");
    const feature = run(repo, "rev-parse", "HEAD");
    run(repo, "checkout", "main");
    run(repo, "merge", "--no-ff", "feature", "-m", "Real merge");
    const merge = run(repo, "rev-parse", "HEAD");
    run(repo, "checkout", "--detach", "main");
    run(repo, "commit", "--allow-empty", "-m", "Tag-only history");
    const tagged = run(repo, "rev-parse", "HEAD");
    run(repo, "tag", "archived", tagged);
    run(repo, "checkout", "--detach", "main");
    run(repo, "commit", "--allow-empty", "-m", "Remote-only history");
    const remote = run(repo, "rev-parse", "HEAD");
    run(repo, "update-ref", "refs/remotes/origin/remote-only", remote);
    run(repo, "checkout", "main");
    await fsp.writeFile(path.join(repo, "tracked.txt"), "stash edit\n");
    await fsp.writeFile(path.join(repo, "untracked.txt"), "stash untracked\n");
    const stashed = ok(await post("/api/repo/stash", { path: repo, includeUntracked: true }));
    const helpers = ["refs/stash", "refs/stash^2", "refs/stash^3"].map((ref) => run(repo, "rev-parse", ref));
    const commits = stashed.commits.map((commit) => commit.hash);
    for (const hash of helpers) assert.ok(!commits.includes(hash), `Stash helper ${hash} must not appear as a normal commit`);
    for (const hash of [feature, merge, tagged, remote]) assert.ok(commits.includes(hash), `Real history ${hash} must remain visible`);
    assert.equal(stashed.stashes[0].hash, helpers[0]);
    assert.equal(stashed.commits.find((commit) => commit.hash === merge).parents.length, 2);
    run(repo, "checkout", "--detach", "main");
    run(repo, "commit", "--allow-empty", "-m", "Detached-only history");
    const detached = run(repo, "rev-parse", "HEAD");
    assert.ok(ok(await get("/api/repo", { path: repo })).commits.some((commit) => commit.hash === detached));
    run(repo, "checkout", "--orphan", "unborn");
    const unborn = ok(await get("/api/repo", { path: repo }));
    assert.equal(unborn.branch, "unborn");
    for (const hash of [feature, merge, tagged, remote]) assert.ok(unborn.commits.some((commit) => commit.hash === hash));
  });

  await t.test("all untracked files, staged and unstaged content, binary files and literal pathspecs are previewed", async () => {
    const repo = await repository("diffs");
    await fsp.mkdir(path.join(repo, "nested"));
    await fsp.writeFile(path.join(repo, "nested", "new café.txt"), "first\nsecond");
    await fsp.writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
    const snapshot = ok(await get("/api/repo", { path: repo }));
    assert.ok(snapshot.files.some((file) => file.file === "nested/new café.txt"));
    const untracked = ok(await get("/api/repo/diff", { path: repo, file: "nested/new café.txt" }));
    assert.match(untracked.diff, /\+first/);
    assert.match(untracked.diff, /\+second/);
    assert.match(untracked.diff, /No newline at end of file/);
    assert.match(ok(await get("/api/repo/diff", { path: repo, file: "binary.bin" })).diff, /Binary/);
    await fsp.writeFile(path.join(repo, "tracked.txt"), "staged\n");
    run(repo, "add", "tracked.txt");
    await fsp.writeFile(path.join(repo, "tracked.txt"), "unstaged\n");
    const both = ok(await get("/api/repo/diff", { path: repo, file: "tracked.txt" }));
    assert.match(both.stagedDiff, /\+staged/);
    assert.match(both.unstagedDiff, /\+unstaged/);
    assert.match(both.diff, /Staged changes/);
    assert.match(both.diff, /Unstaged changes/);
    await fsp.writeFile(path.join(repo, "[one].txt"), "literal\n");
    await fsp.writeFile(path.join(repo, "o.txt"), "other\n");
    run(repo, "add", ".");
    run(repo, "commit", "-m", "Add literal path files");
    await fsp.writeFile(path.join(repo, "[one].txt"), "literal changed\n");
    await fsp.writeFile(path.join(repo, "o.txt"), "other changed\n");
    const literal = ok(await get("/api/repo/diff", { path: repo, file: "[one].txt" }));
    assert.match(literal.diff, /literal changed/);
    assert.doesNotMatch(literal.diff, /other changed/);
    assert.equal((await get("/api/repo/diff", { path: repo, file: "../outside" })).status, 400);
    assert.equal((await get("/api/repo/diff", { path: repo, file: ".git/config" })).status, 400);
  });

  await t.test("commit details, renamed files, per-file diff, patch export and invalid hashes", async () => {
    const repo = await repository("history");
    run(repo, "mv", "tracked.txt", "renamed café.txt");
    run(repo, "commit", "-m", "Rename\twith tab");
    const hash = run(repo, "rev-parse", "HEAD");
    const details = ok(await get("/api/repo/commit", { path: repo, hash }));
    assert.equal(details.files[0].file, "renamed café.txt");
    assert.equal(details.files[0].originalFile, "tracked.txt");
    assert.match(details.patch, /Rename\s+with tab/);
    const files = ok(await get("/api/repo/commit-files", { path: repo, hash }));
    assert.equal(files.files[0].label, "Renamed");
    assert.match(ok(await get("/api/repo/commit-file", { path: repo, hash, file: "renamed café.txt" })).diff, /initial/);
    const patch = ok(await get("/api/repo/patch", { path: repo, hash }));
    assert.match(patch.patch, /Subject: \[PATCH\] Rename/);
    assert.ok(patch.patch.endsWith("\n"));
    for (const route of ["commit", "commit-files", "commit-file", "patch"]) {
      assert.equal((await get(`/api/repo/${route}`, { path: repo, hash: "1234567890", file: "tracked.txt" })).status, 400);
      assert.equal((await get(`/api/repo/${route}`, { path: repo, hash: "--all", file: "tracked.txt" })).status, 400);
    }
  });

  await t.test("branch/tag creation, checkout, invalid refs and dirty checkout protection", async () => {
    const repo = await repository("refs");
    const hash = run(repo, "rev-parse", "HEAD");
    const branch = ok(await post("/api/repo/branch", { path: repo, name: "feature/café", startPoint: hash }));
    assert.equal(branch.branch, "feature/café");
    await fsp.writeFile(path.join(repo, "tracked.txt"), "branch edit\n");
    run(repo, "commit", "-am", "Branch change");
    assert.equal(ok(await post("/api/repo/checkout", { path: repo, branch: "main" })).branch, "main");
    await fsp.writeFile(path.join(repo, "tracked.txt"), "uncommitted\n");
    assert.equal((await post("/api/repo/checkout", { path: repo, branch: "feature/café" })).status, 400);
    assert.equal(await fsp.readFile(path.join(repo, "tracked.txt"), "utf8"), "uncommitted\n");
    for (const name of ["--force", "bad..name", "bad.lock", "with space", "@{0}"]) {
      assert.equal((await post("/api/repo/checkout", { path: repo, branch: name })).status, 400);
      assert.equal((await post("/api/repo/branch", { path: repo, name })).status, 400);
      assert.equal((await post("/api/repo/tag", { path: repo, name, hash })).status, 400);
    }
    ok(await post("/api/repo/tag", { path: repo, name: "v1.0", hash }));
    ok(await post("/api/repo/tag", { path: repo, name: "v1.1", hash, annotated: true, message: "Release notes" }));
    assert.equal(run(repo, "cat-file", "-t", "v1.0"), "commit");
    assert.equal(run(repo, "cat-file", "-t", "v1.1"), "tag");
    assert.match(run(repo, "show", "v1.1"), /Release notes/);
  });

  await t.test("stash push/apply/pop/drop preserve tabbed messages and untracked content", async () => {
    const repo = await repository("stashes");
    await fsp.writeFile(path.join(repo, "tracked.txt"), "stash edit\n");
    await fsp.writeFile(path.join(repo, "untracked.txt"), "stash untracked\n");
    const snapshot = ok(await post("/api/repo/stash", { path: repo, message: "QA\ttab", includeUntracked: true }));
    assert.equal(snapshot.files.length, 0);
    assert.match(snapshot.stashes[0].subject, /QA\ttab/);
    assert.match(snapshot.stashes[0].hash, /^[a-f0-9]{40}$/);
    assert.equal(snapshot.stashes[0].baseHash, run(repo, "rev-parse", "HEAD"));
    for (const ref of ["--index", "--quiet", "HEAD", "stash@{x}"]) {
      assert.equal((await post("/api/repo/stash/apply", { path: repo, ref })).status, 400);
      assert.equal((await post("/api/repo/stash/drop", { path: repo, ref })).status, 400);
    }
    const applied = ok(await post("/api/repo/stash/apply", { path: repo, ref: "stash@{0}" }));
    assert.equal(applied.stashes.length, 1);
    assert.equal(await fsp.readFile(path.join(repo, "untracked.txt"), "utf8"), "stash untracked\n");
    assert.equal(ok(await post("/api/repo/stash/drop", { path: repo, ref: "stash@{0}" })).stashes.length, 0);
    ok(await post("/api/repo/stash", { path: repo, includeUntracked: true }));
    const popped = ok(await post("/api/repo/stash/apply", { path: repo, pop: true }));
    assert.equal(popped.stashes.length, 0);
    assert.equal(await fsp.readFile(path.join(repo, "tracked.txt"), "utf8"), "stash edit\n");
  });

  await t.test("local remote fetch/pull/push, ahead/behind, clone and remote branches", async () => {
    const repo = await repository("network source");
    const bare = path.join(temporary, "origin.git");
    run(temporary, "init", "--bare", "--initial-branch=main", bare);
    run(repo, "remote", "add", "origin", bare);
    run(repo, "push", "-u", "origin", "main");
    run(repo, "config", "--global", `url.${bare}.insteadOf`, "https://github.com/forkdeck-test/isolated.git");
    const clone = path.join(temporary, "clone with spaces");
    const cloned = ok(await post("/api/repo/clone", { remote: "https://github.com/forkdeck-test/isolated.git", destination: clone }));
    assert.equal(cloned.repo.root, clone);
    assert.ok(cloned.repo.remoteBranches.includes("origin/main"));
    assert.ok(cloned.repos.some((item) => item.root === clone));
    await fsp.writeFile(path.join(repo, "tracked.txt"), "source update\n");
    run(repo, "commit", "-am", "Source update");
    assert.equal(ok(await get("/api/repo", { path: repo })).ahead, 1);
    ok(await post("/api/repo/action", { path: repo, action: "push" }));
    const fetched = ok(await post("/api/repo/action", { path: clone, action: "fetch" }));
    assert.equal(fetched.repo.behind, 1);
    ok(await post("/api/repo/action", { path: clone, action: "pull" }));
    assert.equal(await fsp.readFile(path.join(clone, "tracked.txt"), "utf8"), "source update\n");
    run(repo, "branch", "remote-feature");
    run(repo, "push", "origin", "remote-feature");
    assert.ok(ok(await post("/api/repo/action", { path: clone, action: "fetch" })).repo.remoteBranches.includes("origin/remote-feature"));
    const tracking = ok(await post("/api/repo/checkout", { path: clone, branch: "origin/remote-feature" }));
    assert.equal(tracking.branch, "remote-feature");
    assert.equal(tracking.branches.find((item) => item.name === "remote-feature").upstream, "origin/remote-feature");
    ok(await post("/api/repo/checkout", { path: clone, branch: "main" }));
    assert.equal(ok(await post("/api/repo/checkout", { path: clone, branch: "origin/remote-feature" })).branch, "remote-feature");
    run(repo, "branch", "ambiguous");
    run(repo, "push", "origin", "ambiguous");
    ok(await post("/api/repo/action", { path: clone, action: "fetch" }));
    run(clone, "branch", "ambiguous");
    assert.equal((await post("/api/repo/checkout", { path: clone, branch: "origin/ambiguous" })).status, 400);
    assert.equal(run(clone, "branch", "--show-current"), "remote-feature");
    ok(await post("/api/repo/branch", { path: repo, name: "publish-feature" }));
    ok(await post("/api/repo/action", { path: repo, action: "push" }));
    assert.equal(run(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/publish-feature");
    assert.equal(run(bare, "rev-parse", "refs/heads/publish-feature"), run(repo, "rev-parse", "HEAD"));
    const forkRemote = path.join(temporary, "fork.git");
    run(temporary, "init", "--bare", "--initial-branch=main", forkRemote);
    run(repo, "remote", "add", "fork", forkRemote);
    run(repo, "config", "remote.pushDefault", "fork");
    ok(await post("/api/repo/branch", { path: repo, name: "publish-to-fork" }));
    ok(await post("/api/repo/action", { path: repo, action: "push" }));
    assert.equal(run(forkRemote, "rev-parse", "refs/heads/publish-to-fork"), run(repo, "rev-parse", "HEAD"));
    assert.throws(() => run(bare, "rev-parse", "--verify", "refs/heads/publish-to-fork"));
    assert.equal((await post("/api/repo/action", { path: repo, action: "reset" })).status, 400);
    for (const remote of ["file:///private", "https://github.com/user/repo?token=secret", "https://github.com/user/repo#main", "https://evil.example/user/repo"]) {
      assert.equal((await post("/api/repo/clone", { remote, destination: path.join(temporary, "rejected") })).status, 400);
    }
    assert.equal((await post("/api/repo/clone", { remote: "https://github.com/forkdeck-test/isolated.git", destination: "" })).status, 400);
    assert.equal((await post("/api/repo/clone", { remote: "https://github.com/forkdeck-test/isolated.git", destination: clone })).status, 400);
  });

  await t.test("conflict previews and ours/theirs/mark resolution, including deleted sides", async () => {
    for (const action of ["ours", "theirs", "mark", "deleted-ours", "deleted-theirs"]) {
      const repo = await repository(`conflict-${action}`);
      run(repo, "checkout", "-b", "feature");
      if (action === "deleted-theirs") run(repo, "rm", "tracked.txt");
      else await fsp.writeFile(path.join(repo, "tracked.txt"), "theirs\n");
      run(repo, "commit", "-am", "Feature edit");
      run(repo, "checkout", "main");
      if (action === "deleted-ours") run(repo, "rm", "tracked.txt");
      else await fsp.writeFile(path.join(repo, "tracked.txt"), "ours\n");
      run(repo, "commit", "-am", "Main edit");
      assert.throws(() => run(repo, "merge", "feature"));
      assert.equal(ok(await get("/api/repo", { path: repo })).files[0].label, "Conflict");
      const conflict = ok(await get("/api/repo/conflict", { path: repo, file: "tracked.txt" }));
      assert.match(conflict.base, /initial/);
      if (action === "mark") await fsp.writeFile(path.join(repo, "tracked.txt"), "manually resolved\n");
      const choice = action.replace("deleted-", "");
      const resolved = ok(await post("/api/repo/conflict/resolve", { path: repo, file: "tracked.txt", action: choice }));
      assert.ok(!resolved.files.some((file) => file.label === "Conflict"));
      if (action.startsWith("deleted-")) assert.ok(!fs.existsSync(path.join(repo, "tracked.txt")));
      else assert.equal(await fsp.readFile(path.join(repo, "tracked.txt"), "utf8"), `${choice === "mark" ? "manually resolved" : choice}\n`);
      assert.equal((await post("/api/repo/conflict/resolve", { path: repo, file: "tracked.txt", action: "mark" })).status, 400);
    }
  });

  await t.test("merge commit files include first-parent changes", async () => {
    const repo = await repository("merge history");
    run(repo, "checkout", "-b", "feature");
    await fsp.writeFile(path.join(repo, "feature.txt"), "feature\n");
    run(repo, "add", ".");
    run(repo, "commit", "-m", "Add feature");
    run(repo, "checkout", "main");
    run(repo, "merge", "--no-ff", "feature", "-m", "Merge feature");
    const hash = run(repo, "rev-parse", "HEAD");
    assert.equal(ok(await get("/api/repo/commit-files", { path: repo, hash })).files[0].file, "feature.txt");
    assert.match(ok(await get("/api/repo/commit-file", { path: repo, hash, file: "feature.txt" })).diff, /\+feature/);
    const exported = ok(await get("/api/repo/patch", { path: repo, hash }));
    assert.equal(exported.firstParent, true);
    assert.ok(exported.patch.startsWith(`From ${hash} `));
    assert.match(exported.patch, /Subject: \[PATCH\] Merge feature/);
    const patchFile = path.join(temporary, "merge.patch");
    await fsp.writeFile(patchFile, exported.patch);
    run(repo, "checkout", "--detach", "HEAD^1");
    run(repo, "am", patchFile);
    assert.equal(await fsp.readFile(path.join(repo, "feature.txt"), "utf8"), "feature\n");
  });

  await t.test("symlink previews show targets without reading files outside the repository", { skip: process.platform === "win32" }, async () => {
    const repo = await repository("symlinks");
    const outside = path.join(temporary, "outside-secret.txt");
    await fsp.writeFile(outside, "PRIVATE CONTENT");
    await fsp.symlink(outside, path.join(repo, "link.txt"));
    const preview = ok(await get("/api/repo/diff", { path: repo, file: "link.txt" }));
    assert.match(preview.diff, /outside-secret/);
    assert.doesNotMatch(preview.diff, /PRIVATE CONTENT/);
    const conflict = ok(await get("/api/repo/conflict", { path: repo, file: "link.txt" }));
    assert.equal(conflict.current, outside);
    await fsp.symlink(temporary, path.join(repo, "directory-link"));
    assert.equal((await get("/api/repo/conflict", { path: repo, file: "directory-link/outside-secret.txt" })).status, 400);
  });
});
