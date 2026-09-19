const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { isAppUrl, isAllowedImage, externalUrl, trustedFrame, canWriteClipboard, requestHeaders } = require("../desktop/policies");
const { smokeConfiguration } = require("../desktop/smoke-config");
const { smokeEnvironment } = require("../scripts/smoke-desktop");

const origin = "http://127.0.0.1:43123";
function windowFixture() {
  const frame = { url: origin + "/" };
  const contents = { mainFrame: frame, getURL: () => origin + "/" };
  const window = { webContents: contents, isDestroyed: () => false };
  return { window, contents, frame, event: { sender: contents, senderFrame: frame } };
}

test("desktop API requests are bound to the current HTTP origin", () => {
  assert.equal(isAppUrl(origin + "/api/repos", origin), true);
  for (const url of ["http://localhost:43123/", "http://127.0.0.1:43124/", "https://127.0.0.1:43123/", "http://name@127.0.0.1:43123/", "blob:" + origin + "/value", "file:///etc/passwd", "not a URL"]) {
    assert.equal(isAppUrl(url, origin), false, url);
  }
});

test("tokens reach only the private origin and are removed from avatar requests", () => {
  const headers = { "x-forkdeck-token": "old", Accept: "image/png" };
  assert.deepEqual(requestHeaders({ url: origin + "/api/repos", requestHeaders: headers }, origin, "private-token"), { requestHeaders: { Accept: "image/png", "X-ForkDeck-Token": "private-token" } });
  assert.deepEqual(requestHeaders({ url: "https://avatars.githubusercontent.com/u/123", resourceType: "image", requestHeaders: headers }, origin, "private-token"), { requestHeaders: { Accept: "image/png" } });
  assert.deepEqual(requestHeaders({ url: "https://example.com/", resourceType: "image", requestHeaders: headers }, origin, "private-token"), { cancel: true });
  assert.equal(isAllowedImage({ url: "https://github.com/example.png", resourceType: "script" }), false);
  assert.equal(isAllowedImage({ url: "https://user@github.com/example.png", resourceType: "image" }), false);
  assert.equal(isAllowedImage({ url: "https://github.com.example.com/example.png", resourceType: "image" }), false);
});

test("external navigation only accepts ordinary HTTPS links", () => {
  assert.equal(externalUrl("https://github.com/mrHeinrichh/forkdeck"), "https://github.com/mrHeinrichh/forkdeck");
  for (const value of ["http://example.com", "file:///Applications/Example.app", "javascript:alert(1)", "mailto:user@example.com", "https://name:secret@example.com", "\\\\server\\share", "bad input"]) assert.equal(externalUrl(value), null, value);
});

test("native IPC rejects other contents, subframes, and stale navigation", () => {
  const { window, event, contents } = windowFixture();
  assert.equal(trustedFrame(event, window, origin), true);
  assert.equal(trustedFrame({ ...event, sender: {} }, window, origin), false);
  assert.equal(trustedFrame({ ...event, senderFrame: { url: origin } }, window, origin), false);
  contents.mainFrame.url = "https://example.com";
  assert.equal(trustedFrame(event, window, origin), false);
  assert.equal(trustedFrame(event, null, origin), false);
});

test("clipboard is write-only and only available to the current trusted main frame", () => {
  const { window, contents } = windowFixture();
  const details = { isMainFrame: true, requestingUrl: origin + "/" };
  assert.equal(canWriteClipboard(contents, "clipboard-sanitized-write", details, window, origin), true);
  assert.equal(canWriteClipboard(contents, "clipboard-read", details, window, origin), false);
  assert.equal(canWriteClipboard(contents, "geolocation", details, window, origin), false);
  assert.equal(canWriteClipboard(contents, "clipboard-sanitized-write", { ...details, isMainFrame: false }, window, origin), false);
  assert.equal(canWriteClipboard(contents, "clipboard-sanitized-write", { ...details, requestingUrl: "https://example.com" }, window, origin), false);
  assert.equal(canWriteClipboard({}, "clipboard-sanitized-write", details, window, origin), false);
});

test("smoke mode fails closed without complete isolated paths", () => {
  const base = { FORKDECK_SMOKE_ROOT: "/tmp/desktop-smoke", FORKDECK_SMOKE_REPORT: "/tmp/desktop-smoke/report.json", FORKDECK_SMOKE_USER_DATA: "/tmp/desktop-smoke/data", FORKDECK_SMOKE_REPO: "/tmp/desktop-smoke/repo", GIT_CONFIG_GLOBAL: "/tmp/desktop-smoke/gitconfig", GIT_CONFIG_NOSYSTEM: "1" };
  assert.equal(smokeConfiguration([], base, path.posix), null);
  assert.equal(smokeConfiguration(["--forkdeck-smoke"], base, path.posix).phase, "save");
  for (const key of ["FORKDECK_SMOKE_ROOT", "FORKDECK_SMOKE_REPORT", "FORKDECK_SMOKE_USER_DATA", "FORKDECK_SMOKE_REPO", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
    assert.throws(() => smokeConfiguration(["--forkdeck-smoke"], { ...base, [key]: "" }, path.posix), key);
  }
  assert.throws(() => smokeConfiguration(["--forkdeck-smoke"], { ...base, FORKDECK_SMOKE_USER_DATA: "/Users/person/Library/Application Support/ForkDeck" }, path.posix));
  assert.throws(() => smokeConfiguration(["--forkdeck-smoke"], { ...base, FORKDECK_SMOKE_REPO: "/tmp/desktop-smoke/../real-repo" }, path.posix));
  const win = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, value.replace("/tmp/desktop-smoke", "C:\\Temp\\desktop-smoke").replaceAll("/", "\\")]));
  assert.equal(smokeConfiguration(["--forkdeck-smoke"], win, path.win32).userData, "C:\\Temp\\desktop-smoke\\data");
});

test("smoke environment drops credentials, repo overrides, and user Git hooks", () => {
  const env = smokeEnvironment({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", GH_TOKEN: "example", GITHUB_TOKEN: "example", GIT_DIR: "/real/.git", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/real/hooks", GIT_CONFIG_PARAMETERS: "untrusted", FORKDECK_DATA_DIR: "/real/data" }, "/tmp/smoke", "/tmp/smoke/repo", "/tmp/smoke/user-data", "/tmp/smoke/report", "save");
  for (const key of ["ELECTRON_RUN_AS_NODE", "GH_TOKEN", "GITHUB_TOKEN", "GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS"]) assert.equal(env[key], undefined, key);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join("/tmp/smoke", "gitconfig"));
  assert.equal(env.GH_CONFIG_DIR, path.join("/tmp/smoke", "gh-config"));
});
