const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { ROOT } = require("../config");
const { git, repoRoot } = require("../git");

const execFileAsync = promisify(execFile);

function isGithubUser(value) {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(String(value || "").trim());
}

function parseGitHubRemote(remote) {
  const value = String(remote || "").trim();
  const httpsMatch = value.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  const sshMatch = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  const match = httpsMatch || sshMatch;
  if (!match) return { url: value, host: "", owner: "", repo: "", protocol: "" };
  return {
    url: value,
    host: "github.com",
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ""),
    protocol: httpsMatch ? "https" : "ssh"
  };
}

async function runCli(command, args, allowFailure = false) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });
    return `${stdout || ""}${stderr || ""}`.trimEnd();
  } catch (error) {
    if (allowFailure) return `${error.stdout || ""}${error.stderr || error.message || ""}`.trimEnd();
    const message = error.stderr || error.stdout || error.message;
    const wrapped = new Error(String(message).trim());
    wrapped.status = 400;
    throw wrapped;
  }
}

function runWithInput(command, args, input, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (allowFailure) resolve(String(error.message || ""));
      else reject(error);
    });
    child.on("close", (code) => {
      const output = `${stdout || ""}${stderr || ""}`.trimEnd();
      if (code === 0 || allowFailure) return resolve(output);
      const error = new Error(output || `${command} exited with ${code}`);
      error.status = 400;
      reject(error);
    });
    child.stdin.end(input);
  });
}

function parseGhAuthStatus(raw) {
  const accounts = [];
  let activeAccount = null;

  for (const line of String(raw || "").split("\n")) {
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

  return {
    available: accounts.length > 0,
    accounts,
    activeUser: accounts.find((account) => account.active)?.user || "",
    activeProtocol: accounts.find((account) => account.active)?.gitProtocol || ""
  };
}

function parseCredential(raw) {
  const fields = {};
  for (const line of String(raw || "").split("\n")) {
    const index = line.indexOf("=");
    if (index === -1) continue;
    fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return {
    protocol: fields.protocol || "",
    host: fields.host || "",
    path: fields.path || "",
    username: fields.username || "",
    hasPassword: Boolean(fields.password)
  };
}

async function readRepoRemote(repoPath) {
  if (!repoPath) return { root: "", remote: "" };
  const root = await repoRoot(repoPath);
  const remote = await git(["-C", root, "remote", "get-url", "origin"], ROOT, true);
  return { root, remote };
}

async function readCredential(remoteInfo) {
  if (remoteInfo.protocol !== "https" || remoteInfo.host !== "github.com") return null;
  const input = [
    "protocol=https",
    "host=github.com",
    `path=${remoteInfo.owner}/${remoteInfo.repo}.git`,
    "",
    ""
  ].join("\n");
  const raw = await runWithInput("git", ["credential", "fill"], input, true);
  return parseCredential(raw);
}

async function readCredentialHelpers() {
  const [globalHelpers, githubHelpers] = await Promise.all([
    git(["config", "--global", "--get-all", "credential.helper"], ROOT, true),
    git(["config", "--global", "--get-all", "credential.https://github.com.helper"], ROOT, true)
  ]);
  return {
    global: globalHelpers.split("\n").filter(Boolean),
    github: githubHelpers.split("\n").filter(Boolean)
  };
}

async function readGitHubAuth({ path = "" } = {}) {
  const { root, remote } = await readRepoRemote(path);
  const remoteInfo = parseGitHubRemote(remote);
  const [authRaw, credential, helpers] = await Promise.all([
    runCli("gh", ["auth", "status"], true),
    readCredential(remoteInfo),
    readCredentialHelpers()
  ]);
  return {
    repo: { root, remote, github: remoteInfo },
    gh: parseGhAuthStatus(authRaw),
    credential,
    helpers
  };
}

async function fixGitHubAuth({ path = "", user = "" } = {}) {
  const targetUser = String(user || "").trim().replace(/^@/, "");
  if (!isGithubUser(targetUser)) {
    const error = new Error("Enter a valid GitHub username for push authentication.");
    error.status = 400;
    throw error;
  }

  await runCli("gh", ["auth", "switch", "--hostname", "github.com", "--user", targetUser]);
  await runCli("gh", ["auth", "setup-git", "--hostname", "github.com"]);

  const status = await readGitHubAuth({ path });
  const credentialUser = status.credential?.username || "not available";
  const helper = status.helpers.github.join(", ") || "not configured";
  return {
    ...status,
    output: [
      `Active GitHub CLI account: ${status.gh.activeUser || "unknown"}`,
      `Git HTTPS credential user: ${credentialUser}`,
      `GitHub credential helper: ${helper}`,
      "",
      "Git push will use GitHub authentication, not only commit user.name/user.email."
    ].join("\n")
  };
}

module.exports = { readGitHubAuth, fixGitHubAuth, parseGitHubRemote };
