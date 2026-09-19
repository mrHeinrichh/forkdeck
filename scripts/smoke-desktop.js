const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

async function main() {
  const executable = process.argv[2];
  const launchServices = process.argv.includes("--launch-services");
  if (launchServices) {
    assert.equal(process.platform, "darwin", "LaunchServices smoke runs only on macOS");
    assert.ok(executable?.endsWith(".app"), "Pass a .app bundle for LaunchServices smoke");
  }
  const root = path.resolve(__dirname, "..");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-smoke-"));
  const repository = path.join(scratch, "repository with spaces");
  const userData = path.join(scratch, "user-data");
  const report = path.join(scratch, "report.json");
  fs.mkdirSync(repository);
  fs.mkdirSync(userData);
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  try {
    git(["init", "--initial-branch=main"]);
    fs.writeFileSync(path.join(repository, "README.md"), "ForkDeck desktop smoke fixture.\n");
    git(["add", "README.md"]);
    git(["-c", "user.name=Smoke Test", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Desktop smoke fixture"]);
    const env = { ...process.env, FORKDECK_SMOKE_REPORT: report, FORKDECK_SMOKE_USER_DATA: userData, FORKDECK_SMOKE_REPO: repository };
    delete env.ELECTRON_RUN_AS_NODE;
    const program = launchServices ? "/usr/bin/open" : executable ? path.resolve(executable) : require("electron");
    const args = launchServices
      ? ["-W", "-n", "-g", "-j",
        "--env", `FORKDECK_SMOKE_REPORT=${report}`,
        "--env", `FORKDECK_SMOKE_USER_DATA=${userData}`,
        "--env", `FORKDECK_SMOKE_REPO=${repository}`,
        path.resolve(executable), "--args", "--forkdeck-smoke"]
      : [...(executable ? [] : [root]), "--forkdeck-smoke"];
    const child = spawn(program, args, { cwd: os.tmpdir(), env, stdio: "inherit" });
    const timeout = setTimeout(() => child.kill(), 90000);
    const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }).finally(() => clearTimeout(timeout));
    assert.equal(fs.existsSync(report), true, `Desktop exited ${exitCode} without a smoke report`);
    const result = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(result.ok, true, result.error);
    assert.equal(exitCode, 0);
    if (executable) assert.equal(result.packaged, true);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
