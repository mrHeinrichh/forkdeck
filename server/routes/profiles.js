const { send, readBody } = require("../http");
const { ensureProfiles, updateProfiles, cleanProfile } = require("../storage");

async function handleProfiles(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/profiles") {
    return send(res, 200, await ensureProfiles());
  }

  if (req.method === "POST" && url.pathname === "/api/profiles") {
    const body = await readBody(req);
    const profile = cleanProfile(body);
    const store = await updateProfiles((data) => {
      const index = data.profiles.findIndex((item) => item.id === profile.id);
      if (body.id && index < 0) throw Object.assign(new Error("Profile not found. Create a new profile instead."), { status: 404 });
      if (data.profiles.some((item) => item.id !== profile.id && item.label.toLowerCase() === profile.label.toLowerCase())) {
        throw Object.assign(new Error("A profile with this label already exists. Choose another label."), { status: 409 });
      }
      if (index >= 0) data.profiles[index] = profile;
      else data.profiles.push(profile);
    });
    return send(res, 200, { profile, profiles: store.profiles });
  }

  if (req.method === "DELETE" && /^\/api\/profiles\/[^/]+$/.test(url.pathname)) {
    let id;
    try { id = decodeURIComponent(url.pathname.split("/").pop()); }
    catch { throw Object.assign(new Error("Invalid profile ID."), { status: 400 }); }
    const store = await updateProfiles((data) => {
      if (!data.profiles.some((profile) => profile.id === id)) throw Object.assign(new Error("Profile not found."), { status: 404 });
      data.profiles = data.profiles.filter((profile) => profile.id !== id);
    });
    return send(res, 200, store);
  }

  return false;
}

module.exports = { handleProfiles };
