// Standalone browser integration checks. Run with `node scripts/test-ui.js` after
// installing Playwright Chromium. All repositories, data, and Git config are disposable.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createFixtures, startServer } = require("./test-ui-fixtures");

async function eventually(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof message === "function" ? message() : message, lastError ? { cause: lastError } : undefined);
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function main() {
  const { chromium } = require("playwright");
  const root = path.resolve(__dirname, "..");
  const artifacts = path.join(root, "output", "ui-checks");
  await fs.mkdir(artifacts, { recursive: true });
  await Promise.all(["ui-failure.png", "ui-failure.html", "diagnostics.json", "trace.zip", "result.json"].map((name) => fs.rm(path.join(artifacts, name), { force: true })));
  const fixture = createFixtures();
  let server;
  let browser;
  let context;
  let page;
  let passed = 0;
  let current = "setup";
  let success = false;
  const pageErrors = [];
  const consoleErrors = [];
  const failedResponses = [];
  const failedRequests = [];
  const apiHistory = [];
  const responseBodies = new Set();
  const expectedResponses = new Set();
  const run = async (name, task) => { current = name; await task(); passed += 1; };
  try {
    server = await startServer(root, fixture);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    // Seed only the fixture's initial browsing location; never list the user's home.
    await context.addInitScript((scratch) => {
      if (!localStorage.getItem("browserPath")) localStorage.setItem("browserPath", scratch);
    }, fixture.scratch);
    await context.route(/^https:\/\//, async (route) => {
      if (route.request().resourceType() === "image") {
        await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="11" fill="#1b9088"/></svg>' });
      } else {
        await route.abort();
      }
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => failedRequests.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText }));
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push(response);
      const url = new URL(response.url());
      if (url.origin !== server.origin || !url.pathname.startsWith("/api/")) return;
      const record = { method: response.request().method(), url: response.url(), status: response.status() };
      apiHistory.push(record);
      if (apiHistory.length > 100) apiHistory.shift();
      if (response.status() >= 400 || url.pathname === "/api/repo/diff") {
        const pending = response.text().then((body) => { record.body = body.slice(0, 12000); }, (error) => { record.bodyError = error.message; });
        responseBodies.add(pending);
        pending.finally(() => responseBodies.delete(pending));
      }
    });
    const text = (selector, expected) => {
      let actual;
      return eventually(async () => {
        actual = await page.locator(selector).textContent();
        return expected instanceof RegExp ? expected.test(actual || "") : actual === expected;
      }, () => `${selector} did not show ${expected}; actual text: ${JSON.stringify(actual?.slice(0, 3000))}`);
    };
    await run("initial loading blocks actions until startup finishes", async () => {
      const release = deferred();
      let delayed = false;
      const matcher = (url) => url.pathname === "/api/status";
      const handler = async (route) => { delayed = true; await release.promise; await route.continue(); };
      await page.route(matcher, handler);
      try {
        await page.goto(server.origin, { waitUntil: "domcontentloaded" });
        await eventually(() => delayed, "The initial status request was not intercepted");
        assert.equal(await page.locator(".shell").evaluate((shell) => shell.inert), true);
        assert.equal(await page.locator("body").getAttribute("aria-busy"), "true");
        // A real pointer click must be ignored while startup is pending. Force
        // bypasses Playwright's actionability wait, not Chromium's inert behavior.
        await page.locator("#newRepoTabButton").click({ force: true });
        assert.equal(await page.locator("#repoDialog").isVisible(), false);
        assert.equal(apiHistory.some((response) => new URL(response.url).pathname === "/api/fs"), false);
        release.resolve();
        await eventually(() => page.locator("body").getAttribute("data-ready").then((ready) => ready === "true"), "Application startup did not finish");
        assert.equal(await page.locator(".shell").evaluate((shell) => shell.inert), false);
        assert.equal(await page.locator("body").getAttribute("aria-busy"), null);
      } finally {
        release.resolve();
        await page.unroute(matcher, handler);
      }
    });
    const attribute = (scope, name, value) => page.locator(`${scope}[${name}=${JSON.stringify(value)}]`);
    const tab = (repo) => attribute("#repoTabs .repo-tab", "data-repo-path", repo);
    const repoReady = async (repo) => {
      await text("#repoName", path.basename(repo));
      await eventually(async () => (await tab(repo).getAttribute("class"))?.includes("is-current"), "Wrong active repository tab");
    };
    const responseFor = (pathname, method = "GET") => page.waitForResponse((response) => new URL(response.url()).pathname === pathname && response.request().method() === method);
    const openRepoDialog = async () => {
      const response = responseFor("/api/fs");
      await page.locator("#newRepoTabButton").click();
      const browse = await response;
      const result = await browse.json();
      await text("#pathBrowserCurrent", result.path);
      await eventually(async () => await page.locator("#localPathInput").inputValue() === result.path, "Folder input did not finish loading");
    };
    const addRepo = async (repo) => {
      await openRepoDialog();
      await page.locator("#localPathInput").fill(repo);
      const response = responseFor("/api/repos", "POST");
      await page.locator("#addRepoButton").click();
      assert.equal((await response).status(), 200);
      await repoReady(repo);
      await page.locator("#repoDialog").waitFor({ state: "hidden" });
    };
    const selectRepo = async (repo) => { await tab(repo).click(); await repoReady(repo); };
    const openIdentity = async (label) => {
      await page.locator("#accountButton").click();
      await page.locator("#accountMenuProfiles .profile-card").filter({ hasText: label }).locator(".profile-main").click();
      await page.locator("#accountEditorPanel").waitFor({ state: "visible" });
    };
    const withDelayedSnapshot = async (action, verify) => {
      const release = deferred();
      let captured = false;
      const matcher = (url) => url.pathname === "/api/repo" && url.searchParams.get("path") === fixture.alpha;
      const handler = async (route) => {
        if (captured) return route.continue();
        // Fetch the old snapshot now, then delay delivering it until after mutation.
        const response = await route.fetch();
        const body = await response.body();
        captured = true;
        await release.promise;
        await route.fulfill({ response, body });
      };
      await page.route(matcher, handler);
      try {
        await page.locator("#refreshButton").click();
        await eventually(() => captured, "The refresh snapshot was not captured");
        await action();
        const staleResponse = page.waitForResponse((response) => matcher(new URL(response.url())));
        release.resolve();
        await (await staleResponse).finished();
        await page.waitForLoadState("networkidle");
        await verify();
      } finally {
        release.resolve();
        await page.unroute(matcher, handler);
      }
    };

    await run("invalid and valid repository selection", async () => {
      await text("#repoNavCount", "0");
      await openRepoDialog();
      await page.locator("#localPathInput").fill(fixture.invalid);
      const error = responseFor("/api/repos", "POST");
      await page.locator("#addRepoButton").click();
      const rejected = await error;
      expectedResponses.add(rejected);
      assert.equal(rejected.status(), 400);
      await text("#toast", /not a git repository/i);
      assert.equal(await page.locator("#repoDialog").isVisible(), true);
      await text("#repoNavCount", "0");
      await page.locator("#localPathInput").fill(fixture.alpha);
      await page.locator("#addRepoButton").click();
      await repoReady(fixture.alpha);
      await text("#filePanelEyebrow", "Working Tree");
      await text("#accountButtonLabel", "Repository Original");
      await text("#aheadBehindPill", "0 ahead / 0 behind");
    });

    await run("untracked file preview", async () => {
      await attribute("#fileList [data-file]", "data-file", "notes/café draft.txt").click();
      await text("#commitDetailTitle", "notes/café draft.txt");
      await text("#commitPatch", /\+New untracked note/);
      assert.match(await page.locator("#commitPatch").textContent(), /new file mode/);
    });

    await run("combined staged and unstaged preview", async () => {
      await attribute("#fileList [data-file]", "data-file", "src/message.txt").first().click();
      await text("#commitPatch", /Staged changes[\s\S]*value = staged[\s\S]*Unstaged changes[\s\S]*value = working/);
    });

    await run("live diff refresh with unchanged Git status", async () => {
      const before = fixture.git(fixture.alpha, "status", "--porcelain=v1", "-z");
      fixture.write(fixture.alpha, "src/message.txt", "Stable heading\nvalue = changed\n");
      assert.equal(fixture.git(fixture.alpha, "status", "--porcelain=v1", "-z"), before);
      // Wait for the application's actual polling loop; no artificial refresh or timer overrides.
      await text("#commitPatch", /\+value = changed/);
      assert.doesNotMatch(await page.locator("#commitPatch").textContent(), /\+value = working/);
    });

    await run("root commit and empty commit inspection", async () => {
      await page.locator("#backToGraphButton").click();
      assert.match(await attribute("#commitGraph [data-commit]", "data-commit", fixture.rootCommit).textContent(), /Initial UI root commit/);
      await attribute("#commitGraph [data-commit]", "data-commit", fixture.rootCommit).click();
      await text("#filePanelEyebrow", "Commit");
      await attribute("#fileList [data-commit-file]", "data-commit-file", "README.md").click();
      await text("#commitPatch", /\+# Alpha UI fixture/);
      await page.locator("#backToGraphButton").click();
      await attribute("#commitGraph [data-commit]", "data-commit", fixture.emptyCommit).click();
      await text("#fileList", /This commit has no changed files/);
      assert.equal(await page.locator("#fileList [data-commit-file]").count(), 0);
      assert.equal(await page.locator("#inspectorView").isVisible(), false);
    });

    await run("repository identity changes leave global Git identity unchanged", async () => {
      await page.locator("#accountButton").click();
      await page.locator("#addAccountMenuButton").click();
      await page.locator("#label").fill("UI Team");
      await page.locator("#name").fill("UI Team Author");
      await page.locator("#email").fill("ui-team@example.invalid");
      await page.locator('#profileForm button[type="submit"]').click();
      await page.locator("#accountEditorPanel").waitFor({ state: "hidden" });
      await page.locator("#accountButton").click();
      await page.locator("#accountMenuProfiles .profile-card").filter({ hasText: "UI Team" }).getByRole("button", { name: "Use identity" }).click();
      await text("#accountButtonLabel", "UI Team");
      assert.equal(fixture.git(fixture.alpha, "config", "--local", "user.name"), "UI Team Author");
      assert.equal(fixture.git(fixture.alpha, "config", "--local", "user.email"), "ui-team@example.invalid");
      assert.equal(fixture.git(fixture.alpha, "config", "--global", "user.name"), "Global UI Fixture");
      assert.equal(fixture.git(fixture.alpha, "config", "--global", "user.email"), "global-ui@example.invalid");
    });

    await run("profile edit, cancel, and delete confirmation", async () => {
      await openIdentity("UI Team");
      await page.locator("#label").fill("Discard this edit");
      await page.locator("#closeAccountEditor").click();
      await openIdentity("UI Team");
      assert.equal(await page.locator("#label").inputValue(), "UI Team");
      await page.locator("#label").fill("UI Team Edited");
      await page.locator('#profileForm button[type="submit"]').click();
      await page.locator("#accountEditorPanel").waitFor({ state: "hidden" });
      await text("#accountButtonLabel", "UI Team Edited");
      await openIdentity("UI Team Edited");
      await page.locator("#deleteButton").click();
      await text("#actionDialogTitle", "Delete commit profile?");
      await page.locator("#actionDialogCancel").click();
      assert.equal(await page.locator("#label").inputValue(), "UI Team Edited");
      await page.locator("#deleteButton").click();
      await page.locator("#actionDialogConfirm").click();
      await text("#toast", "Identity removed.");
      await page.locator("#closeAccountEditor").click();
      await page.locator("#accountButton").click();
      await text("#accountMenuProfiles", /No saved identities yet/);
      await page.locator("#accountButton").click();
      assert.equal(fixture.git(fixture.alpha, "config", "--local", "user.name"), "UI Team Author");
    });

    await run("empty repository and second repository remain independent", async () => {
      await addRepo(fixture.empty);
      await text("#graphCount", "0 commits");
      await text("#fileList", /Working tree is clean/);
      await addRepo(fixture.beta);
      await text("#accountButtonLabel", "Secondary Author");
      assert.equal(fixture.git(fixture.beta, "config", "--local", "user.name"), "Secondary Author");
    });

    await run("late repository response cannot overwrite the last clicked tab", async () => {
      const release = deferred();
      let delayed = false;
      const matcher = (url) => url.pathname === "/api/repo" && url.searchParams.get("path") === fixture.alpha;
      const handler = async (route) => {
        if (!delayed) { delayed = true; await release.promise; }
        await route.continue();
      };
      await page.route(matcher, handler);
      try {
        await tab(fixture.alpha).click();
        await eventually(() => delayed, "The slow repository request was not intercepted");
        const betaResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/repo" && new URL(response.url()).searchParams.get("path") === fixture.beta);
        await tab(fixture.beta).click();
        await (await betaResponse).finished();
        await repoReady(fixture.beta);
        const lateResponse = page.waitForResponse((response) => matcher(new URL(response.url())));
        release.resolve();
        await (await lateResponse).finished();
        await page.waitForLoadState("networkidle");
        await repoReady(fixture.beta);
        await text("#accountButtonLabel", "Secondary Author");
      } finally {
        release.resolve();
        await page.unroute(matcher, handler);
      }
    });

    await run("browser repository and folder preferences survive reload", async () => {
      await selectRepo(fixture.alpha);
      await openRepoDialog();
      await attribute("#pathBrowserList [data-browse-path]", "data-browse-path", fixture.beta).click();
      await text("#pathBrowserCurrent", fixture.beta);
      await page.locator("#closeRepoDialog").click();
      await page.reload();
      await repoReady(fixture.alpha);
      await openRepoDialog();
      await text("#pathBrowserCurrent", fixture.beta);
      await page.locator("#closeRepoDialog").click();
    });

    await run("minimum window width keeps workspace and dialogs usable", async () => {
      await page.setViewportSize({ width: 960, height: 640 });
      await eventually(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Workspace overflows the minimum supported width");
      await openRepoDialog();
      const box = await page.locator("#addRepoButton").boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 961 && box.y >= 0 && box.y + box.height <= 641, "Repository action is clipped at minimum size");
      await eventually(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Repository dialog overflows the minimum supported width");
      await page.locator("#closeRepoDialog").click();
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await run("late refresh snapshot cannot undo a branch action", async () => {
      await withDelayedSnapshot(async () => {
        await page.locator("#branchButton").click();
        await page.locator("#newBranchName").fill("feature/ui-response-safety");
        await page.locator("#createBranchButton").click();
        await text("#actionDialogTitle", "Branch created");
        await text("#branchPill", "feature/ui-response-safety");
        await page.locator("#actionDialogConfirm").click();
      }, async () => {
        // Assert immediately after delivery; a later poll must not hide a stale overwrite.
        assert.equal(await page.locator("#branchPill").textContent(), "feature/ui-response-safety");
        assert.equal(fixture.git(fixture.alpha, "branch", "--show-current"), "feature/ui-response-safety");
      });
    });

    await run("late refresh snapshot cannot undo a stash action", async () => {
      await withDelayedSnapshot(async () => {
        await page.locator("#stashMessage").fill("UI delayed snapshot fixture");
        await page.locator("#stashUntracked").check();
        await page.locator("#stashButton").click();
        await text("#actionDialogTitle", "Changes stashed");
        await text("#changePill", "0 changes");
        await text("#stashNavCount", "1");
        await page.locator("#actionDialogConfirm").click();
      }, async () => {
        assert.equal(await page.locator("#changePill").textContent(), "0 changes");
        assert.equal(await page.locator("#stashNavCount").textContent(), "1");
        assert.equal(fixture.git(fixture.alpha, "status", "--porcelain"), "");
        assert.match(fixture.git(fixture.alpha, "stash", "list"), /UI delayed snapshot fixture/);
      });
    });

    await run("no uncaught JavaScript errors or failed app resources", async () => {
      assert.deepEqual(pageErrors, []);
      const unexpectedResponses = failedResponses.filter((response) => !expectedResponses.has(response)).map((response) => `${response.status()} ${response.url()}`);
      assert.deepEqual(unexpectedResponses, []);
      // Chromium logs an expected HTTP 400 for the invalid-repository test above.
      assert.deepEqual(consoleErrors.filter((message) => !/^Failed to load resource: the server responded with a status of 400\b/.test(message)), []);
    });
    success = true;
    await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify({ ok: true, passed, platform: process.platform, node: process.version }, null, 2));
    console.log(`ForkDeck UI: ${passed} checks passed (isolated Chromium, Git repositories, and local bare remotes).`);
  } catch (error) {
    let dom = {};
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, "ui-failure.png"), fullPage: true, timeout: 5000 }).catch(() => {});
      await fs.writeFile(path.join(artifacts, "ui-failure.html"), await page.content()).catch(() => {});
      dom = await page.evaluate(() => ({
        title: document.title, ready: document.body.dataset.ready, busy: document.body.getAttribute("aria-busy"),
        shellInert: document.querySelector(".shell")?.inert, viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth },
        text: Object.fromEntries(["repoName", "commitDetailTitle", "commitPatch", "fileList", "toast", "branchPill", "actionDialogTitle", "accountButtonLabel"].map((id) => [id, document.getElementById(id)?.textContent?.slice(0, 20000)]))
      })).catch((failure) => ({ captureError: failure.message }));
    }
    await Promise.race([Promise.allSettled([...responseBodies]), new Promise((resolve) => setTimeout(resolve, 2000))]);
    const diagnostics = { ok: false, current, passed, error: error.stack, platform: process.platform, node: process.version, fixture: fixture.scratch,
      dom, pageErrors, consoleErrors, failedRequests,
      failedResponses: failedResponses.map((response) => ({ method: response.request().method(), url: response.url(), status: response.status(), expected: expectedResponses.has(response) })),
      apiHistory, server: server?.diagnostics() };
    await fs.writeFile(path.join(artifacts, "diagnostics.json"), JSON.stringify(diagnostics, null, 2)).catch(() => {});
    if (context) await context.tracing.stop({ path: path.join(artifacts, "trace.zip") }).catch(() => {});
    console.error(`ForkDeck UI failed: ${current}`);
    console.error(JSON.stringify(diagnostics, null, 2));
    console.error(`Artifacts: ${artifacts}\nIsolated fixture: ${fixture.scratch}`);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    if (success && !process.argv.includes("--keep")) await fixture.cleanup();
    else if (success) console.log(`Artifacts: ${fixture.scratch}`);
  }
}

// Node's unit-test autodiscovery can match this filename. Browser checks run only
// through their explicit command, so ordinary unit tests do not launch Chromium.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { main };
