const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { BrowserWindow, dialog } = require("electron");

async function waitFor(window, expression, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function checkDesktop({ mainWindow, origin, rendererErrors, smoke, createWindow, getWindow, preferences, externalLinks }) {
  const expectedBrowserPath = smoke.phase === "restore" ? smoke.repository : smoke.scratch;
  const unauthorized = await fetch(`${origin}/api/profiles`);
  assert.equal(unauthorized.status, 401, "Other local callers must not reach the desktop API");
  await waitFor(mainWindow, "document.querySelectorAll('[data-repo-path]').length >= 2 && document.querySelector('#branchButtonLabel')?.textContent === 'main' && typeof window.lucide?.createIcons === 'function'", "Repository tabs did not finish loading");
  const checks = await mainWindow.webContents.executeJavaScript(`(async () => {
    const existing = await fetch('/api/profiles').then(r => r.json());
    const id = existing.profiles.find(p => p.email === 'smoke@example.invalid')?.id;
    const profile = await fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ForkDeck-Request': '1' }, body: JSON.stringify({ ...(id ? { id } : {}), label: 'Smoke', name: 'Smoke Test', email: 'smoke@example.invalid' }) });
    const profiles = await fetch('/api/profiles').then(r => r.json());
    const repository = await fetch('/api/repo?path=' + encodeURIComponent(${JSON.stringify(smoke.repository)}));
    const snapshot = await repository.json();
    const clipboardWrite = await navigator.permissions.query({ name: 'clipboard-write' });
    const clipboardRead = await navigator.permissions.query({ name: 'clipboard-read' });
    const nativePreferences = await window.forkdeckDesktop.getPreferences();
    return {
      title: document.title,
      hasShell: Boolean(document.querySelector('.shell')),
      hasNativePicker: typeof window.forkdeckDesktop?.chooseDirectory === 'function',
      hasNode: typeof window.require !== 'undefined',
      hasOfflineIcons: typeof window.lucide?.createIcons === 'function',
      clipboardWrite: clipboardWrite.state,
      clipboardRead: clipboardRead.state,
      profileSaved: profile.status === 200 && profiles.profiles.some(p => p.email === 'smoke@example.invalid'),
      repositoryLoaded: repository.status === 200 && snapshot.commits?.some(c => c.subject === 'Desktop smoke fixture'),
      restoredRepo: localStorage.getItem('repoPath'),
      nativePreferences
    };
  })()`);
  assert.equal(checks.title, "ForkDeck");
  assert.equal(checks.hasShell, true);
  assert.equal(checks.hasNativePicker, true);
  assert.equal(checks.hasNode, false);
  assert.equal(checks.hasOfflineIcons, true);
  assert.equal(checks.clipboardWrite, "granted");
  assert.equal(checks.clipboardRead, "denied");
  assert.equal(checks.profileSaved, true);
  assert.equal(checks.repositoryLoaded, true);
  assert.equal(checks.nativePreferences.browserPath, expectedBrowserPath, "Folder selection must persist in native preferences");
  if (smoke.phase === "restore") {
    assert.equal(checks.restoredRepo, smoke.repository, "The selected repository must survive an app restart");
    assert.equal(checks.nativePreferences.repoPath, smoke.repository);
  } else {
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-repo-path="' + CSS.escape(${JSON.stringify(smoke.repository)}) + '"]').click()`);
    await waitFor(mainWindow, `window.forkdeckDesktop.getPreferences().then(p => p.repoPath === ${JSON.stringify(smoke.repository)})`, "Selecting a repository did not persist native preferences");
  }
  const stored = JSON.parse(await fs.readFile(path.join(process.env.FORKDECK_DATA_DIR, "profiles.json"), "utf8"));
  assert.equal(stored.profiles.some((profile) => profile.email === "smoke@example.invalid"), true);
  const webPreferences = mainWindow.webContents.getLastWebPreferences();
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(mainWindow.webContents.session.isPersistent(), false, "The browser session should not retain cookies or history");
  assert.deepEqual(rendererErrors, [], "The renderer must load without errors");
  await mainWindow.webContents.executeJavaScript("window.open('https://github.com/mrHeinrichh/forkdeck'); window.open('file:///tmp/forbidden'); null", true);
  assert.deepEqual(externalLinks, ["https://github.com/mrHeinrichh/forkdeck"], "Only safe HTTPS links should be sent to the external browser");
  assert.equal(BrowserWindow.getAllWindows().length, 1, "External links must never create a privileged app window");
  assert.equal(mainWindow.webContents.getURL(), origin + "/");

  // Reopening the native window must retain API access and restore the same selection.
  await new Promise((resolve) => { mainWindow.once("closed", resolve); mainWindow.close(); });
  assert.equal(getWindow(), null);
  const reopened = await createWindow();
  await waitFor(reopened, `localStorage.getItem('repoPath') === ${JSON.stringify(smoke.repository)} && document.querySelectorAll('[data-repo-path]').length >= 2`, "Reopened window did not restore the selected repository");
  const reopenedProfileStatus = await reopened.webContents.executeJavaScript("fetch('/api/profiles').then(r => r.status)");
  assert.equal(reopenedProfileStatus, 200);

  // The application's minimum supported size still needs an operable repository picker.
  reopened.setContentSize(960, 640);
  await reopened.webContents.executeJavaScript("document.querySelector('#newRepoTabButton').click()");
  await waitFor(reopened, `document.querySelector('#repoDialog')?.hidden === false && document.querySelector('#pathBrowserCurrent')?.textContent === ${JSON.stringify(expectedBrowserPath)}`, "The repository picker did not restore its saved folder");
  const layout = await reopened.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#chooseFolderButton');
    const rect = button.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth, browserPath: document.querySelector('#pathBrowserCurrent').textContent,
      pickerVisible: !button.hidden && rect.width > 0 && rect.height > 0 && rect.right <= innerWidth + 1 && rect.left >= 0 && rect.top >= 0 && rect.bottom <= innerHeight + 1 };
  })()`);
  await fs.writeFile(path.join(smoke.scratch, `desktop-${smoke.phase}-minimum.png`), (await reopened.webContents.capturePage()).toPNG());
  assert.equal(layout.pickerVisible, true, "Native picker must be reachable at the minimum window size");
  assert.equal(layout.browserPath, expectedBrowserPath, "Opening the folder browser must restore its saved directory");

  // Stub only the operating-system dialog: exercise the real sandboxed IPC and UI handlers.
  const showOpenDialog = dialog.showOpenDialog;
  let pickerOptions;
  try {
    dialog.showOpenDialog = async (_window, options) => { pickerOptions = options; return { canceled: true, filePaths: [] }; };
    assert.equal(await reopened.webContents.executeJavaScript("window.forkdeckDesktop.chooseDirectory()"), null);
    assert.deepEqual(pickerOptions.properties, ["openDirectory"]);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [smoke.repository] });
    await reopened.webContents.executeJavaScript("document.querySelector('#chooseFolderButton').click()");
    await waitFor(reopened, `window.forkdeckDesktop.getPreferences().then(p => p.browserPath === ${JSON.stringify(smoke.repository)})`, "Native folder selection did not persist");
    assert.equal(await reopened.webContents.executeJavaScript("document.querySelector('#pathBrowserCurrent').textContent"), smoke.repository);
  } finally { dialog.showOpenDialog = showOpenDialog; }
  assert.ok(layout.pageWidth <= layout.width + 1, `The minimum-size window overflows horizontally (${layout.pageWidth} > ${layout.width})`);
  const unexpectedErrors = rendererErrors.filter((message) => message !== "Not allowed to load local resource: file:///tmp/forbidden");
  assert.deepEqual(unexpectedErrors, [], "The desktop renderer must load and reopen without errors");
  await preferences.flush();
  return { ...checks, nativePreferences: undefined, minimumLayout: layout, sessionBoundary: true, writableUserData: true, sandbox: true, windowReopened: true, nativePreferencesRestored: true, nativePickerIpc: true, externalNavigation: true };
}

module.exports = { checkDesktop };
