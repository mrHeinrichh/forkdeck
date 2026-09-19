const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function createFixtures() {
  // Native realpath expands Windows RUNNER~1-style temp paths to Git's spelling.
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-ui-")));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key.startsWith("FORKDECK_") || ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "ELECTRON_RUN_AS_NODE"].includes(key)) delete env[key];
  }
  Object.assign(env, {
    FORKDECK_DATA_DIR: path.join(scratch, "app-data"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_TEMPLATE_DIR: path.join(scratch, "empty-template"),
    GH_CONFIG_DIR: path.join(scratch, "gh-config"), GH_PROMPT_DISABLED: "1", GCM_INTERACTIVE: "never"
  });
  for (const directory of ["app-data", "empty-template", "gh-config", "hooks", "not-a-repository"]) fs.mkdirSync(path.join(scratch, directory));
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Global UI Fixture\n\temail = global-ui@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = " + JSON.stringify(path.join(scratch, "hooks").replaceAll("\\", "/")) + "\n");
  function git(cwd, ...args) {
    const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd, env, encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || `Git exited ${result.status}`);
    return result.stdout.replace(/[\r\n]+$/, "");
  }
  function repository(name, author) {
    const directory = path.join(scratch, name);
    fs.mkdirSync(directory);
    git(directory, "init", "--initial-branch=main");
    git(directory, "config", "user.name", author);
    git(directory, "config", "user.email", author.toLowerCase().replaceAll(" ", ".") + "@example.invalid");
    return directory;
  }
  function write(repo, file, content) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  const alpha = repository("alpha repo café", "Repository Original");
  const beta = repository("beta repo", "Secondary Author");
  const empty = repository("empty repo", "Empty Author");
  write(alpha, "README.md", "# Alpha UI fixture\n");
  write(alpha, "src/message.txt", "Stable heading\nvalue = baseline\n");
  git(alpha, "add", ".");
  git(alpha, "commit", "-m", "Initial UI root commit");
  const rootCommit = git(alpha, "rev-parse", "HEAD");
  git(alpha, "commit", "--allow-empty", "-m", "Empty UI checkpoint");
  const emptyCommit = git(alpha, "rev-parse", "HEAD");
  write(beta, "beta.txt", "A different repository\n");
  git(beta, "add", ".");
  git(beta, "commit", "-m", "Beta UI root commit");
  for (const repo of [alpha, beta]) {
    const remote = path.join(scratch, path.basename(repo) + "-remote.git");
    fs.mkdirSync(remote);
    git(remote, "init", "--bare", "--initial-branch=main");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "--set-upstream", "origin", "main");
  }
  write(alpha, "src/message.txt", "Stable heading\nvalue = staged\n");
  git(alpha, "add", "src/message.txt");
  write(alpha, "src/message.txt", "Stable heading\nvalue = working\n");
  write(alpha, "notes/café draft.txt", "New untracked note\nA second line\n");
  return { scratch, env, alpha, beta, empty, rootCommit, emptyCommit, git, write,
    invalid: path.join(scratch, "not-a-repository"),
    async cleanup() { await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  };
}

async function startServer(root, fixture) {
  const code = `const {createServer}=require(${JSON.stringify(path.join(root, "server", "app.js"))});
const server=createServer();
server.once('error',e=>{console.error(e);process.exit(1)});
server.listen(0,'127.0.0.1',()=>console.log('FORKDECK_UI_READY='+server.address().port));
process.on('SIGTERM',()=>{server.close(()=>process.exit(0));server.closeAllConnections?.()});`;
  const child = spawn(process.execPath, ["-e", code], { cwd: fixture.scratch, env: fixture.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const origin = await new Promise((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => reject(new Error("Local UI server did not start\n" + stderr)), 15000);
      const done = (error, value) => { clearTimeout(timeout); error ? reject(error) : resolve(value); };
      child.once("error", (error) => done(error));
      child.once("exit", (code) => done(new Error(`Local UI server exited ${code}\n${stderr}`)));
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/FORKDECK_UI_READY=(\d+)/);
        if (match) done(null, `http://127.0.0.1:${match[1]}`);
      });
    });
    return { origin, diagnostics() { return { stderr: stderr.slice(-65536), exitCode: child.exitCode, signal: child.signalCode }; },
      async close() { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; } };
  } catch (error) {
    child.kill();
    await exit;
    throw error;
  }
}

module.exports = { createFixtures, startServer };
