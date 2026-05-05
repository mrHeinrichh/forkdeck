const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ROOT } = require("./config");

const execFileAsync = promisify(execFile);

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
  if (!requested || (resolved !== root && !resolved.startsWith(root + path.sep))) {
    const error = new Error("File path must stay inside the repository.");
    error.status = 400;
    throw error;
  }
  return resolved;
}

module.exports = { git, repoRoot, repoFilePath };
