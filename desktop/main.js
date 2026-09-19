const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const policies = require("./policies");
const { createPreferenceStore } = require("./preferences");
const { smokeConfiguration } = require("./smoke-config");

app.setName("ForkDeck");
const smoke = smokeConfiguration(process.argv, process.env);
const smokeMode = Boolean(smoke);
if (smokeMode) app.setPath("userData", smoke.userData);

let mainWindow;
let server;
let origin;
let preferences;
let quitting = false;
const token = crypto.randomBytes(32).toString("hex");
const rendererErrors = [];
const smokeExternalLinks = [];

function isAppUrl(value) {
  return policies.isAppUrl(value, origin);
}

function canWriteClipboard(contents, permission, details) {
  return policies.canWriteClipboard(contents, permission, details, mainWindow, origin);
}

function openExternal(value) {
  const url = policies.externalUrl(value);
  if (!url) return;
  if (smokeMode) smokeExternalLinks.push(url); // Native checks must never open the user's browser.
  else shell.openExternal(url).catch((error) => console.error("Could not open link:", error.message));
}

async function finishSmoke(error, checks = {}) {
  try { await preferences?.flush(); } catch (flushError) { error ||= flushError; }
  await fs.writeFile(smoke.report, JSON.stringify({
    ok: !error,
    error: error ? error.stack || String(error) : undefined,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    origin,
    phase: smoke.phase,
    checks
  }, null, 2));
  if (server) await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  app.exit(error ? 1 : 0);
}

async function runSmoke() {
  const { checkDesktop } = require("./smoke");
  try {
    const checks = await checkDesktop({ mainWindow, origin, rendererErrors, smoke, createWindow, getWindow: () => mainWindow, preferences, externalLinks: smokeExternalLinks });
    await finishSmoke(null, checks);
  } catch (error) {
    await finishSmoke(error);
  }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [{ label: "Choose Repository…", accelerator: "CmdOrCtrl+O", click: () => {
      mainWindow?.webContents.executeJavaScript("document.querySelector('#newRepoTabButton')?.click()").catch(() => {});
    } }, { type: "separator" }, { role: process.platform === "darwin" ? "close" : "quit" }] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "ForkDeck on GitHub", click: () => openExternal("https://github.com/mrHeinrichh/forkdeck") }] }
  ]));
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#101515",
    title: "ForkDeck",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      session: session.fromPartition("forkdeck"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged
    }
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.on("will-redirect", (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") rendererErrors.push(details.message);
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.once("ready-to-show", () => { if (!smokeMode) window.show(); });
  await window.loadURL(origin);
  return window;
}

async function start() {
  process.env.FORKDECK_DATA_DIR = path.join(app.getPath("userData"), "data");
  process.env.FORKDECK_DESKTOP_TOKEN = token;
  preferences = createPreferenceStore(path.join(app.getPath("userData"), "preferences.json"));
  // Load only after setting configuration; the server runs inside Electron's Node runtime.
  const { createServer } = require("../server/app");
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  const desktopSession = session.fromPartition("forkdeck");
  desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(canWriteClipboard(contents, permission, details));
  });
  desktopSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return isAppUrl(requestingOrigin) && canWriteClipboard(contents, permission, details);
  });
  desktopSession.on("will-download", (event) => event.preventDefault());
  // The token stays in the main process. Only this private session can call the API.
  desktopSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAppUrl(details.url) && !policies.isAllowedImage(details) });
  });
  desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback(policies.requestHeaders(details, origin, token));
  });
  function assertTrustedFrame(event) {
    if (!policies.trustedFrame(event, mainWindow, origin)) throw new Error("Untrusted desktop request.");
  }
  ipcMain.handle("forkdeck:get-preferences", async (event) => {
    assertTrustedFrame(event);
    return preferences.get();
  });
  ipcMain.handle("forkdeck:set-preferences", async (event, values) => {
    assertTrustedFrame(event);
    await preferences.set(values);
  });
  ipcMain.handle("forkdeck:choose-directory", async (event) => {
    assertTrustedFrame(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open a Git repository",
      buttonLabel: "Open Repository",
      properties: ["openDirectory"],
      defaultPath: app.getPath("home")
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  installMenu();
  await createWindow();
  if (smokeMode) await runSmoke();
}

const hasLock = smokeMode || app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.setAppUserModelId("com.mrheinrichh.forkdeck");
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (origin) createWindow().catch(showStartupError);
  });
  app.whenReady().then(start).catch(showStartupError);
  app.on("activate", () => { if (!mainWindow && origin) createWindow().catch(showStartupError); });
  app.on("window-all-closed", () => { if (!smokeMode && process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    const timeout = setTimeout(() => app.exit(0), 3000);
    timeout.unref();
    server.close(async () => {
      try { await preferences?.flush(); } catch (error) { console.error("Could not save workspace preferences:", error.message); }
      clearTimeout(timeout);
      app.quit();
    });
    server.closeIdleConnections?.();
  });
}

async function showStartupError(error) {
  if (smokeMode) return finishSmoke(error);
  dialog.showErrorBox("ForkDeck could not start", error.message || String(error));
  app.quit();
}
