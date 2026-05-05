const http = require("node:http");
const { PORT } = require("./config");
const { send } = require("./http");
const { handleApi } = require("./routes/api");
const { serveStatic } = require("./static");

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://" + req.headers.host);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    send(res, error.status || 500, { error: error.message || "Unexpected server error." });
  }
}

function createServer() {
  return http.createServer(handleRequest);
}

function startServer(port = PORT) {
  const server = createServer();
  server.listen(port, () => {
    console.log("ForkDeck running at http://localhost:" + port);
  });
  return server;
}

module.exports = { createServer, startServer };
