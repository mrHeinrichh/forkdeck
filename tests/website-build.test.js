const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { buildWebsite, websiteFiles } = require("../scripts/build-website");

test("website publishing includes only public assets and removes stale output", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "forkdeck-website-"));
  const destination = path.join(temporary, "website");
  try {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "stale.txt"), "Not part of the website");
    assert.equal(buildWebsite(destination), destination);
    const files = fs.readdirSync(destination, { recursive: true }).filter(file => fs.statSync(path.join(destination, file)).isFile()).map(file => file.replaceAll("\\", "/"));
    assert.deepEqual(files.sort(), [...websiteFiles].sort());
    for (const file of websiteFiles) assert.deepEqual(fs.readFileSync(path.join(destination, file)), fs.readFileSync(path.join(__dirname, "..", "website", file)));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
