const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 4173);
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const PROFILE_FILE = path.join(DATA_DIR, "profiles.json");
const REPO_FILE = path.join(DATA_DIR, "repos.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png"
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(payload);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

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

async function git(args, cwd = ROOT, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (error) {
    if (allowFailure) return "";
    const message = error.stderr || error.stdout || error.message;
    const wrapped = new Error(String(message).trim());
    wrapped.status = 400;
    throw wrapped;
  }
}

async function repoRoot(repoPath) {
  const requested = path.resolve(String(repoPath || ""));
  const root = await git(["-C", requested, "rev-parse", "--show-toplevel"]);
  return root.trim();
}

function repoFilePath(root, file) {
  const requested = String(file || "");
  const resolved = path.resolve(root, requested);
  if (!requested || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) {
    const error = new Error("File path must stay inside the repository.");
    error.status = 400;
    throw error;
  }
  return resolved;
}

async function readGlobalIdentity() {
  const [name, email] = await Promise.all([
    git(["config", "--global", "--get", "user.name"], ROOT, true),
    git(["config", "--global", "--get", "user.email"], ROOT, true)
  ]);
  return { name, email };
}

function parseStatus(raw) {
  const lines = raw.split("\n").filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const files = lines
    .filter((line) => !line.startsWith("## "))
    .map((line) => {
      const xy = line.slice(0, 2);
      const file = line.slice(3);
      return {
        index: xy[0],
        worktree: xy[1],
        file,
        label: statusLabel(xy)
      };
    });

  let branch = "detached";
  let ahead = 0;
  let behind = 0;
  if (branchLine) {
    const text = branchLine.slice(3);
    branch = text.startsWith("No commits yet on ")
      ? text.replace("No commits yet on ", "")
      : text.split("...")[0].split(" ")[0];
    const aheadMatch = text.match(/ahead (\d+)/);
    const behindMatch = text.match(/behind (\d+)/);
    ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
    behind = behindMatch ? Number(behindMatch[1]) : 0;
  }

  return { branch, ahead, behind, files };
}

function statusLabel(xy) {
  if (xy === "??") return "Untracked";
  if (xy.includes("M")) return "Modified";
  if (xy.includes("A")) return "Added";
  if (xy.includes("D")) return "Deleted";
  if (xy.includes("R")) return "Renamed";
  if (xy.includes("U")) return "Conflict";
  return "Changed";
}

function parseBranches(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split("\t");
      return { name, current: head === "*", upstream: upstream || "" };
    });
}

function parseRemoteBranches(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((name) => name.trim())
    .filter((name) => name && !name.endsWith("/HEAD"));
}

function parseCommitFiles(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split("\t");
      return {
        status,
        file,
        label: status === "A" ? "Added" : status === "D" ? "Deleted" : status === "R" ? "Renamed" : "Modified"
      };
    });
}

function parseCommits(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, parents, author, relativeDate, timestamp, subject, refs] = line.split("\t");
      return {
        hash,
        shortHash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        author,
        relativeDate,
        timestamp: Number(timestamp) || 0,
        subject,
        refs: refs || ""
      };
    });
}

function parseStashes(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, relativeDate, timestamp, subject, hash, parents] = line.split("\t");
      const parentList = parents ? parents.split(" ").filter(Boolean) : [];
      return {
        ref,
        relativeDate,
        timestamp: Number(timestamp) || 0,
        subject,
        hash: hash || "",
        baseHash: parentList[0] || ""
      };
    });
}

async function appStatus() {
  return {
    global: await readGlobalIdentity(),
    command: "git config --global user.name / user.email"
  };
}

async function repoSnapshot(repoPath) {
  const root = await repoRoot(repoPath);
  const [statusRaw, branchesRaw, remoteBranchesRaw, commitsRaw, stashesRaw, remote] = await Promise.all([
    git(["-C", root, "status", "--porcelain=v1", "-b"]),
    git(["-C", root, "branch", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)"], ROOT, true),
    git(["-C", root, "branch", "-r", "--format=%(refname:short)"], ROOT, true),
    git(["-C", root, "log", "--all", "--topo-order", "--date=relative", "--pretty=format:%H%x09%h%x09%P%x09%an%x09%ar%x09%ct%x09%s%x09%D", "-n", "120"], ROOT, true),
    git(["-C", root, "stash", "list", "--format=%gd%x09%cr%x09%ct%x09%s%x09%H%x09%P"], ROOT, true),
    git(["-C", root, "remote", "get-url", "origin"], ROOT, true)
  ]);
  const status = parseStatus(statusRaw);
  return {
    root,
    remote,
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    files: status.files,
    branches: parseBranches(branchesRaw),
    remoteBranches: parseRemoteBranches(remoteBranchesRaw),
    commits: parseCommits(commitsRaw),
    stashes: parseStashes(stashesRaw)
  };
}

async function rememberRepo(repoPath) {
  const root = await repoRoot(repoPath);
  const store = await ensureRepos();
  const name = path.basename(root);
  const remote = await git(["-C", root, "remote", "get-url", "origin"], ROOT, true);
  const existing = store.repos.findIndex((repo) => repo.root === root);
  const record = { root, name, remote, lastOpened: new Date().toISOString() };
  if (existing >= 0) store.repos[existing] = { ...store.repos[existing], ...record };
  else store.repos.unshift(record);
  await saveRepos(store);
  return { store, record };
}

async function handleProfiles(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/profiles") {
    return send(res, 200, await ensureProfiles());
  }

  if (req.method === "POST" && url.pathname === "/api/profiles") {
    const body = await readBody(req);
    const store = await ensureProfiles();
    const profile = cleanProfile(body);
    const index = store.profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) store.profiles[index] = profile;
    else store.profiles.push(profile);
    await saveProfiles(store);
    return send(res, 200, { profile, profiles: store.profiles });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/profiles/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const store = await ensureProfiles();
    store.profiles = store.profiles.filter((profile) => profile.id !== id);
    await saveProfiles(store);
    return send(res, 200, store);
  }

  return false;
}

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

async function handleApi(req, res, url) {
  const profileHandled = await handleProfiles(req, res, url);
  if (profileHandled !== false) return;

  const repoHandled = await handleRepo(req, res, url);
  if (repoHandled !== false) return;

  if (req.method === "GET" && url.pathname === "/api/status") {
    return send(res, 200, await appStatus());
  }

  if (req.method === "POST" && url.pathname === "/api/switch") {
    const body = await readBody(req);
    const store = await ensureProfiles();
    const profile = store.profiles.find((item) => item.id === body.profileId);
    if (!profile) return send(res, 404, { error: "Profile not found." });

    await git(["config", "--global", "user.name", profile.name]);
    await git(["config", "--global", "user.email", profile.email]);
    return send(res, 200, { profile, status: await appStatus() });
  }

  return send(res, 404, { error: "No API route matched." });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (path.relative(PUBLIC_DIR, filePath).startsWith("..")) return send(res, 403, "Forbidden");

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, "Not found");
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    send(res, error.status || 500, { error: error.message || "Unexpected server error." });
  }
});

server.listen(PORT, () => {
  console.log(`ForkDeck running at http://localhost:${PORT}`);
});
