const path = require("node:path");
const { ROOT } = require("../config");
const { git, repoRoot } = require("../git");
const { updateRepos } = require("../storage");
const { redactSensitive } = require("../redact");
const { parseStatus, parseBranches, parseRemoteBranches, parseCommits, parseStashes } = require("../parsers");
const { toolStatus } = require("../commands");

async function readGlobalIdentity() {
  const [name, email] = await Promise.all([
    git(["config", "--global", "--get", "user.name"], ROOT, true),
    git(["config", "--global", "--get", "user.email"], ROOT, true)
  ]);
  return { name, email };
}

async function appStatus() {
  const [gitTool, ghTool] = await Promise.all([toolStatus("git"), toolStatus("gh")]);
  return {
    global: gitTool.available ? await readGlobalIdentity() : { name: "", email: "" },
    tools: { git: gitTool, gh: ghTool },
    command: "git config --global user.name / user.email"
  };
}

async function repoSnapshot(repoPath) {
  const root = await repoRoot(repoPath);
  const head = await git(["-C", root, "rev-parse", "--verify", "HEAD"], ROOT, true);
  const [statusRaw, branchesRaw, remoteBranchesRaw, commitsRaw, stashesRaw, remote, name, email] = await Promise.all([
    git(["-C", root, "status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]),
    git(["-C", root, "branch", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)"], ROOT, true),
    git(["-C", root, "branch", "-r", "--format=%(refname:short)"], ROOT, true),
    // Stashes have their own rows; --all also adds their index/untracked helper
    // commits to the graph. Explicit refs retain real history and detached HEAD.
    git(["-C", root, "log", "--branches", "--remotes", "--tags", ...(head ? [head] : []), "--topo-order", "--date=relative", "--pretty=format:%H%x09%h%x09%P%x09%an%x09%ar%x09%ct%x09%s%x09%D", "-n", "120"], ROOT, true),
    git(["-C", root, "stash", "list", "--format=%gd%x09%cr%x09%ct%x09%s%x09%H%x09%P"], ROOT, true),
    git(["-C", root, "remote", "get-url", "origin"], ROOT, true),
    git(["-C", root, "config", "--get", "user.name"], ROOT, true),
    git(["-C", root, "config", "--get", "user.email"], ROOT, true)
  ]);
  const status = parseStatus(statusRaw);
  return {
    root,
    remote: redactSensitive(remote),
    identity: { name, email },
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
  const name = path.basename(root);
  const remote = await git(["-C", root, "remote", "get-url", "origin"], ROOT, true);
  const record = { root, name, remote: redactSensitive(remote), lastOpened: new Date().toISOString() };
  const store = await updateRepos((value) => {
    value.repos = value.repos.map((repo) => ({ ...repo, remote: redactSensitive(repo.remote || "") }));
    const existing = value.repos.findIndex((repo) => repo.root === root);
    if (existing >= 0) value.repos[existing] = { ...value.repos[existing], ...record };
    else value.repos.unshift(record);
  });
  return { store, record };
}

module.exports = { appStatus, repoSnapshot, rememberRepo };
