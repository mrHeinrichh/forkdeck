const { send, readBody } = require("../http");
const { git } = require("../git");
const { ensureProfiles } = require("../storage");
const { appStatus } = require("../services/repoService");
const { readGitHubAuth, fixGitHubAuth } = require("../services/githubAuthService");
const { handleProfiles } = require("./profiles");
const { handleRepo } = require("./repo");

async function handleApi(req, res, url) {
  const profileHandled = await handleProfiles(req, res, url);
  if (profileHandled !== false) return;

  const repoHandled = await handleRepo(req, res, url);
  if (repoHandled !== false) return;

  if (req.method === "GET" && url.pathname === "/api/status") {
    return send(res, 200, await appStatus());
  }

  if (req.method === "GET" && url.pathname === "/api/auth/github") {
    return send(res, 200, await readGitHubAuth({ path: url.searchParams.get("path") || "" }));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/github/fix") {
    const body = await readBody(req);
    return send(res, 200, await fixGitHubAuth({ path: body.path || "", user: body.user || "" }));
  }

  if (req.method === "POST" && url.pathname === "/api/switch") {
    const body = await readBody(req);
    const store = await ensureProfiles();
    const profile = store.profiles.find((item) => item.id === body.profileId);
    if (!profile) return send(res, 404, { error: "Profile not found." });

    await git(["config", "--global", "user.name", profile.name]);
    await git(["config", "--global", "user.email", profile.email]);
    return send(res, 200, { profile, status: await appStatus() });
  }

  return send(res, 404, { error: "No API route matched." });
}

module.exports = { handleApi };
