const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ROOT } = require("./config");
const { resolveCommand, commandOptions, commandError } = require("./commands");

const execFileAsync = promisify(execFile);

async function git(args, cwd = ROOT, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync(resolveCommand("git"), ["-c", "core.quotepath=false", ...args], commandOptions(cwd));
    // Tabs and spaces can be meaningful (empty log refs, filenames, config values).
    return stdout.replace(/(?:\r?\n)+$/, "");
  } catch (error) {
    if (allowFailure) return "";
    throw commandError("git", error);
  }
}

async function repoRoot(repoPath) {
  if (!String(repoPath || "").trim()) {
    throw Object.assign(new Error("Choose a repository folder first."), { status: 400 });
  }
  const requested = path.resolve(String(repoPath));
  const root = await git(["-C", requested, "rev-parse", "--show-toplevel"]);
  return path.resolve(root.trim());
}

function repoFilePath(root, file, pathApi = path) {
  const requested = String(file || "");
  const resolved = pathApi.resolve(root, requested);
  const relative = pathApi.relative(root, resolved);
  if (!requested || !relative || relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    const error = new Error("File path must stay inside the repository.");
    error.status = 400;
    throw error;
  }
  return resolved;
}

module.exports = { git, repoRoot, repoFilePath };
