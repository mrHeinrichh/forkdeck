const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules", "lucide");
const destination = path.join(root, "public", "vendor");
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(source, "dist", "umd", "lucide.min.js"), path.join(destination, "lucide.min.js"));
fs.copyFileSync(path.join(source, "LICENSE"), path.join(destination, "lucide.LICENSE"));
console.log("Bundled Lucide icons for offline use.");
