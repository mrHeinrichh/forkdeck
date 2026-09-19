const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const staged = process.platform === "darwin" ? fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-build-")) : null;
const output = path.join(root, "dist");
try {
  const result = spawnSync(process.execPath, [require.resolve("electron-builder/cli.js"), ...args, "--publish", "never",
    ...(staged ? ["--config.directories.output", staged] : [])], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Desktop packaging failed (${result.status}).`);
  if (staged) {
    // Build and sign away from cloud folders: Finder/FileProvider metadata can
    // reappear during signing even if an afterPack hook removes it first.
    fs.mkdirSync(output, { recursive: true });
    for (const entry of fs.readdirSync(staged, { withFileTypes: true })) {
      const source = path.join(staged, entry.name);
      const target = path.join(output, entry.name);
      if (entry.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true, force: true, verbatimSymlinks: true });
    }
  }
  console.log(`Desktop packages available in ${output}`);
} finally {
  if (staged) fs.rmSync(staged, { recursive: true, force: true });
}
