const path = require("node:path");
const { send, readBody } = require("../http");
const { git, repoRoot, repoFilePath } = require("../git");
const { parseStatus } = require("../parsers");
const { repoSnapshot, readOperation } = require("../services/repoService");
const { withRepoMutation } = require("../services/repoMutation");

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function selectedFile(root, body) {
  if (!Object.hasOwn(body, "file")) return null;
  if (typeof body.file !== "string" || !body.file) throw invalid("Choose a file, or omit file to update all changes.");
  const resolved = repoFilePath(root, body.file);
  return path.relative(root, resolved).split(path.sep).join("/");
}

async function updateIndex(root, body, stage) {
  const file = selectedFile(root, body);
  const { files } = parseStatus(await git(["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const selected = file === null ? files : files.filter((entry) => entry.file === file || entry.originalFile === file);
  if (selected.some((entry) => entry.label === "Conflict")) {
    throw invalid("Resolve conflicted files with the conflict tools before changing their staged state.");
  }
  if (file !== null && !selected.length) throw invalid("This file has no changes.");
  const pending = selected.filter((entry) => stage ? entry.worktree !== " " : ![" ", "?"].includes(entry.index));
  if (!pending.length) return stage ? "No unstaged changes to stage." : "No staged changes to unstage.";

  let output;
  if (stage) {
    // A path after -- is literal, including leading dashes and wildcard characters.
    // -A includes deletions while leaving the working tree untouched.
    output = await git(["-C", root, "add", "-A", "--", ...(file === null ? ["."] : [selected[0].file])]);
  } else {
    const paths = file === null ? ["."] : [...new Set(selected.flatMap((entry) =>
      entry.originalFile && entry.index === "R" ? [entry.file, entry.originalFile] : [entry.file]))];
    const head = await git(["-C", root, "rev-parse", "--verify", "HEAD"], undefined, true);
    output = head
      ? await git(["-C", root, "reset", "--quiet", head, "--", ...paths])
      // An unborn repository has no source tree for reset. Force only removes
      // index entries; it never changes files, including later unstaged edits.
      : await git(["-C", root, "rm", "--cached", "-r", "--force", "--ignore-unmatch", "--", ...paths]);
  }
  return output || (stage ? "Changes staged." : "Changes unstaged; working files are preserved.");
}

async function createCommit(root, body) {
  if (typeof body.message !== "string" || !body.message.trim()) throw invalid("Enter a commit message.");
  if (body.message.includes("\0")) throw invalid("Commit messages cannot contain a null character.");
  if (body.message.length > 16384) throw invalid("Keep the commit message below 16,384 characters.");
  if (body.amend !== undefined && typeof body.amend !== "boolean") throw invalid("Amend must be true or false.");
  const amend = body.amend === true;
  const head = await git(["-C", root, "rev-parse", "--verify", "HEAD"], undefined, true);
  if (amend && !head) throw invalid("Create a first commit before amending.");
  if (body.expectedHead !== undefined && (typeof body.expectedHead !== "string" || body.expectedHead !== head)) {
    throw invalid("HEAD changed while you were preparing this commit. Refresh and review the staged changes before trying again.", 409);
  }
  if (await git(["-C", root, "ls-files", "--unmerged", "-z"])) {
    throw invalid("Resolve every conflicted file before committing.");
  }
  const operation = await readOperation(root);
  if (operation) throw invalid(`A ${operation.type} is in progress. Use Continue or Abort before making another commit.`);
  if (!amend && !await git(["-C", root, "diff", "--cached", "--name-only", "-z"])) {
    throw invalid("Stage at least one change before committing.");
  }
  // No -a: only the reviewed index is committed, preserving unstaged edits.
  // Git keeps the original author for --amend unless explicitly told otherwise.
  const output = await git(["-C", root, "commit", ...(amend ? ["--amend"] : []), "-m", body.message]);
  return { output, hash: await git(["-C", root, "rev-parse", "--verify", "HEAD"]) };
}

async function handleCommit(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/repo/commit-message") {
    const root = await repoRoot(url.searchParams.get("path"));
    const hash = await git(["-C", root, "rev-parse", "--verify", "HEAD"], undefined, true);
    if (!hash) throw invalid("Create a first commit before amending.");
    const message = await git(["-C", root, "show", "-s", "--format=%B", hash]);
    return send(res, 200, { hash, message });
  }
  if (req.method !== "POST" || !["/api/repo/stage", "/api/repo/unstage", "/api/repo/commit"].includes(url.pathname)) return false;
  const body = await readBody(req);
  const root = await repoRoot(body.path);
  const result = await withRepoMutation(root, async () => {
    const result = url.pathname === "/api/repo/commit"
      ? await createCommit(root, body)
      : { output: await updateIndex(root, body, url.pathname === "/api/repo/stage") };
    return { ...result, repo: await repoSnapshot(root) };
  });
  return send(res, 200, result);
}

module.exports = { handleCommit };
