const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

assert.equal(process.platform, "darwin", "macOS bundle verification requires macOS");
const arch = process.argv[2] || process.arch;
assert.ok(["arm64", "x64"].includes(arch), "Expected arm64 or x64");
const root = path.resolve(__dirname, "..");
const { version } = require("../package.json");
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, "dist");
const bundle = path.join(output, arch === "arm64" ? "mac-arm64" : "mac", "ForkDeck.app");
const archive = path.join(output, `ForkDeck-${version}-mac-${arch}.zip`);
const diskImage = path.join(output, `ForkDeck-${version}-mac-${arch}.dmg`);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-verify-"));
const extracted = path.join(scratch, "zip");
const mounted = path.join(scratch, "dmg");
let attached = false;

function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit", timeout: 120000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} failed: ${args.join(" ")}`);
}

function verify(appPath) {
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

try {
  verify(bundle);
  fs.mkdirSync(extracted);
  run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
  const archiveApp = path.join(extracted, "ForkDeck.app");
  verify(archiveApp);
  // Launch through the same macOS service used by Finder, from the delivered ZIP.
  run(process.execPath, [path.join(__dirname, "smoke-desktop.js"), archiveApp, "--launch-services"]);
  fs.mkdirSync(mounted);
  run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mounted, diskImage]);
  attached = true;
  verify(path.join(mounted, "ForkDeck.app"));
  console.log(`Verified ${arch} bundle, ZIP, DMG and LaunchServices startup.`);
} finally {
  if (attached) run("/usr/bin/hdiutil", ["detach", mounted]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
