const path = require("node:path");
const { ROOT } = require("../config");
const { git, repoRoot } = require("../git");
const { ensureRepos, saveRepos } = require("../storage");
const { parseStatus, parseBranches, parseRemoteBranches, parseCommits, parseStashes } = require("../parsers");

async function readGlobalIdentity() {
  const [name, email] = await Promise.all([
    git(["config", "--global", "--get", "user.name"], ROOT, true),
    git(["config", "--global", "--get", "user.email"], ROOT, true)
  ]);
  return { name, email };
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

module.exports = { appStatus, repoSnapshot, rememberRepo };
