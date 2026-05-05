const { send, readBody } = require("../http");
const { ensureProfiles, saveProfiles, cleanProfile } = require("../storage");

async function handleProfiles(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/profiles") {
    return send(res, 200, await ensureProfiles());
  }

  if (req.method === "POST" && url.pathname === "/api/profiles") {
    const body = await readBody(req);
    const store = await ensureProfiles();
    const profile = cleanProfile(body);
    const index = store.profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) store.profiles[index] = profile;
    else store.profiles.push(profile);
    await saveProfiles(store);
    return send(res, 200, { profile, profiles: store.profiles });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/profiles/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const store = await ensureProfiles();
    store.profiles = store.profiles.filter((profile) => profile.id !== id);
    await saveProfiles(store);
    return send(res, 200, store);
  }

  return false;
}

module.exports = { handleProfiles };
