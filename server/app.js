const http = require("node:http");
const { PORT } = require("./config");
const { send } = require("./http");
const { handleApi } = require("./routes/api");
const { serveStatic } = require("./static");
const { validateRequest, setSecurityHeaders } = require("./security");

async function handleRequest(req, res) {
  setSecurityHeaders(res);
  try {
    const url = validateRequest(req);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.message || "Unexpected server error." });
  }
}

function createServer() {
  return http.createServer(handleRequest);
}

function startServer(port = PORT) {
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log("ForkDeck running at http://127.0.0.1:" + server.address().port);
  });
  return server;
}

module.exports = { createServer, startServer };
