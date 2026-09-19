const path = require("node:path");
const fs = require("node:fs/promises");
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

async function readOperation(root, files) {
  const gitDir = await git(["-C", root, "rev-parse", "--absolute-git-dir"]);
  const exists = async (name) => fs.stat(path.join(gitDir, name)).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all(
    ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].map(exists)
  );
  const type = rebaseMerge || rebaseApply ? "rebase" : merge ? "merge" : cherryPick ? "cherry-pick" : revert ? "revert" : null;
  if (!type) return null;
  const currentFiles = files || parseStatus(await git(["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"])).files;
  const conflicts = currentFiles.filter((file) => file.label === "Conflict").length;
  const hasStagedChanges = currentFiles.some((file) => file.label !== "Conflict" && ![" ", "?", "!"].includes(file.index));
  if (!conflicts && ["cherry-pick", "revert"].includes(type) && !hasStagedChanges) {
    return { type, conflicts, canContinue: false, message: `This ${type} has no staged changes left. Abort it to return to the previous state.` };
  }
  return { type, conflicts, canContinue: conflicts === 0 };
}

async function repoSnapshot(repoPath) {
  const root = await repoRoot(repoPath);
  const head = await git(["-C", root, "rev-parse", "--verify", "HEAD"], ROOT, true);
  const [statusRaw, branchesRaw, remoteBranchesRaw, commitsRaw, stashesRaw, remote, name, email, tagsRaw] = await Promise.all([
    git(["-C", root, "status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]),
    git(["-C", root, "branch", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)"], ROOT, true),
    git(["-C", root, "for-each-ref", "--format=%(refname:short)%09%(symref)", "refs/remotes/"], ROOT, true),
    // Stashes have their own rows; --all also adds their index/untracked helper
    // commits to the graph. Explicit refs retain real history and detached HEAD.
    git(["-C", root, "log", "--branches", "--remotes", "--tags", ...(head ? [head] : []), "--topo-order", "--date=relative", "--pretty=format:%H%x09%h%x09%P%x09%an%x09%ar%x09%ct%x09%s%x09%D", "-n", "120"], ROOT, true),
    git(["-C", root, "stash", "list", "--format=%gd%x09%cr%x09%ct%x09%s%x09%H%x09%P"], ROOT, true),
    git(["-C", root, "remote", "get-url", "origin"], ROOT, true),
    git(["-C", root, "config", "--get", "user.name"], ROOT, true),
    git(["-C", root, "config", "--get", "user.email"], ROOT, true),
    git(["-C", root, "for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/tags/"], ROOT, true)
  ]);
  const status = parseStatus(statusRaw);
  return {
    root,
    head,
    operation: await readOperation(root, status.files),
    tags: tagsRaw.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, hash] = line.split("\t");
      return { name, hash };
    }),
    remote: redactSensitive(remote),
    identity: { name, email },
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    files: status.files,
    branches: parseBranches(branchesRaw),
    remoteBranches: parseRemoteBranches(remoteBranchesRaw.split(/\r?\n/).filter((line) => !line.split("\t")[1]).map((line) => line.split("\t")[0]).join("\n")),
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

module.exports = { appStatus, repoSnapshot, rememberRepo, readOperation };
