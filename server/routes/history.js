const { spawn } = require("node:child_process");
const { send, readBody } = require("../http");
const { git, repoRoot } = require("../git");
const { commandOptions, resolveCommand, commandError } = require("../commands");
const { parseCommitFiles, parseStatus } = require("../parsers");
const { repoSnapshot, readOperation } = require("../services/repoService");
const { withRepoMutation } = require("../services/repoMutation");

const PATCH_LIMIT = 512 * 1024;
const actions = new Set(["merge", "rebase", "cherry-pick", "revert"]);
const badRequest = (message, status = 400) => Object.assign(new Error(message), { status });

async function resolveCommit(root, value) {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!ref || ref.length > 1024 || ref.startsWith("-") || /[\x00-\x20\x7f]/.test(ref)) throw badRequest("Choose a valid branch, tag or commit.");
  // Resolve once and pass only the object ID to commands that change history.
  return git(["-C", root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

async function branchName(root, value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.startsWith("-") || name === "HEAD" || /[\x00-\x20\x7f]/.test(name)) throw badRequest("Use a valid local branch name.");
  await git(["-C", root, "check-ref-format", `refs/heads/${name}`]);
  return name;
}

async function requireNoOperation(root) {
  const operation = await readOperation(root);
  if (operation) throw badRequest(`Finish or abort the current ${operation.type} before starting another operation.`, 409);
}

async function requireClean(root) {
  await requireNoOperation(root);
  const status = parseStatus(await git(["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  if (status.files.length) throw badRequest("Commit or stash your changes before changing history.", 409);
}

async function runHistory(root, action, args) {
  let failure;
  try {
    // `true` is available in Git's shell on macOS and Git for Windows. It accepts
    // Git's prepared commit message without launching an interactive editor.
    await git(["-C", root, "-c", "core.editor=true", "-c", "sequence.editor=true", ...args], undefined, false, {
      env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" }
    });
  } catch (error) { failure = error; }
  const snapshot = await repoSnapshot(root);
  if (failure && !snapshot.operation) throw failure;
  const status = snapshot.operation ? snapshot.operation.conflicts ? "conflicts" : "paused" : "completed";
  return {
    ...snapshot,
    outcome: {
      status,
      action,
      message: failure ? failure.message : status === "completed" ? `${action} completed.` : `Resolve the pending ${snapshot.operation.type} to continue.`
    }
  };
}

function readPatch(root, baseHash, targetHash) {
  return new Promise((resolve, reject) => {
    const options = commandOptions(root);
    delete options.maxBuffer;
    const child = spawn(resolveCommand("git"), ["-c", "core.quotepath=false", "-c", "color.ui=false", "diff", "--no-ext-diff", "--no-textconv", "--find-renames", baseHash, targetHash, "--"], options);
    const chunks = [];
    let size = 0;
    let stderr = "";
    let truncated = false;
    child.stdout.on("data", (chunk) => {
      const remaining = PATCH_LIMIT - size;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) { const kept = chunk.subarray(0, remaining); chunks.push(kept); size += kept.length; }
    });
    child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => reject(commandError("git", error)));
    child.on("close", (code, signal) => {
      if (code !== 0) return reject(commandError("git", { stderr, killed: Boolean(signal), message: "Git could not compare these revisions." }));
      resolve({ patch: Buffer.concat(chunks).toString("utf8"), truncated });
    });
  });
}

async function handleHistory(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/repo/compare") {
    const root = await repoRoot(url.searchParams.get("path"));
    const base = url.searchParams.get("base");
    const target = url.searchParams.get("target");
    const [baseHash, targetHash] = await Promise.all([resolveCommit(root, base), resolveCommit(root, target)]);
    const [files, summary, divergence, patch] = await Promise.all([
      git(["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--name-status", "-z", baseHash, targetHash, "--"]),
      git(["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--stat", baseHash, targetHash, "--"]),
      git(["-C", root, "rev-list", "--left-right", "--count", `${baseHash}...${targetHash}`, "--"]),
      readPatch(root, baseHash, targetHash)
    ]);
    const [behind, ahead] = divergence.split(/\s+/).map(Number);
    return send(res, 200, { base, target, baseHash, targetHash, files: parseCommitFiles(files), summary, ...patch, ahead, behind });
  }

  if (req.method !== "POST" || !["/api/repo/integrate", "/api/repo/operation", "/api/repo/branch/rename", "/api/repo/branch/delete"].includes(url.pathname)) return false;
  const body = await readBody(req);
  const root = await repoRoot(body.path);
  const result = await withRepoMutation(root, async () => {
    if (url.pathname === "/api/repo/integrate") {
      if (!actions.has(body.action)) throw badRequest("Choose merge, rebase, cherry-pick or revert.");
      await requireClean(root);
      const ref = await resolveCommit(root, body.ref);
      await resolveCommit(root, "HEAD");
      if (body.action === "rebase") {
        if (!await git(["-C", root, "symbolic-ref", "--quiet", "HEAD"], undefined, true)) throw badRequest("Check out a local branch before rebasing.");
      }
      if (["cherry-pick", "revert"].includes(body.action)) {
        const parents = await git(["-C", root, "rev-list", "--parents", "-n", "1", ref]);
        if (parents.split(" ").length > 2) throw badRequest("This is a merge commit. Choosing a mainline parent is not supported; select a regular commit.");
      }
      const args = body.action === "merge" ? ["merge", "--no-edit", ref]
        : body.action === "rebase" ? ["rebase", "--no-autostash", ref]
          : [body.action, "--no-edit", ref];
      return runHistory(root, body.action, args);
    }

    if (url.pathname === "/api/repo/operation") {
      if (!["continue", "abort"].includes(body.action)) throw badRequest("Choose continue or abort.");
      const operation = await readOperation(root);
      if (!operation) throw badRequest("There is no Git operation to continue or abort.", 409);
      if (body.action === "continue" && !operation.canContinue) throw badRequest(operation.message || "Resolve every conflicted file before continuing.", 409);
      return runHistory(root, `${operation.type} ${body.action}`, [operation.type, `--${body.action}`]);
    }

    await requireNoOperation(root);
    const branch = await branchName(root, body.branch);
    await git(["-C", root, "show-ref", "--verify", `refs/heads/${branch}`]);
    if (url.pathname.endsWith("/rename")) {
      const name = await branchName(root, body.name);
      await git(["-C", root, "branch", "-m", branch, name]);
    } else {
      // -d protects unmerged work and refuses a branch checked out in any worktree.
      await git(["-C", root, "branch", "-d", branch]);
    }
    return repoSnapshot(root);
  });
  return send(res, 200, result);
}

module.exports = { handleHistory, resolveCommit, PATCH_LIMIT };
