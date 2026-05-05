const fs = require("node:fs/promises");
const path = require("node:path");
const { MIME, PUBLIC_DIR } = require("./config");
const { send } = require("./http");

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (path.relative(PUBLIC_DIR, filePath).startsWith("..")) return send(res, 403, "Forbidden");

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, "Not found");
    throw error;
  }
}

module.exports = { serveStatic };
