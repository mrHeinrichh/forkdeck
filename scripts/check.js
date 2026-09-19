const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const sources = ["server.js"];
for (const directory of ["server", "public/src", "desktop", "scripts", "test", "tests"]) {
  const start = path.join(root, directory);
  if (!fs.existsSync(start)) continue;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:c?js|mjs)$/.test(entry.name)) sources.push(file);
    }
  };
  walk(start);
}
for (const file of sources) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${sources.length} JavaScript files.`);
