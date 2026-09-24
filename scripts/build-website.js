const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const websiteFiles = ["index.html", "styles.css", "assets/favicon.svg", "assets/workspace.png"];

function buildWebsite(destination = path.join(root, "dist", "website")) {
  // Only public download-page assets are deployed, never desktop code or local data.
  for (const file of websiteFiles) {
    const source = path.join(root, "website", file);
    if (!fs.lstatSync(source).isFile()) throw new Error(`Missing public website file: ${file}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  for (const file of websiteFiles) {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, "website", file), target);
  }
  return destination;
}

if (require.main === module) console.log(`Download website built at ${buildWebsite()}`);
module.exports = { buildWebsite, websiteFiles };
