const { timingSafeEqual } = require("node:crypto");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

function validateRequest(req, token = process.env.FORKDECK_DESKTOP_TOKEN || "") {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)) {
    throw requestError(403, "ForkDeck accepts local connections only.");
  }

  let base;
  try {
    base = new URL(`http://${req.headers.host}`);
  } catch {
    throw requestError(400, "Invalid local Host header.");
  }
  if (!LOOPBACK_HOSTS.has(base.hostname) || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash || Number(base.port || 80) !== req.socket.localPort) {
    throw requestError(403, "Invalid local Host header.");
  }
  let url;
  try { url = new URL(req.url, base); }
  catch { throw requestError(400, "Invalid request URL."); }
  if (url.origin !== base.origin) throw requestError(403, "Request must use the local app origin.");

  const origin = req.headers.origin;
  if ((origin && origin !== base.origin) || req.headers["sec-fetch-site"] === "cross-site" ||
      req.headers["sec-fetch-site"] === "same-site") {
    throw requestError(403, "Open this action from ForkDeck.");
  }

  if (url.pathname.startsWith("/api/")) {
    if (token) {
      const supplied = Buffer.from(String(req.headers["x-forkdeck-token"] || ""));
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw requestError(401, "This API is available only inside the ForkDeck desktop app.");
      }
    }
    if (!["GET", "HEAD"].includes(req.method) &&
        (req.headers["x-forkdeck-request"] !== "1" ||
         !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))) {
      throw requestError(403, "Use the ForkDeck app to make changes.");
    }
  }
  return url;
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"
  ].join("; "));
}

module.exports = { validateRequest, setSecurityHeaders };
