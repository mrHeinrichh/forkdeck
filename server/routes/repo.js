const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { ROOT } = require("../config");
const { send, readBody } = require("../http");
const { git, repoRoot, repoFilePath } = require("../git");
const { ensureRepos, updateRepos } = require("../storage");
const { redactSensitive } = require("../redact");
const { parseCommitFiles } = require("../parsers");
const { repoSnapshot, rememberRepo } = require("../services/repoService");

async function commitHash(root, value) {
  const hash = String(value || "");
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw Object.assign(new Error("Valid commit hash is required."), { status: 400 });
  return git(["-C", root, "rev-parse", "--verify", `${hash}^{commit}`]);
}

async function refName(root, value, kind) {
  const name = String(value || "").trim();
  if (!name || name.startsWith("-") || name === "HEAD" || /[\x00-\x20\x7f]/.test(name)) {
    throw Object.assign(new Error(`Use a valid ${kind} name.`), { status: 400 });
  }
  await git(["-C", root, "check-ref-format", `refs/${kind === "tag" ? "tags" : "heads"}/${name}`]);
  return name;
}

function stashRef(value) {
  const ref = String(value || "stash@{0}");
  if (!/^stash@\{\d+\}$/.test(ref)) throw Object.assign(new Error("Use a valid stash reference."), { status: 400 });
  return ref;
}

async function readWorktreeFile(root, file) {
  const filePath = repoFilePath(root, file);
  // Git stores a symlink's target text, not the contents of the target file.
  const parent = await fs.realpath(path.dirname(filePath));
  repoFilePath(root, path.join(parent, path.basename(filePath)));
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) return fs.readlink(filePath);
  if (!stat.isFile()) throw Object.assign(new Error("Choose a file inside the repository."), { status: 400 });
  if (stat.size > 10 * 1024 * 1024) throw Object.assign(new Error("This file is too large to preview (10 MB limit)."), { status: 413 });
  return fs.readFile(filePath);
}

async function handleRepo(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/fs") {
    const requested = path.resolve(String(url.searchParams.get("path") || os.homedir()));
    const entries = await fs.readdir(requested, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: path.join(requested, entry.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const isGitRepo = Boolean(await git(["-C", requested, "rev-parse", "--show-toplevel"], ROOT, true));
    return send(res, 200, {
      path: requested,
      parent: path.dirname(requested),
      isGitRepo,
      directories
    });
  }

  if (req.method === "GET" && url.pathname === "/api/repos") {
    const store = await ensureRepos();
    return send(res, 200, { ...store, repos: store.repos.map((repo) => ({ ...repo, remote: redactSensitive(repo.remote || "") })) });
  }

  if (req.method === "POST" && url.pathname === "/api/repos") {
    const body = await readBody(req);
    const { store, record } = await rememberRepo(body.path);
    return send(res, 200, { repo: record, repos: store.repos });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/repos/")) {
    const root = decodeURIComponent(url.pathname.replace("/api/repos/", ""));
    const store = await updateRepos((value) => {
      value.repos = value.repos.filter((repo) => repo.root !== root).map((repo) => ({ ...repo, remote: redactSensitive(repo.remote || "") }));
    });
    return send(res, 200, store);
  }

  if (req.method === "GET" && url.pathname === "/api/repo") {
    const root = await repoRoot(url.searchParams.get("path"));
    await rememberRepo(root);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "GET" && url.pathname === "/api/repo/diff") {
    const root = await repoRoot(url.searchParams.get("path"));
    const file = String(url.searchParams.get("file") || "");
    if (!file) return send(res, 400, { error: "File is required." });
    repoFilePath(root, file);
    const [unstagedDiff, stagedDiff, untracked] = await Promise.all([
      git(["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--", file]),
      git(["-C", root, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--", file]),
      git(["-C", root, "ls-files", "--others", "--exclude-standard", "-z", "--", file])
    ]);
    let diff = [stagedDiff && `Staged changes\n${stagedDiff}`, unstagedDiff && `Unstaged changes\n${unstagedDiff}`].filter(Boolean).join("\n\n");
    if (!diff && untracked.split("\0").includes(file)) {
      const content = await readWorktreeFile(root, file);
      const text = content.toString("utf8");
      if (text.includes("\0")) diff = `Binary file ${file} is untracked.`;
      else {
        const lines = text ? text.replace(/\n$/, "").split("\n") : [];
        diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}${text && !text.endsWith("\n") ? "\n\\ No newline at end of file" : ""}`;
      }
    }
    return send(res, 200, { file, stagedDiff, unstagedDiff, diff: diff || "No changes in this file." });
  }

  if (req.method === "GET" && url.pathname === "/api/repo/conflict") {
    const root = await repoRoot(url.searchParams.get("path"));
    const file = String(url.searchParams.get("file") || "");
    if (!file) return send(res, 400, { error: "File is required." });
    repoFilePath(root, file);
    const [current, base, ours, theirs] = await Promise.all([
      readWorktreeFile(root, file).then((value) => value.toString("utf8")).catch((error) => { if (error.code === "ENOENT") return ""; throw error; }),
      git(["-C", root, "show", `:1:${file}`], ROOT, true),
      git(["-C", root, "show", `:2:${file}`], ROOT, true),
      git(["-C", root, "show", `:3:${file}`], ROOT, true)
    ]);
    return send(res, 200, { file, current, base, ours, theirs });
  }

  if (req.method === "POST" && url.pathname === "/api/repo/conflict/resolve") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const file = String(body.file || "");
    const action = String(body.action || "");
    repoFilePath(root, file);
    if (!file) return send(res, 400, { error: "File is required." });
    if (!["ours", "theirs", "mark"].includes(action)) return send(res, 400, { error: "Unsupported conflict action." });
    const stages = await git(["-C", root, "ls-files", "--unmerged", "-z", "--", file]);
    if (!stages) return send(res, 400, { error: "This file has no unresolved conflict." });
    const stage = action === "ours" ? "2" : "3";
    if (action !== "mark" && !stages.split("\0").some((entry) => entry.split("\t")[0].endsWith(` ${stage}`))) {
      await git(["-C", root, "rm", "--", file]);
    } else {
      if (action !== "mark") await git(["-C", root, "checkout", `--${action}`, "--", file]);
      await git(["-C", root, "add", "--", file]);
    }
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "GET" && url.pathname === "/api/repo/commit") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = await commitHash(root, url.searchParams.get("hash"));
    const patch = await git(["-C", root, "show", "--stat", "--patch", "--first-parent", "--date=relative", "--format=fuller", "--no-ext-diff", "--no-textconv", hash]);
    const files = parseCommitFiles(await git(["-C", root, "show", "--first-parent", "--name-status", "-z", "--format=", hash]));
    return send(res, 200, { hash, files, patch: patch || "No commit details available." });
  }

  if (req.method === "GET" && url.pathname === "/api/repo/commit-files") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = await commitHash(root, url.searchParams.get("hash"));
    const files = parseCommitFiles(await git(["-C", root, "show", "--first-parent", "--name-status", "-z", "--format=", hash]));
    return send(res, 200, { hash, files });
  }

  if (req.method === "GET" && url.pathname === "/api/repo/commit-file") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = await commitHash(root, url.searchParams.get("hash"));
    const file = String(url.searchParams.get("file") || "");
    repoFilePath(root, file);
    const diff = await git(["-C", root, "show", "--first-parent", "--format=", "--patch", "--no-ext-diff", "--no-textconv", hash, "--", file]);
    return send(res, 200, { hash, file, diff: diff || "No file diff available for this commit." });
  }

  if (req.method === "GET" && url.pathname === "/api/repo/patch") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = await commitHash(root, url.searchParams.get("hash"));
    const parents = await git(["-C", root, "rev-list", "--parents", "-n", "1", hash]);
    const merge = parents.split(" ").length > 2;
    // format-patch skips merge commits and can silently export an ancestor instead.
    const args = merge
      ? ["show", "--first-parent", "--binary", "--format=email", "--no-ext-diff", "--no-textconv", hash]
      : ["format-patch", "-1", "--stdout", "--no-ext-diff", "--no-textconv", hash];
    const patch = await git(["-C", root, ...args], ROOT, false, { preserveOutput: true });
    return send(res, 200, { hash, patch, ...(merge ? { firstParent: true } : {}) });
  }

  if (req.method === "POST" && url.pathname === "/api/repo/checkout") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const branch = await refName(root, body.branch, "branch");
    const local = await git(["-C", root, "show-ref", "--verify", `refs/heads/${branch}`], ROOT, true);
    const remote = local ? "" : await git(["-C", root, "show-ref", "--verify", `refs/remotes/${branch}`], ROOT, true);
    if (remote) {
      const localName = await refName(root, branch.slice(branch.indexOf("/") + 1), "branch");
      const existing = await git(["-C", root, "show-ref", "--verify", `refs/heads/${localName}`], ROOT, true);
      if (existing) {
        const upstream = await git(["-C", root, "for-each-ref", "--format=%(upstream)", `refs/heads/${localName}`]);
        if (upstream !== `refs/remotes/${branch}`) return send(res, 400, { error: `Local branch ${localName} already exists and does not track ${branch}. Choose another local branch name.` });
        await git(["-C", root, "checkout", localName, "--"]);
      } else await git(["-C", root, "checkout", "--track", "-b", localName, branch, "--"]);
    } else await git(["-C", root, "checkout", branch, "--"]);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/branch") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const name = await refName(root, body.name, "branch");
    const startPoint = String(body.startPoint || "").trim();
    const args = ["-C", root, "checkout", "-b", name];
    if (startPoint) {
      args.push(await commitHash(root, startPoint));
    }
    await git(args);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/tag") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const name = await refName(root, body.name, "tag");
    const hash = await commitHash(root, body.hash);
    const message = String(body.message || "").trim();
    const args = ["-C", root, "tag"];
    if (body.annotated) args.push("-a", name, hash, "-m", message || name);
    else args.push(name, hash);
    await git(args);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/stash") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const args = ["-C", root, "stash", "push"];
    if (body.includeUntracked) args.push("--include-untracked");
    if (body.message) args.push("-m", String(body.message));
    await git(args);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/stash/apply") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const action = body.pop ? "pop" : "apply";
    await git(["-C", root, "stash", action, stashRef(body.ref)]);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/stash/drop") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    await git(["-C", root, "stash", "drop", stashRef(body.ref)]);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/action") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const action = String(body.action || "");
    const allowed = {
      fetch: ["-C", root, "fetch", "--all", "--prune"],
      pull: ["-C", root, "pull", "--ff-only"],
      push: ["-C", root, "push"]
    };
    if (!allowed[action]) return send(res, 400, { error: "Unsupported Git action." });
    if (action === "push") {
      const branch = await git(["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], ROOT, true);
      const upstream = await git(["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], ROOT, true);
      if (branch && !upstream) {
        const branchRemote = await git(["-C", root, "config", "--get", `branch.${branch}.pushRemote`], ROOT, true);
        const defaultRemote = await git(["-C", root, "config", "--get", "remote.pushDefault"], ROOT, true);
        const remote = branchRemote || defaultRemote || "origin";
        const remoteUrl = await git(["-C", root, "remote", "get-url", "--", remote], ROOT, true);
        if (remoteUrl) allowed.push = ["-C", root, "push", "--set-upstream", "--", remote, branch];
      }
    }
    const output = await git(allowed[action]);
    return send(res, 200, { output, repo: await repoSnapshot(root) });
  }

  if (req.method === "POST" && url.pathname === "/api/repo/clone") {
    const body = await readBody(req);
    const remote = String(body.remote || "").trim();
    const destinationInput = String(body.destination || "").trim();
    const destination = path.resolve(destinationInput);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\/)?$/i.test(remote)) {
      return send(res, 400, { error: "Use a GitHub HTTPS repository URL." });
    }
    if (!destinationInput || destination === path.parse(destination).root) return send(res, 400, { error: "Choose a valid destination folder." });
    await git(["clone", remote, destination]);
    const { store, record } = await rememberRepo(destination);
    return send(res, 200, { repo: await repoSnapshot(record.root), repos: store.repos });
  }

  return false;
}

module.exports = { handleRepo };
