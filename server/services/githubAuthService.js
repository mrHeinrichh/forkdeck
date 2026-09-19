const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { ROOT } = require("../config");
const { git, repoRoot } = require("../git");
const { resolveCommand, commandOptions, commandError, toolStatus } = require("../commands");
const { redactSensitive } = require("../redact");

const execFileAsync = promisify(execFile);
let pendingRepair = Promise.resolve();

function isGithubUser(value) {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(String(value || "").trim());
}

function parseGitHubRemote(remote) {
  const value = String(remote || "").trim();
  const unrecognized = { url: redactSensitive(value), host: "", owner: "", repo: "", protocol: "" };
  if (/[\u0000-\u001f\u007f]/.test(value)) return unrecognized;
  let protocol = "";
  let remotePath = "";
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() === "github.com" && !url.port && !url.search && !url.hash && ["https:", "ssh:"].includes(url.protocol)) {
      protocol = url.protocol.slice(0, -1);
      remotePath = url.pathname.slice(1);
    }
  } catch {
    const match = value.match(/^git@github\.com:(.+)$/i);
    if (match) { protocol = "ssh"; remotePath = match[1]; }
  }
  const match = remotePath.match(/^([^/]+)\/([a-z\d_.-]+?)\/?$/i);
  if (!match || !isGithubUser(match[1]) || !protocol) return unrecognized;
  return {
    url: redactSensitive(value),
    host: "github.com",
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ""),
    protocol
  };
}

async function runCli(command, args, allowFailure = false) {
  try {
    const { stdout, stderr } = await execFileAsync(resolveCommand(command), args, commandOptions(ROOT));
    return `${stdout || ""}${stderr || ""}`.trimEnd();
  } catch (error) {
    if (allowFailure) return `${error.stdout || ""}${error.stderr || error.message || ""}`.trimEnd();
    const safeError = commandError(command, error);
    safeError.message = redactSensitive(safeError.message);
    throw safeError;
  }
}

function runWithInput(command, args, input, allowFailure = false, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCommand(command), args, { ...commandOptions(cwd), timeout: 15000, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) child.kill();
    });
    child.on("error", (error) => {
      if (allowFailure) resolve("");
      else reject(commandError(command, error));
    });
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trimEnd());
      if (allowFailure) return resolve("");
      const error = new Error(redactSensitive(stderr) || `${command} exited with ${code}`);
      error.status = 400;
      reject(error);
    });
    child.stdin.on("error", () => {}); // The executable can fail before consuming input.
    child.stdin.end(input);
  });
}

function parseGhAuthStatus(raw) {
  const accounts = [];
  let activeAccount = null;

  for (const line of String(raw || "").split(/\r?\n/)) {
    const accountMatch = line.match(/Logged in to ([^ ]+) account ([^ ]+)/);
    if (accountMatch) {
      activeAccount = {
        host: accountMatch[1],
        user: accountMatch[2],
        active: false,
        gitProtocol: ""
      };
      accounts.push(activeAccount);
      continue;
    }

    if (activeAccount && /Active account:\s*true/i.test(line)) activeAccount.active = true;
    const protocolMatch = line.match(/Git operations protocol:\s*(\S+)/i);
    if (activeAccount && protocolMatch) activeAccount.gitProtocol = protocolMatch[1];
  }

  const githubAccounts = accounts.filter((account) => account.host.toLowerCase() === "github.com");
  return {
    available: githubAccounts.length > 0,
    accounts: githubAccounts,
    activeUser: githubAccounts.find((account) => account.active)?.user || "",
    activeProtocol: githubAccounts.find((account) => account.active)?.gitProtocol || ""
  };
}

function parseCredential(raw) {
  const fields = Object.create(null);
  for (const line of String(raw || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index === -1) continue;
    fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return {
    protocol: redactSensitive(fields.protocol),
    host: redactSensitive(fields.host),
    path: redactSensitive(fields.path),
    username: isGithubUser(fields.username) ? redactSensitive(fields.username) : "",
    hasPassword: Boolean(fields.password)
  };
}

async function readRepoRemote(repoPath) {
  if (!repoPath) return { root: "", remote: "" };
  const root = await repoRoot(repoPath);
  const branch = await git(["-C", root, "symbolic-ref", "--short", "HEAD"], ROOT, true);
  const [branchPushRemote, pushDefault, branchRemote] = await Promise.all([
    branch ? git(["-C", root, "config", "--get", `branch.${branch}.pushRemote`], ROOT, true) : "",
    git(["-C", root, "config", "--get", "remote.pushDefault"], ROOT, true),
    branch ? git(["-C", root, "config", "--get", `branch.${branch}.remote`], ROOT, true) : ""
  ]);
  const remoteName = branchPushRemote || pushDefault || branchRemote || "origin";
  const remote = await git(["-C", root, "remote", "get-url", "--push", remoteName], ROOT, true);
  return { root, remote };
}

async function readCredential(remoteInfo, root, remote) {
  if (remoteInfo.protocol !== "https" || remoteInfo.host !== "github.com") return null;
  // Use the actual URL, including any username/password override, so this
  // reports the credentials Git push will resolve for this repository.
  const input = `url=${remote}\n\n`;
  const raw = await runWithInput("git", ["credential", "fill"], input, true, root || ROOT);
  return parseCredential(raw);
}

function helperLabel(helper) {
  if (/gh(?:["']|\.exe)?\s+auth\s+git-credential/i.test(helper)) return "GitHub CLI (gh auth git-credential)";
  const known = helper.match(/^(?:.*[\\/])?(git-credential-)?(osxkeychain|wincred|manager-core|manager|cache|store)(?:\s|$)/i);
  return known ? known[2] : "Custom credential helper (command hidden)";
}

async function readCredentialHelpers(root) {
  const scope = root ? ["-C", root, "config"] : ["config", "--global"];
  const [globalHelpers, githubHelpers] = await Promise.all([
    git(["config", "--global", "--get-all", "credential.helper"], ROOT, true),
    git([...scope, "--get-all", "credential.https://github.com.helper"], ROOT, true)
  ]);
  return {
    global: globalHelpers.split("\n").filter(Boolean).map(helperLabel),
    github: githubHelpers.split("\n").filter(Boolean).map(helperLabel)
  };
}

async function readGitHubAuth({ path = "" } = {}) {
  const { root, remote } = await readRepoRemote(path);
  const remoteInfo = parseGitHubRemote(remote);
  const [authRaw, credential, helpers, ghTool] = await Promise.all([
    runCli("gh", ["auth", "status", "--hostname", "github.com"], true),
    readCredential(remoteInfo, root, remote),
    readCredentialHelpers(root),
    toolStatus("gh")
  ]);
  return {
    repo: { root, remote: redactSensitive(remote), github: remoteInfo },
    gh: { ...parseGhAuthStatus(authRaw), installed: ghTool.available, error: redactSensitive(ghTool.error) },
    credential,
    helpers
  };
}

function fixGitHubAuth(options = {}) {
  const repair = pendingRepair.then(() => performAuthRepair(options));
  pendingRepair = repair.catch(() => {});
  return repair;
}

async function performAuthRepair({ path = "", user = "" } = {}) {
  const targetUser = typeof user === "string" ? user.trim().replace(/^@/, "") : "";
  if (!isGithubUser(targetUser)) {
    const error = new Error("Enter a valid GitHub username for push authentication.");
    error.status = 400;
    throw error;
  }

  // Validate before changing the active account or any global credential helper.
  if (typeof path !== "string" || !path.trim()) throw Object.assign(new Error("Choose a repository before repairing GitHub authentication."), { status: 400 });
  const { root, remote } = await readRepoRemote(path);
  const remoteInfo = parseGitHubRemote(remote);
  if (remoteInfo.protocol !== "https" || remoteInfo.host !== "github.com") {
    throw Object.assign(new Error("Fix Auth supports GitHub HTTPS remotes. SSH remotes use SSH keys; configure the key or change origin to its GitHub HTTPS URL."), { status: 400 });
  }

  await runCli("gh", ["auth", "switch", "--hostname", "github.com", "--user", targetUser]);
  try {
    await runCli("gh", ["auth", "setup-git", "--hostname", "github.com"]);
  } catch (error) {
    error.message = `GitHub CLI switched to @${targetUser}, but configuring Git's credential helper failed: ${error.message}`;
    throw error;
  }

  const status = await readGitHubAuth({ path: root });
  if (status.gh.activeUser.toLowerCase() !== targetUser.toLowerCase() ||
      status.credential?.username?.toLowerCase() !== targetUser.toLowerCase() || !status.credential?.hasPassword) {
    throw Object.assign(new Error("GitHub CLI settings were updated, but this repository still does not return credentials for the selected account. Check credentials embedded in the remote URL, repository credential helpers, credential.username, and GH_TOKEN/GITHUB_TOKEN environment overrides before pushing."), { status: 409 });
  }
  const credentialUser = status.credential?.username || "not available";
  const helper = status.helpers.github.join(", ") || "not configured";
  return {
    ...status,
    output: [
      `Active GitHub CLI account: ${status.gh.activeUser || "unknown"}`,
      `Git HTTPS credential user: ${credentialUser}`,
      `GitHub credential helper: ${helper}`,
      "",
      "HTTPS credentials now match the selected account. Repository access will be checked when you push."
    ].join("\n")
  };
}

module.exports = { readGitHubAuth, fixGitHubAuth, parseGitHubRemote, parseGhAuthStatus, parseCredential };
