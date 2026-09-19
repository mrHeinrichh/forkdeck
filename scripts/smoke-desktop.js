const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const cleanKeys = [
  "ELECTRON_RUN_AS_NODE", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_SYSTEM",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
  "FORKDECK_DATA_DIR", "FORKDECK_DESKTOP_TOKEN"
];

function smokeEnvironment(inherited, scratch, repository, userData, report, phase) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (cleanKeys.includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return {
    ...env,
    FORKDECK_SMOKE_ROOT: scratch,
    FORKDECK_SMOKE_REPORT: report,
    FORKDECK_SMOKE_USER_DATA: userData,
    FORKDECK_SMOKE_REPO: repository,
    FORKDECK_SMOKE_PHASE: phase,
    GIT_CONFIG_GLOBAL: path.join(scratch, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: path.join(scratch, "empty-template"),
    GH_CONFIG_DIR: path.join(scratch, "gh-config"),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GH_PROMPT_DISABLED: "1"
  };
}

async function main(argv = process.argv.slice(2)) {
  const executable = argv.find((value) => !value.startsWith("--"));
  const launchServices = argv.includes("--launch-services");
  const keep = argv.includes("--keep");
  if (launchServices) {
    assert.equal(process.platform, "darwin", "LaunchServices smoke runs only on macOS");
    assert.ok(executable?.endsWith(".app"), "Pass a .app bundle for LaunchServices smoke");
  }
  const root = path.resolve(__dirname, "..");
  // Native realpath expands Windows RUNNER~1-style temp paths to Git's spelling.
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-smoke-")));
  const repository = path.join(scratch, "repository with spaces");
  const otherRepository = path.join(scratch, "another repository");
  const userData = path.join(scratch, "user-data");
  fs.mkdirSync(repository);
  fs.mkdirSync(otherRepository);
  fs.mkdirSync(path.join(userData, "data"), { recursive: true });
  fs.mkdirSync(path.join(scratch, "empty-template"));
  fs.mkdirSync(path.join(scratch, "gh-config"));
  fs.mkdirSync(path.join(scratch, "hooks"));
  fs.writeFileSync(path.join(scratch, "gitconfig"), "[user]\n\tname = Desktop Smoke\n\temail = smoke@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = " + JSON.stringify(path.join(scratch, "hooks").replaceAll("\\", "/")) + "\n");
  const reports = [];
  let successful = false;
  try {
    const fixtureEnv = smokeEnvironment(process.env, scratch, repository, userData, path.join(scratch, "save.json"), "save");
    for (const fixture of [repository, otherRepository]) {
      const git = (args) => {
        const result = spawnSync("git", args, { cwd: fixture, env: fixtureEnv, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
      };
      git(["init", "--initial-branch=main"]);
      fs.writeFileSync(path.join(fixture, "README.md"), "ForkDeck desktop smoke fixture.\n");
      git(["add", "README.md"]);
      git(["commit", "-m", "Desktop smoke fixture"]);
    }
    // The preferred repo is deliberately second: restoring it must use the native preferences.
    fs.writeFileSync(path.join(userData, "data", "repos.json"), JSON.stringify({ repos: [otherRepository, repository].map((root) => ({ root, name: path.basename(root), remote: "" })) }));
    fs.writeFileSync(path.join(userData, "preferences.json"), JSON.stringify({ repoPath: otherRepository, browserPath: scratch }));
    for (const phase of ["save", "restore"]) {
      const report = path.join(scratch, `${phase}.json`);
      const env = smokeEnvironment(process.env, scratch, repository, userData, report, phase);
      const program = launchServices ? "/usr/bin/open" : executable ? path.resolve(executable) : require("electron");
      const forwarded = Object.keys(env).filter((key) => key.startsWith("FORKDECK_SMOKE_") || ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM", "GIT_TEMPLATE_DIR", "GH_CONFIG_DIR", "GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "GH_PROMPT_DISABLED"].includes(key));
      const args = launchServices
        ? ["-W", "-n", "-g", "-j", ...forwarded.flatMap((key) => ["--env", `${key}=${env[key]}`]),
          path.resolve(executable), "--args", "--forkdeck-smoke"]
        : [...(executable ? [] : [root]), "--forkdeck-smoke"];
      const child = spawn(program, args, { cwd: scratch, env, stdio: "inherit" });
      const timeout = setTimeout(() => child.kill(), 90000);
      const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }).finally(() => clearTimeout(timeout));
      assert.equal(fs.existsSync(report), true, `Desktop exited ${exitCode} without a smoke report`);
      const result = JSON.parse(fs.readFileSync(report, "utf8"));
      assert.equal(result.ok, true, result.error);
      assert.equal(exitCode, 0);
      if (executable) assert.equal(result.packaged, true);
      else assert.equal(result.packaged, false);
      reports.push(result);
    }
    successful = true;
    console.log(JSON.stringify({ ok: true, launches: reports, isolatedGit: true, restoredAcrossLaunches: true }, null, 2));
  } finally {
    if (keep || !successful) console.log(`Desktop smoke artifacts: ${scratch}`);
    else fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { smokeEnvironment };
