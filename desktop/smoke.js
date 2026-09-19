const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function checkDesktop({ mainWindow, origin, rendererErrors }) {
  const unauthorized = await fetch(`${origin}/api/profiles`);
  assert.equal(unauthorized.status, 401, "Other local callers must not reach the desktop API");
  const checks = await mainWindow.webContents.executeJavaScript(`(async () => {
    const profile = await fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ForkDeck-Request': '1' }, body: JSON.stringify({ label: 'Smoke', name: 'Smoke Test', email: 'smoke@example.invalid' }) });
    const profiles = await fetch('/api/profiles').then(r => r.json());
    const repository = await fetch('/api/repo?path=' + encodeURIComponent(${JSON.stringify(process.env.FORKDECK_SMOKE_REPO)}));
    const snapshot = await repository.json();
    const clipboardWrite = await navigator.permissions.query({ name: 'clipboard-write' });
    const clipboardRead = await navigator.permissions.query({ name: 'clipboard-read' });
    return {
      title: document.title,
      hasShell: Boolean(document.querySelector('.shell')),
      hasNativePicker: typeof window.forkdeckDesktop?.chooseDirectory === 'function',
      hasNode: typeof window.require !== 'undefined',
      hasOfflineIcons: typeof window.lucide?.createIcons === 'function',
      clipboardWrite: clipboardWrite.state,
      clipboardRead: clipboardRead.state,
      profileSaved: profile.status === 200 && profiles.profiles.some(p => p.email === 'smoke@example.invalid'),
      repositoryLoaded: repository.status === 200 && snapshot.commits?.some(c => c.subject === 'Desktop smoke fixture')
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
  const stored = JSON.parse(await fs.readFile(path.join(process.env.FORKDECK_DATA_DIR, "profiles.json"), "utf8"));
  assert.equal(stored.profiles.some((profile) => profile.email === "smoke@example.invalid"), true);
  assert.deepEqual(rendererErrors, [], "The packaged renderer must load without errors");
  const preferences = mainWindow.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  return { ...checks, sessionBoundary: true, writableUserData: true, sandbox: true };
}

module.exports = { checkDesktop };
