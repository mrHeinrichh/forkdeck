const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function commandCandidates(command, platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") {
    const programFiles = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"].filter(Boolean);
    const subpath = command === "git" ? ["Git", "cmd", "git.exe"] : ["GitHub CLI", "gh.exe"];
    return programFiles.map((root) => path.win32.join(root, ...subpath)).concat([
      path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Programs", ...subpath),
      path.win32.join(home, "scoop", "apps", command, "current", ...(command === "git" ? ["cmd"] : ["bin"]), `${command}.exe`)
    ]);
  }
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(home, ".local", "bin")]
    .map((directory) => path.join(directory, command));
}

function resolveCommand(command) {
  const extension = process.platform === "win32" ? ".exe" : "";
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  const fromPath = String(process.env[pathKey] || "").split(path.delimiter).filter(Boolean)
    .map((directory) => path.join(directory, `${command}${extension}`));
  return [...fromPath, ...commandCandidates(command)].find((candidate) => {
    try {
      fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch { return false; }
  }) || command;
}

function commandOptions(cwd) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const extras = [...commandCandidates("git"), ...commandCandidates("gh")].map((candidate) => path.dirname(candidate));
  env[pathKey] = [...new Set([...(env[pathKey] || "").split(path.delimiter), ...extras])].filter(Boolean).join(path.delimiter);
  return {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
    env
  };
}

function commandError(command, error) {
  if (error.code === "ENOENT") {
    const name = command === "git" ? "Git" : command === "gh" ? "GitHub CLI (gh)" : command;
    const url = command === "git" ? "https://git-scm.com/downloads" : "https://cli.github.com/";
    return Object.assign(new Error(`${name} is not installed or could not be found. Install it from ${url} and restart ForkDeck.`), { status: 503 });
  }
  if (error.killed) return Object.assign(new Error(`${command} timed out. Check your connection and Git authentication, then try again.`), { status: 408 });
  return Object.assign(new Error(String(error.stderr || error.stdout || error.message).trim()), { status: 400 });
}

async function toolStatus(command) {
  try {
    const { stdout } = await execFileAsync(resolveCommand(command), ["--version"], { ...commandOptions(os.homedir()), timeout: 8000 });
    return { available: true, version: stdout.split(/\r?\n/)[0] };
  } catch (error) {
    return { available: false, error: commandError(command, error).message };
  }
}

module.exports = { commandCandidates, resolveCommand, commandOptions, commandError, toolStatus };
