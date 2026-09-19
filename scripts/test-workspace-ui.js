// Real browser checks for the staging, commit, comparison and history workspace.
// All Git setup and assertions use disposable repositories and isolated settings.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createFixtures, startServer } = require("./test-ui-fixtures");

async function eventually(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof description === "function" ? description() : description, lastError ? { cause: lastError } : undefined);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const { chromium } = require("playwright");
  const root = path.resolve(__dirname, "..");
  const artifacts = path.join(root, "output", "workspace-ui-checks");
  await fs.mkdir(artifacts, { recursive: true });
  await Promise.all(["failure.png", "failure.html", "diagnostics.json", "trace.zip", "result.json"].map((name) => fs.rm(path.join(artifacts, name), { force: true })));
  const fixture = createFixtures();
  const { git, write } = fixture;
  let server, browser, context, page;
  let current = "setup";
  let passed = 0;
  let success = false;
  const pageErrors = [], consoleErrors = [], apiHistory = [], failedResponses = [], failedRequests = [];
  const expectedResponses = new Set();
  const run = async (name, task) => {
    current = name;
    console.log(`Workspace UI: ${name}`);
    await task();
    passed++;
  };
  try {
    async function conflictRepository(name) {
      const repo = path.join(fixture.scratch, name);
      await fs.mkdir(repo);
      git(repo, "init", "--initial-branch=main");
      git(repo, "config", "user.name", "Workspace Tester");
      git(repo, "config", "user.email", "workspace@example.invalid");
      git(repo, "config", "core.autocrlf", "false");
      write(repo, "conflict.txt", "base line\n");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "Conflict base");
      git(repo, "checkout", "-b", "topic");
      write(repo, "conflict.txt", "topic line\n");
      git(repo, "commit", "-am", "Topic conflict change");
      const topic = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "main");
      write(repo, "conflict.txt", "main line\n");
      git(repo, "commit", "-am", "Main conflict change");
      return { path: repo, head: git(repo, "rev-parse", "HEAD"), topic };
    }
    const mergeFixture = await conflictRepository("merge workspace");
    const rebaseFixture = await conflictRepository("rebase workspace");
    git(fixture.beta, "checkout", "-b", "topic");
    write(fixture.beta, "feature.txt", "Cherry-pick this feature\n");
    git(fixture.beta, "add", ".");
    git(fixture.beta, "commit", "-m", "Feature for cherry-pick");
    const topicHash = git(fixture.beta, "rev-parse", "HEAD");
    git(fixture.beta, "checkout", "main");
    write(fixture.beta, "main-extra.txt", "Keep this main branch work\n");
    git(fixture.beta, "add", ".");
    git(fixture.beta, "commit", "-m", "Main-only commit");
    git(fixture.beta, "branch", "merged-old");
    git(fixture.alpha, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    server = await startServer(root, fixture);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.addInitScript((scratch) => {
      if (!localStorage.getItem("browserPath")) localStorage.setItem("browserPath", scratch);
    }, fixture.scratch);
    await context.route(/^https:\/\//, async (route) => {
      if (route.request().resourceType() === "image") await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="11" fill="#1b9088"/></svg>' });
      else await route.abort();
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
      if (apiHistory.length > 80) apiHistory.shift();
      if (response.status() >= 400) response.text().then((body) => { record.body = body.slice(0, 8000); }).catch(() => {});
    });
    const text = (selector, expected) => {
      let actual;
      return eventually(async () => {
        actual = await page.locator(selector).textContent();
        return expected instanceof RegExp ? expected.test(actual || "") : actual === expected;
      }, () => `${selector} did not show ${expected}; got ${JSON.stringify(actual?.slice(0, 4000))}`);
    };
    const attribute = (scope, name, value) => page.locator(`${scope}[${name}=${JSON.stringify(value)}]`);
    const responseFor = (route, method = "POST") => page.waitForResponse((response) => new URL(response.url()).pathname === route && response.request().method() === method);
    const tab = (repo) => attribute("#repoTabs .repo-tab", "data-repo-path", repo);
    const repoReady = async (repo) => {
      await text("#repoName", path.basename(repo));
      await eventually(async () => (await tab(repo).getAttribute("class"))?.includes("is-current"), "Incorrect active repository tab");
    };
    const selectRepo = async (repo) => { await tab(repo).click(); await repoReady(repo); };
    const addRepo = async (repo) => {
      const browse = responseFor("/api/fs", "GET");
      await page.locator("#newRepoTabButton").click();
      const result = await (await browse).json();
      await eventually(async () => await page.locator("#localPathInput").inputValue() === result.path, "Repository browser did not finish loading");
      await page.locator("#localPathInput").fill(repo);
      const response = responseFor("/api/repos");
      await page.locator("#addRepoButton").click();
      assert.equal((await response).status(), 200);
      await repoReady(repo);
      await page.locator("#repoDialog").waitFor({ state: "hidden" });
    };
    const refresh = async () => {
      const response = responseFor("/api/repo", "GET");
      await page.locator("#refreshButton").click();
      assert.equal((await response).status(), 200);
      await page.waitForLoadState("networkidle");
    };
    const dismissResult = async (mode = "success") => {
      await page.locator(`#actionDialog[data-mode="${mode}"]`).waitFor({ state: "visible" });
      await page.locator("#actionDialogConfirm").click();
      await page.locator("#actionDialog").waitFor({ state: "hidden" });
    };
    const confirmRequest = async (route, status = 200) => {
      await page.locator('#actionDialog[data-mode="confirm"]').waitFor({ state: "visible" });
      const response = responseFor(route);
      await page.locator("#actionDialogConfirm").click();
      const result = await response;
      if (status >= 400) expectedResponses.add(result);
      assert.equal(result.status(), status, await result.text());
      return result.json();
    };
    const stage = async (action, file) => {
      const button = file === undefined ? page.locator(`[data-stage-all="${action}"]`)
        : attribute(`[data-stage-action="${action}"]`, "data-stage-file", file);
      const response = responseFor(`/api/repo/${action}`);
      await button.click();
      const result = await response;
      assert.equal(result.status(), 200, await result.text());
      await eventually(() => page.locator("#amendCommit").isEnabled(), "Stage action did not settle");
      return result.json();
    };
    const staged = (repo) => git(repo, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean).sort();
    const integration = async (action, ref, status = 200) => {
      await page.locator(`#${action}Button`).click();
      await page.locator("#actionDialogInput").fill(ref);
      return confirmRequest("/api/repo/integrate", status);
    };
    const branchAction = async (action, branch) => {
      const button = attribute(`[data-branch-action="${action}"]`, "data-branch", branch);
      await page.locator(".branch-item").filter({ has: button }).hover();
      await button.click();
    };
    const resolveIncoming = async () => {
      await attribute("#fileList [data-file]", "data-file", "conflict.txt").click();
      await page.locator('#commitFiles [data-conflict-resolve="theirs"]').waitFor({ state: "visible" });
      await page.locator('#commitFiles [data-conflict-resolve="theirs"]').click();
      await confirmRequest("/api/repo/conflict/resolve");
      await dismissResult();
      await eventually(() => page.locator("#continueOperationButton").isEnabled(), "Continue remained disabled after resolving conflicts");
    };
    const continueOperation = async () => {
      const response = responseFor("/api/repo/operation");
      await page.locator("#continueOperationButton").focus();
      await page.keyboard.press("Enter");
      const result = await response;
      assert.equal(result.status(), 200, await result.text());
      await dismissResult();
      await page.locator("#operationBanner").waitFor({ state: "hidden" });
    };
    const abortOperation = async () => {
      await page.locator("#abortOperationButton").click();
      await confirmRequest("/api/repo/operation");
      await dismissResult();
      await page.locator("#operationBanner").waitFor({ state: "hidden" });
    };

    await page.goto(server.origin, { waitUntil: "domcontentloaded" });
    await eventually(() => page.locator("body").getAttribute("data-ready").then((value) => value === "true"), "App startup did not finish");
    await run("late folder listing cannot overwrite a repository path the user typed", async () => {
      const release = deferred();
      let captured = false;
      const matcher = (url) => url.pathname === "/api/fs";
      const handler = async (route) => {
        if (captured) return route.continue();
        const response = await route.fetch();
        const body = await response.body();
        captured = true;
        await release.promise;
        await route.fulfill({ response, body });
      };
      await page.route(matcher, handler);
      try {
        await page.locator("#newRepoTabButton").click();
        await eventually(() => captured, "The folder listing was not intercepted");
        await page.locator("#localPathInput").fill(fixture.alpha);
        const response = responseFor("/api/fs", "GET");
        release.resolve();
        await (await response).finished();
        await page.waitForLoadState("networkidle");
        assert.equal(await page.locator("#localPathInput").inputValue(), fixture.alpha);
        await page.locator("#closeRepoDialog").click();
      } finally {
        release.resolve();
        await page.unroute(matcher, handler);
      }
    });
    await addRepo(fixture.alpha);

    await run("symbolic remote HEAD and detached HEAD never appear as checkout branches", async () => {
      const verifyBranches = async () => {
        assert.equal(await page.locator('[data-graph-branch="origin/HEAD"]').count(), 0);
        assert.equal(await page.locator('[data-checkout="origin/HEAD"]').count(), 0);
        assert.equal(await page.locator('[data-graph-branch="HEAD"]').count(), 0);
        assert.equal(await page.locator('[data-checkout="HEAD"]').count(), 0);
        assert.ok(await page.locator('[data-graph-branch="origin/main"]').count(), "Ordinary remote branch must remain on the graph");
        assert.ok(await page.locator('[data-checkout="origin/main"]').count(), "Ordinary remote branch must remain in the sidebar");
      };
      await verifyBranches();
      git(fixture.alpha, "checkout", "--detach", "HEAD");
      await refresh();
      await text("#branchPill", "detached");
      await verifyBranches();
      git(fixture.alpha, "checkout", "main");
      await refresh();
      await text("#branchPill", "main");
    });

    await run("stage and unstage individual files and all files", async () => {
      assert.deepEqual(staged(fixture.alpha), ["src/message.txt"]);
      assert.equal(await attribute('[data-stage-action="stage"]', "data-stage-file", "src/message.txt").count(), 1);
      assert.equal(await attribute('[data-stage-action="unstage"]', "data-stage-file", "src/message.txt").count(), 1);
      await stage("unstage", "src/message.txt");
      assert.deepEqual(staged(fixture.alpha), []);
      assert.match(await fs.readFile(path.join(fixture.alpha, "src/message.txt"), "utf8"), /value = working/);
      await stage("stage", "notes/café draft.txt");
      assert.deepEqual(staged(fixture.alpha), ["notes/café draft.txt"]);
      await stage("unstage");
      assert.deepEqual(staged(fixture.alpha), []);
      await stage("stage");
      assert.deepEqual(staged(fixture.alpha), ["notes/café draft.txt", "src/message.txt"]);
      await stage("unstage", "notes/café draft.txt");
      assert.deepEqual(staged(fixture.alpha), ["src/message.txt"]);
      await text("#stagedSummary", "1 staged");
    });

    await run("staging completion preserves a newer graph selection and commit inspector", async () => {
      for (const inspector of [false, true]) {
        await page.locator("#changesButton").click();
        await attribute("#fileList [data-file]", "data-file", "src/message.txt").first().click();
        await text("#commitDetailTitle", "src/message.txt");
        await page.locator("#backToGraphButton").click();
        const releaseStage = deferred(), releaseCommit = deferred();
        let stageCaptured = false, commitCaptured = false;
        const action = inspector ? "unstage" : "stage";
        const commitEndpoint = inspector ? "/api/repo/commit" : "/api/repo/commit-files";
        const stageMatcher = (url) => url.pathname === `/api/repo/${action}`;
        const commitMatcher = (url) => url.pathname === commitEndpoint && url.searchParams.get("hash") === fixture.rootCommit;
        const stageHandler = async (route) => {
          const response = await route.fetch();
          const body = await response.body();
          stageCaptured = true;
          await releaseStage.promise;
          await route.fulfill({ response, body });
        };
        const commitHandler = async (route) => {
          const response = await route.fetch();
          const body = await response.body();
          commitCaptured = true;
          await releaseCommit.promise;
          await route.fulfill({ response, body });
        };
        await page.route(stageMatcher, stageHandler);
        await page.route(commitMatcher, commitHandler);
        try {
          await attribute(`[data-stage-action="${action}"]`, "data-stage-file", "notes/café draft.txt").click();
          await eventually(() => stageCaptured, "The index mutation was not intercepted");
          assert.equal(await page.locator("#mergeButton").isDisabled(), true);
          const commitRow = attribute("#commitGraph [data-commit]", "data-commit", fixture.rootCommit);
          if (inspector) {
            await commitRow.click({ button: "right" });
            await page.locator('[data-commit-action="explain"]').click();
          } else await commitRow.click();
          await eventually(() => commitCaptured, "The newer commit selection was not intercepted");
          const stageResponse = responseFor(`/api/repo/${action}`);
          releaseStage.resolve();
          await (await stageResponse).finished();
          await eventually(() => page.locator("#amendCommit").isEnabled(), "Index mutation did not settle");
          const commitResponse = responseFor(commitEndpoint, "GET");
          releaseCommit.resolve();
          await (await commitResponse).finished();
          await text("#filePanelEyebrow", "Commit");
          await attribute("#fileList [data-commit-file]", "data-commit-file", "README.md").waitFor({ state: "visible" });
          assert.doesNotMatch(await page.locator("#fileList").textContent(), /Loading changed files/);
          if (inspector) {
            await text("#commitDetailTitle", "Initial UI root commit");
            await text("#commitPatch", /Alpha UI fixture/);
            assert.equal(await page.locator("#inspectorView").isVisible(), true);
          }
        } finally {
          releaseStage.resolve(); releaseCommit.resolve();
          await page.unroute(stageMatcher, stageHandler);
          await page.unroute(commitMatcher, commitHandler);
        }
      }
      await page.locator("#changesButton").click();
      assert.deepEqual(staged(fixture.alpha), ["src/message.txt"]);
    });

    await run("pending amend prefill disables commit and cannot overwrite a cancelled draft", async () => {
      const release = deferred();
      let captured = false;
      const matcher = (url) => url.pathname === "/api/repo/commit-message";
      const handler = async (route) => {
        const response = await route.fetch();
        const body = await response.body();
        captured = true;
        await release.promise;
        await route.fulfill({ response, body });
      };
      await page.route(matcher, handler);
      try {
        await page.locator("#commitMessage").fill("Draft while amend loads");
        assert.equal(await page.locator("#commitButton").isEnabled(), true);
        await page.locator("#amendCommit").check();
        await eventually(() => captured, "The amend prefill was not intercepted");
        assert.equal(await page.locator("#commitButton").isDisabled(), true);
        await page.locator("#amendCommit").uncheck();
        await page.locator("#commitMessage").fill("Keep this newer draft");
        const response = responseFor("/api/repo/commit-message", "GET");
        release.resolve();
        await (await response).finished();
        await page.waitForLoadState("networkidle");
        assert.equal(await page.locator("#amendCommit").isChecked(), false);
        assert.equal(await page.locator("#commitMessage").inputValue(), "Keep this newer draft");
        assert.equal(await page.locator("#commitButton").isEnabled(), true);
        assert.doesNotMatch(await page.locator("#commitButton").textContent(), /Amend/);
        await page.locator("#commitMessage").fill("");
      } finally {
        release.resolve();
        await page.unroute(matcher, handler);
      }
    });

    await run("commit composer records only the reviewed staged content", async () => {
      write(fixture.alpha, "src/message.txt", "Stable heading\nvalue = keep unstaged\n");
      await refresh();
      assert.equal(await page.locator("#commitButton").isDisabled(), true);
      await page.locator("#commitMessage").fill("Workspace staged commit\n\nKeep the later working edit.");
      const response = responseFor("/api/repo/commit");
      await page.locator("#commitButton").click();
      assert.equal((await response).status(), 200);
      await dismissResult();
      assert.match(git(fixture.alpha, "show", "HEAD:src/message.txt"), /value = working/);
      assert.match(await fs.readFile(path.join(fixture.alpha, "src/message.txt"), "utf8"), /value = keep unstaged/);
      assert.match(await fs.readFile(path.join(fixture.alpha, "notes/café draft.txt"), "utf8"), /New untracked note/);
      assert.deepEqual(staged(fixture.alpha), []);
      assert.equal(await page.locator("#commitMessage").inputValue(), "");
      assert.equal(git(fixture.alpha, "config", "--global", "user.name"), "Global UI Fixture");
      assert.equal(git(fixture.alpha, "show", "-s", "--format=%an", "HEAD"), "Repository Original");
    });

    await run("amend prefills the message and requires confirmation before rewriting HEAD", async () => {
      const previous = git(fixture.alpha, "rev-parse", "HEAD");
      const prefill = responseFor("/api/repo/commit-message", "GET");
      await page.locator("#amendCommit").check();
      assert.equal((await prefill).status(), 200);
      await eventually(() => page.locator("#commitMessage").inputValue().then((value) => value.startsWith("Workspace staged commit")), "Amend did not prefill the current commit message");
      await page.locator("#commitMessage").fill("Amended workspace message");
      await page.locator("#commitButton").click();
      await text("#actionDialogTitle", "Amend the last commit?");
      await page.locator("#actionDialogCancel").click();
      assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), previous);
      assert.equal(await page.locator("#commitMessage").inputValue(), "Amended workspace message");
      await page.locator("#commitButton").click();
      await confirmRequest("/api/repo/commit");
      await dismissResult();
      assert.notEqual(git(fixture.alpha, "rev-parse", "HEAD"), previous);
      assert.equal(git(fixture.alpha, "show", "-s", "--format=%s", "HEAD"), "Amended workspace message");
      assert.equal(git(fixture.alpha, "rev-list", "--count", "HEAD"), "3");
      assert.match(await fs.readFile(path.join(fixture.alpha, "src/message.txt"), "utf8"), /keep unstaged/);
      assert.equal(await page.locator("#amendCommit").isChecked(), false);
    });

    await run("commit drafts stay with their repository tabs", async () => {
      await page.locator("#commitMessage").fill("Alpha draft stays here");
      await addRepo(fixture.beta);
      assert.equal(await page.locator("#commitMessage").inputValue(), "");
      await page.locator("#commitMessage").fill("Beta has a different draft");
      await selectRepo(fixture.alpha);
      assert.equal(await page.locator("#commitMessage").inputValue(), "Alpha draft stays here");
      await selectRepo(fixture.beta);
      assert.equal(await page.locator("#commitMessage").inputValue(), "Beta has a different draft");
    });

    await run("history search matches messages, authors and hashes and displays no results", async () => {
      await selectRepo(fixture.alpha);
      await page.locator("#historySearch").fill("amended workspace");
      await eventually(() => page.locator("#commitGraph [data-commit]").count().then((count) => count === 1), "Message search did not narrow history");
      await text("#graphCount", "1 / 3 loaded");
      await page.locator("#historySearch").fill("there-is-no-such-commit-qa");
      await text("#graphCount", "0 / 3 loaded");
      assert.equal(await page.locator("#commitGraph [data-commit]").count(), 0);
      await text("#commitGraph", /No (?:commits )?match/i);
      await page.locator("#historySearch").fill("Repository Original");
      assert.equal(await page.locator("#commitGraph [data-commit]").count(), 3);
      await page.locator("#historySearch").fill(git(fixture.alpha, "rev-parse", "--short", "HEAD"));
      assert.equal(await page.locator("#commitGraph [data-commit]").count(), 1);
      await page.locator("#historySearch").fill("");
    });

    await run("comparison shows exact tree differences, validation errors and keyboard close", async () => {
      await selectRepo(fixture.beta);
      await page.locator("#compareButton").click();
      await page.locator("#compareBase").fill("main");
      await page.locator("#compareTarget").fill("topic");
      let response = responseFor("/api/repo/compare", "GET");
      await page.locator("#compareRunButton").click();
      assert.equal((await response).status(), 200);
      await text("#compareResult", /1 target-only \/ 1 base-only commits/);
      assert.match(await page.locator("#compareResult").textContent(), /feature\.txt[\s\S]*main-extra\.txt/);
      assert.match(await page.locator("#compareResult").textContent(), /Cherry-pick this feature/);
      await page.locator("#compareTarget").fill("missing-qa-reference");
      response = responseFor("/api/repo/compare", "GET");
      await page.locator("#compareRunButton").click();
      const rejected = await response;
      expectedResponses.add(rejected);
      assert.equal(rejected.status(), 400);
      await text("#compareResult", /revision|Needed a single revision|unknown|valid/i);
      await page.keyboard.press("Escape");
      await page.locator("#compareDialog").waitFor({ state: "hidden" });
      await page.locator("#compareButton").click();
      assert.equal(await page.locator("#compareBase").inputValue(), "HEAD");
      await page.locator("#compareCloseButton").click();
      await page.locator("#compareDialog").waitFor({ state: "hidden" });
    });

    await run("closing and reopening a pending comparison accepts new work and ignores the old result", async () => {
      const release = deferred();
      let captured = false;
      const matcher = (url) => url.pathname === "/api/repo/compare";
      const handler = async (route) => {
        if (captured) return route.continue();
        const response = await route.fetch();
        const body = await response.body();
        captured = true;
        await release.promise;
        await route.fulfill({ response, body });
      };
      await page.route(matcher, handler);
      try {
        await page.locator("#compareButton").click();
        await page.locator("#compareTarget").fill("topic");
        await page.locator("#compareRunButton").click();
        await eventually(() => captured, "The comparison was not intercepted");
        assert.equal(await page.locator("#compareRunButton").isDisabled(), true);
        await page.keyboard.press("Escape");
        await page.locator("#compareDialog").waitFor({ state: "hidden" });
        await page.locator("#compareButton").click();
        assert.equal(await page.locator("#compareRunButton").isEnabled(), true);
        await page.locator("#compareTarget").fill("HEAD");
        const currentResponse = page.waitForResponse((response) => matcher(new URL(response.url())) && new URL(response.url()).searchParams.get("target") === "HEAD");
        await page.locator("#compareRunButton").click();
        assert.equal((await currentResponse).status(), 200);
        await text("#compareResult", /The trees are identical/);
        const staleResponse = page.waitForResponse((response) => matcher(new URL(response.url())) && new URL(response.url()).searchParams.get("target") === "topic");
        release.resolve();
        await (await staleResponse).finished();
        await page.waitForLoadState("networkidle");
        assert.match(await page.locator("#compareResult").textContent(), /The trees are identical/);
        assert.doesNotMatch(await page.locator("#compareResult").textContent(), /Cherry-pick this feature/);
        assert.equal(await page.locator("#compareRunButton").isEnabled(), true);
        await page.locator("#compareCloseButton").click();
      } finally {
        release.resolve();
        await page.unroute(matcher, handler);
      }
    });

    await run("branch rename and safe delete protect current and unmerged branches", async () => {
      await branchAction("rename", "topic");
      await page.locator("#actionDialogInput").fill("feature/renamed");
      await confirmRequest("/api/repo/branch/rename");
      await dismissResult();
      assert.equal(git(fixture.beta, "rev-parse", "feature/renamed"), topicHash);
      assert.equal(await attribute('[data-branch-action="delete"]', "data-branch", "main").isDisabled(), true);
      await branchAction("delete", "merged-old");
      await confirmRequest("/api/repo/branch/delete");
      await dismissResult();
      assert.doesNotMatch(git(fixture.beta, "branch", "--format=%(refname:short)"), /merged-old/);
      await branchAction("delete", "feature/renamed");
      await confirmRequest("/api/repo/branch/delete", 400);
      await text("#actionDialogMessage", /not fully merged/i);
      await dismissResult("error");
      assert.equal(git(fixture.beta, "rev-parse", "feature/renamed"), topicHash);
    });

    await run("commit context menu cherry-picks and reverts without losing main branch work", async () => {
      await attribute("#commitGraph [data-commit]", "data-commit", topicHash).click({ button: "right" });
      await page.locator('[data-commit-action="cherry-pick"]').click();
      await confirmRequest("/api/repo/integrate");
      await dismissResult();
      const picked = git(fixture.beta, "rev-parse", "HEAD");
      assert.notEqual(picked, topicHash);
      assert.equal(git(fixture.beta, "show", "HEAD:feature.txt"), "Cherry-pick this feature");
      await attribute("#commitGraph [data-commit]", "data-commit", picked).click({ button: "right" });
      await page.locator('[data-commit-action="revert"]').click();
      await confirmRequest("/api/repo/integrate");
      await dismissResult();
      assert.equal(git(fixture.beta, "branch", "--show-current"), "main");
      assert.match(git(fixture.beta, "show", "-s", "--format=%s", "HEAD"), /^Revert/);
      await assert.rejects(fs.access(path.join(fixture.beta, "feature.txt")));
      assert.equal(await fs.readFile(path.join(fixture.beta, "main-extra.txt"), "utf8"), "Keep this main branch work\n");
      assert.equal(git(fixture.beta, "status", "--porcelain"), "");
    });

    await run("merge conflict banner resolves a file and supports keyboard Continue", async () => {
      await addRepo(mergeFixture.path);
      const result = await integration("merge", "topic");
      assert.equal(result.outcome.status, "conflicts");
      await text("#operationTitle", "Merge in progress");
      await text("#operationDescription", /1 conflicted file/);
      assert.equal(await page.locator("#continueOperationButton").isDisabled(), true);
      assert.equal(await page.locator("#commitButton").isDisabled(), true);
      await resolveIncoming();
      await continueOperation();
      assert.equal(git(mergeFixture.path, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
      assert.equal(await fs.readFile(path.join(mergeFixture.path, "conflict.txt"), "utf8"), "topic line\n");
      assert.equal(git(mergeFixture.path, "status", "--porcelain"), "");
    });

    await run("merge Abort confirmation can be cancelled and restores the starting commit", async () => {
      git(mergeFixture.path, "reset", "--hard", mergeFixture.head);
      await refresh();
      await integration("merge", "topic");
      await page.locator("#operationBanner").waitFor({ state: "visible" });
      await page.locator("#abortOperationButton").click();
      await text("#actionDialogTitle", "Abort this operation?");
      await page.locator("#actionDialogCancel").click();
      assert.equal(await page.locator("#operationBanner").isVisible(), true);
      await abortOperation();
      assert.equal(git(mergeFixture.path, "rev-parse", "HEAD"), mergeFixture.head);
      assert.equal(await fs.readFile(path.join(mergeFixture.path, "conflict.txt"), "utf8"), "main line\n");
    });

    await run("rebase conflicts expose Abort and Continue and preserve the branch", async () => {
      await addRepo(rebaseFixture.path);
      let result = await integration("rebase", "topic");
      assert.equal(result.outcome.status, "conflicts");
      await text("#operationTitle", "Rebase in progress");
      assert.equal(await page.locator("#continueOperationButton").isDisabled(), true);
      await abortOperation();
      assert.equal(git(rebaseFixture.path, "rev-parse", "HEAD"), rebaseFixture.head);
      result = await integration("rebase", "topic");
      assert.equal(result.outcome.status, "conflicts");
      await resolveIncoming();
      await continueOperation();
      assert.equal(git(rebaseFixture.path, "branch", "--show-current"), "main");
      assert.equal(git(rebaseFixture.path, "rev-parse", "HEAD^"), rebaseFixture.topic);
      assert.notEqual(git(rebaseFixture.path, "rev-parse", "HEAD"), rebaseFixture.head);
      assert.equal(await fs.readFile(path.join(rebaseFixture.path, "conflict.txt"), "utf8"), "main line\n");
      assert.equal(git(rebaseFixture.path, "status", "--porcelain"), "");
    });

    await run("dirty history action displays its error and preserves the commit draft", async () => {
      await selectRepo(fixture.alpha);
      const hash = git(fixture.alpha, "rev-parse", "HEAD");
      await integration("merge", "HEAD", 409);
      await text("#actionDialogMessage", /Commit or stash your changes/);
      await dismissResult("error");
      assert.equal(await page.locator("#commitMessage").inputValue(), "Alpha draft stays here");
      assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), hash);
      assert.match(await fs.readFile(path.join(fixture.alpha, "src/message.txt"), "utf8"), /keep unstaged/);
    });

    await run("workspace controls remain reachable at minimum window size", async () => {
      await page.setViewportSize({ width: 960, height: 640 });
      await eventually(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Workspace exceeds minimum supported width");
      await page.locator("#commitMessage").fill("Small-window draft");
      const composer = await page.locator("#commitButton").boundingBox();
      assert.ok(composer && composer.x >= 0 && composer.x + composer.width <= 961 && composer.y >= 0 && composer.y + composer.height <= 641, "Commit action is clipped at minimum window size");
      await page.locator("#compareButton").click();
      const compare = await page.locator("#compareDialog").boundingBox();
      assert.ok(compare && compare.x >= 0 && compare.y >= 0 && compare.x + compare.width <= 961 && compare.y + compare.height <= 641, "Comparison dialog is clipped at minimum window size");
      await page.locator("#compareCloseButton").click();
    });

    await run("no uncaught errors or unexpected failed application responses", async () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(failedResponses.filter((response) => !expectedResponses.has(response)).map((response) => `${response.status()} ${response.url()}`), []);
      assert.deepEqual(consoleErrors.filter((message) => !/^Failed to load resource: the server responded with a status of (400|409)\b/.test(message)), []);
    });
    success = true;
    await context.tracing.stop();
    await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify({ ok: true, passed, platform: process.platform, node: process.version }, null, 2));
    console.log(`ForkDeck workspace UI: ${passed} checks passed with isolated Chromium and Git fixtures.`);
  } catch (error) {
    let dom = {};
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true, timeout: 5000 }).catch(() => {});
      await fs.writeFile(path.join(artifacts, "failure.html"), await page.content()).catch(() => {});
      dom = await page.evaluate(() => ({
        ready: document.body.dataset.ready, activeElement: document.activeElement?.id, viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth },
        text: Object.fromEntries(["repoName", "fileList", "commitHint", "toast", "branchPill", "actionDialogTitle", "actionDialogMessage", "operationTitle", "operationDescription", "compareResult"].map((id) => [id, document.getElementById(id)?.textContent?.slice(0, 12000)])),
        commitMessage: document.getElementById("commitMessage")?.value,
        actionMode: document.getElementById("actionDialog")?.dataset.mode
      })).catch((failure) => ({ error: failure.message }));
    }
    const diagnostics = { ok: false, current, passed, error: error.stack, platform: process.platform, node: process.version, fixture: fixture.scratch,
      dom, pageErrors, consoleErrors, failedRequests, apiHistory, server: server?.diagnostics(),
      failedResponses: failedResponses.map((response) => ({ url: response.url(), status: response.status(), expected: expectedResponses.has(response) })) };
    await fs.writeFile(path.join(artifacts, "diagnostics.json"), JSON.stringify(diagnostics, null, 2)).catch(() => {});
    if (context) await context.tracing.stop({ path: path.join(artifacts, "trace.zip") }).catch(() => {});
    console.error(`ForkDeck workspace UI failed: ${current}\n${error.stack}\nArtifacts: ${artifacts}\nFixture: ${fixture.scratch}`);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    if (success && !process.argv.includes("--keep")) await fixture.cleanup();
  }
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { main };
