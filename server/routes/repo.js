const fs = require("node:fs/promises");
const path = require("node:path");
const { ROOT } = require("../config");
const { send, readBody } = require("../http");
const { git, repoRoot, repoFilePath } = require("../git");
const { ensureRepos, saveRepos } = require("../storage");
const { parseCommitFiles } = require("../parsers");
const { repoSnapshot, rememberRepo } = require("../services/repoService");

async function handleRepo(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/fs") {
    const requested = path.resolve(String(url.searchParams.get("path") || process.env.HOME || "/Users/heinric"));
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
    return send(res, 200, await ensureRepos());
  }

  if (req.method === "POST" && url.pathname === "/api/repos") {
    const body = await readBody(req);
    const { store, record } = await rememberRepo(body.path);
    return send(res, 200, { repo: record, repos: store.repos });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/repos/")) {
    const root = decodeURIComponent(url.pathname.replace("/api/repos/", ""));
    const store = await ensureRepos();
    store.repos = store.repos.filter((repo) => repo.root !== root);
    await saveRepos(store);
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
    const diff = await git(["-C", root, "diff", "--", file], ROOT, true);
    const staged = await git(["-C", root, "diff", "--cached", "--", file], ROOT, true);
    const untracked = diff || staged ? "" : await git(["-C", root, "show", `:${file}`], ROOT, true);
    return send(res, 200, { file, diff: diff || staged || untracked || "No diff available for this file yet." });
  }

  if (req.method === "GET" && url.pathname === "/api/repo/conflict") {
    const root = await repoRoot(url.searchParams.get("path"));
    const file = String(url.searchParams.get("file") || "");
    if (!file) return send(res, 400, { error: "File is required." });
    const filePath = repoFilePath(root, file);
    const [current, base, ours, theirs] = await Promise.all([
      fs.readFile(filePath, "utf8").catch(() => ""),
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
    if (action === "ours") await git(["-C", root, "checkout", "--ours", "--", file]);
    else if (action === "theirs") await git(["-C", root, "checkout", "--theirs", "--", file]);
    else if (action !== "mark") return send(res, 400, { error: "Unsupported conflict action." });
    await git(["-C", root, "add", "--", file]);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "GET" && url.pathname === "/api/repo/commit") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = String(url.searchParams.get("hash") || "");
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return send(res, 400, { error: "Valid commit hash is required." });
    const patch = await git(["-C", root, "show", "--stat", "--patch", "--date=relative", "--format=fuller", "--no-ext-diff", hash], ROOT, true);
    const files = parseCommitFiles(await git(["-C", root, "show", "--name-status", "--format=", hash], ROOT, true));
    return send(res, 200, { hash, files, patch: patch || "No commit details available." });
  }

  if (req.method === "GET" && url.pathname === "/api/repo/commit-files") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = String(url.searchParams.get("hash") || "");
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return send(res, 400, { error: "Valid commit hash is required." });
    const files = parseCommitFiles(await git(["-C", root, "show", "--name-status", "--format=", hash], ROOT, true));
    return send(res, 200, { hash, files });
  }

  if (req.method === "GET" && url.pathname === "/api/repo/commit-file") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = String(url.searchParams.get("hash") || "");
    const file = String(url.searchParams.get("file") || "");
    if (!/^[0-9a-f]{7,40}$/i.test(hash) || !file) return send(res, 400, { error: "Commit hash and file are required." });
    const diff = await git(["-C", root, "show", "--format=", "--patch", "--no-ext-diff", hash, "--", file], ROOT, true);
    return send(res, 200, { hash, file, diff: diff || "No file diff available for this commit." });
  }

  if (req.method === "GET" && url.pathname === "/api/repo/patch") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = String(url.searchParams.get("hash") || "");
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return send(res, 400, { error: "Valid commit hash is required." });
    const patch = await git(["-C", root, "format-patch", "-1", "--stdout", hash]);
    return send(res, 200, { hash, patch });
  }

  if (req.method === "POST" && url.pathname === "/api/repo/checkout") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    await git(["-C", root, "checkout", String(body.branch || "")]);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/branch") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const name = String(body.name || "").trim();
    const startPoint = String(body.startPoint || "").trim();
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) return send(res, 400, { error: "Use a valid branch name." });
    const args = ["-C", root, "checkout", "-b", name];
    if (startPoint) {
      if (!/^[0-9a-f]{7,40}$/i.test(startPoint)) return send(res, 400, { error: "Use a valid commit hash." });
      args.push(startPoint);
    }
    await git(args);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/tag") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    const name = String(body.name || "").trim();
    const hash = String(body.hash || "").trim();
    const message = String(body.message || "").trim();
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) return send(res, 400, { error: "Use a valid tag name." });
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return send(res, 400, { error: "Use a valid commit hash." });
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
    await git(["-C", root, "stash", action, String(body.ref || "stash@{0}")]);
    return send(res, 200, await repoSnapshot(root));
  }

  if (req.method === "POST" && url.pathname === "/api/repo/stash/drop") {
    const body = await readBody(req);
    const root = await repoRoot(body.path);
    await git(["-C", root, "stash", "drop", String(body.ref || "stash@{0}")]);
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
    const output = await git(allowed[action]);
    return send(res, 200, { output, repo: await repoSnapshot(root) });
  }

  if (req.method === "POST" && url.pathname === "/api/repo/clone") {
    const body = await readBody(req);
    const remote = String(body.remote || "").trim();
    const destination = path.resolve(String(body.destination || ""));
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(\.git)?$/i.test(remote)) {
      return send(res, 400, { error: "Use a GitHub HTTPS repository URL." });
    }
    if (!destination || destination === "/") return send(res, 400, { error: "Choose a valid destination folder." });
    await git(["clone", remote, destination]);
    const { store, record } = await rememberRepo(destination);
    return send(res, 200, { repo: await repoSnapshot(record.root), repos: store.repos });
  }

  return false;
}

module.exports = { handleRepo };
