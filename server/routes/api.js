const { send, readBody } = require("../http");
const { git, repoRoot } = require("../git");
const { ensureProfiles } = require("../storage");
const { appStatus } = require("../services/repoService");
const { readGitHubAuth, fixGitHubAuth } = require("../services/githubAuthService");
const { handleProfiles } = require("./profiles");
const { handleRepo } = require("./repo");
const { handleCommit } = require("./commit");
const { handleHistory } = require("./history");
const identityUpdates = new Map();

function applyIdentity(root, profile) {
  const update = (identityUpdates.get(root) || Promise.resolve()).then(async () => {
    const previousNames = await git(["-C", root, "config", "--local", "--null", "--get-all", "user.name"], undefined, true);
    await git(["-C", root, "config", "--local", "--replace-all", "user.name", profile.name]);
    try {
      await git(["-C", root, "config", "--local", "--replace-all", "user.email", profile.email]);
    } catch (error) {
      await git(["-C", root, "config", "--local", "--unset-all", "user.name"], undefined, true);
      for (const name of previousNames ? previousNames.split("\0").slice(0, -1) : []) {
        await git(["-C", root, "config", "--local", "--add", "user.name", name]);
      }
      throw error;
    }
  });
  const settled = update.catch(() => {});
  identityUpdates.set(root, settled);
  settled.then(() => { if (identityUpdates.get(root) === settled) identityUpdates.delete(root); });
  return update;
}

async function handleApi(req, res, url) {
  const profileHandled = await handleProfiles(req, res, url);
  if (profileHandled !== false) return;

  if (await handleCommit(req, res, url) !== false) return;
  if (await handleHistory(req, res, url) !== false) return;

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

    if (typeof body.path !== "string" || !body.path.trim()) return send(res, 400, { error: "Choose a repository before applying a commit identity." });
    const root = await repoRoot(body.path);
    await applyIdentity(root, profile);
    return send(res, 200, { profile, root, identity: { name: profile.name, email: profile.email }, status: await appStatus() });
  }

  return send(res, 404, { error: "No API route matched." });
}

module.exports = { handleApi };
