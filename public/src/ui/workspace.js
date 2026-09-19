import { request } from "../services/api.js";
import { escapeHtml, highlightDiff } from "../utils/format.js";

export function createWorkspace({ state, $, iconRefresh, showToast, confirmAction, promptAction, runActionDialog, closeActionDialog, applyRepoSnapshot, loadDiff, showChanges, renderFiles }) {
  const drafts = new Map();
  let draftPath = "";
  let amendHead = "";
  let amendLoading = false;
  let amendVersion = 0;
  let compareVersion = 0;
  let comparePath = "";
  const labels = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert" };
  const isConflict = (file) => file.label === "Conflicted" || file.index === "U" || file.worktree === "U" || ["AA", "DD"].includes(file.index + file.worktree);
  const stagedFiles = () => (state.repo?.files || []).filter((file) => !isConflict(file) && ![" ", "?"].includes(file.index));

  function saveDraft() {
    if (draftPath) drafts.set(draftPath, { message: $("#commitMessage").value, amend: $("#amendCommit").checked && Boolean(amendHead), head: amendHead });
  }

  function render() {
    if (draftPath !== state.repoPath) {
      saveDraft();
      amendVersion++;
      amendLoading = false;
      draftPath = state.repoPath;
      const draft = drafts.get(draftPath);
      $("#commitMessage").value = draft?.message || "";
      $("#amendCommit").checked = Boolean(draft?.amend);
      amendHead = draft?.head || "";
    }
    const repo = state.repo;
    const operation = repo?.operation;
    const staged = stagedFiles().length;
    const conflicts = repo?.files.some(isConflict);
    $("#commitComposer").hidden = !repo || state.centerMode === "commit";
    $("#amendCommit").disabled = !repo?.head || Boolean(operation) || state.repoActionInFlight;
    $("#commitButton").disabled = !repo || Boolean(operation) || conflicts || state.repoActionInFlight || amendLoading || ($("#amendCommit").checked && !amendHead) || !$("#commitMessage").value.trim() || (!staged && !$("#amendCommit").checked);
    $("#commitButton").innerHTML = `<i data-lucide="git-commit-horizontal"></i>${$("#amendCommit").checked ? "Amend last commit" : `Commit ${staged || "staged"} ${staged === 1 ? "file" : "files"}`}`;
    $("#stagedSummary").textContent = `${staged} staged`;
    $("#commitHint").textContent = operation ? "Finish or abort the operation above before committing." : conflicts ? "Resolve conflicts before committing." : $("#amendCommit").checked ? "Amend rewrites the last commit. Use it for unpublished work." : "⌘ / Ctrl + Enter to commit staged changes";
    $("#operationBanner").hidden = !operation;
    if (operation) {
      $("#operationTitle").textContent = `${labels[operation.type] || operation.type} in progress`;
      $("#operationDescription").textContent = operation.message || (operation.conflicts ? `${operation.conflicts} conflicted file${operation.conflicts === 1 ? "" : "s"}. Select each file to resolve it, then continue.` : "Review the staged result, then continue or abort to return to the starting state.");
      $("#continueOperationButton").disabled = !operation.canContinue || state.repoActionInFlight;
    }
    for (const id of ["mergeButton", "rebaseButton"]) $("#" + id).disabled = !repo?.head || Boolean(operation) || state.repoActionInFlight;
    $("#abortOperationButton").disabled = state.repoActionInFlight;
    for (const id of ["stashButton", "stashQuickButton", "popQuickButton", "createBranchButton", "pullButton", "pushButton"]) {
      $("#" + id).disabled = !repo || Boolean(operation) || state.repoActionInFlight;
    }
    $("#compareButton").disabled = !repo?.head;
    iconRefresh();
  }

  async function stage(file, unstage = false) {
    if (state.repoActionInFlight || !state.repo) return;
    const path = state.repoPath;
    state.repoActionInFlight = true;
    state.repoMutationVersion++;
    renderFiles();
    try {
      const payload = await request(`/api/repo/${unstage ? "unstage" : "stage"}`, { method: "POST", body: JSON.stringify({ path, ...(file === undefined ? {} : { file }) }) });
      if (state.repoPath !== path) return;
      applyRepoSnapshot(payload.repo, { source: "action", invalidateInspector: false });
      if (state.centerMode === "worktree" && state.selectedFile && state.inspectorOpen) await loadDiff(state.selectedFile);
      showToast(unstage ? "Changes unstaged." : "Changes staged.", "success");
    } catch (error) { showToast(error.message); }
    finally { state.repoActionInFlight = false; state.repoMutationVersion++; renderFiles(); }
  }

  async function commit() {
    if ($("#commitButton").disabled || state.repoActionInFlight) return;
    const path = state.repoPath;
    const message = $("#commitMessage").value;
    const amend = $("#amendCommit").checked;
    const expectedHead = amend ? amendHead : state.repo.head;
    if (amend && !await confirmAction({ title: "Amend the last commit?", message: "This replaces the last commit on the current branch, including its message and any staged changes. Use amend only for work you have not shared.", confirmLabel: "Amend commit", icon: "git-commit-horizontal" })) return;
    const payload = await runActionDialog({ runningTitle: amend ? "Amending commit…" : "Creating commit…", successTitle: "Commit saved", icon: "git-commit-horizontal", task: () => request("/api/repo/commit", { method: "POST", body: JSON.stringify({ path, message, amend, expectedHead }) }) });
    if (!payload || state.repoPath !== path) return;
    $("#commitMessage").value = "";
    $("#amendCommit").checked = false;
    amendHead = "";
    saveDraft();
    state.centerMode = "worktree";
    state.inspectorOpen = false;
    applyRepoSnapshot(payload.repo, { source: "action" });
  }

  async function integrate(action, ref) {
    if (!state.repo?.head) return showToast("Open a repository with commits first.");
    const path = state.repoPath;
    const branch = state.repo.branch;
    const description = action === "rebase" ? `Replay commits from ${branch} onto the target. This rewrites the current branch's commits; use it for unpublished work.` : action === "revert" ? "Create a new commit that reverses the selected commit. Your existing history is preserved." : action === "cherry-pick" ? `Apply the selected commit as a new commit on ${branch}.` : `Merge the target into ${branch}. A clean working tree is required.`;
    if (!ref) ref = await promptAction({ title: `${labels[action]} into ${branch}`, message: description, inputLabel: "Branch, tag or commit", inputValue: state.repo.branches.find((b) => !b.current)?.name || "", inputPlaceholder: "feature/branch", confirmLabel: labels[action], icon: "git-merge" });
    else if (!await confirmAction({ title: `${labels[action]} ${ref.slice(0, 12)}?`, message: description, confirmLabel: labels[action], icon: "git-merge" })) return;
    if (!ref) return;
    await historyAction("/api/repo/integrate", { path, action, ref }, `${labels[action]} complete`);
  }

  async function historyAction(endpoint, body, title) {
    const payload = await runActionDialog({ runningTitle: "Updating repository…", successTitle: title, icon: "git-merge", task: () => request(endpoint, { method: "POST", body: JSON.stringify(body) }) });
    if (!payload || state.repoPath !== body.path) return;
    state.centerMode = "worktree";
    state.inspectorOpen = false;
    applyRepoSnapshot(payload.repo || payload, { source: "action" });
    if (payload.outcome && payload.outcome.status !== "completed") {
      closeActionDialog();
      showToast(payload.outcome.message || "Resolve the conflicts, then continue the operation.");
    }
  }

  async function operation(action) {
    const path = state.repoPath;
    if (!state.repo?.operation) return;
    if (action === "abort" && !await confirmAction({ title: "Abort this operation?", message: "Return to the state before this operation. Conflict resolution edits made during the operation will be removed.", confirmLabel: "Abort operation", danger: true })) return;
    await historyAction("/api/repo/operation", { path, action }, action === "abort" ? "Operation aborted" : "Operation continued");
  }

  async function branchAction(action, branch) {
    const path = state.repoPath;
    if (action === "merge" || action === "rebase") return integrate(action, branch);
    if (action === "compare") return openCompare(branch);
    let name;
    if (action === "rename") {
      name = await promptAction({ title: `Rename ${branch}`, message: "Rename this local branch. Remote branch names are unchanged.", inputLabel: "New branch name", inputValue: branch, confirmLabel: "Rename" });
      if (!name || name === branch) return;
    } else if (!await confirmAction({ title: `Delete ${branch}?`, message: "Delete this local branch only if Git considers it fully merged. The current branch cannot be deleted.", confirmLabel: "Delete branch", danger: true })) return;
    await historyAction(`/api/repo/branch/${action}`, { path, branch, name }, action === "rename" ? "Branch renamed" : "Branch deleted");
  }

  function openCompare(target = "") {
    if (!state.repo?.head) return showToast("Open a repository with commits first.");
    compareVersion++;
    comparePath = state.repoPath;
    const refs = ["HEAD", ...state.repo.branches.map((b) => b.name), ...state.repo.remoteBranches, ...(state.repo.tags || []).map((t) => t.name)];
    $("#compareRefs").innerHTML = refs.map((ref) => `<option value="${escapeHtml(ref)}"></option>`).join("");
    $("#compareBase").value = "HEAD";
    $("#compareTarget").value = target || state.repo.branches.find((b) => !b.current)?.name || "HEAD";
    $("#compareResult").textContent = "Choose two references to see their differences.";
    $("#compareRunButton").disabled = false;
    $("#compareDialog").showModal();
    $("#compareTarget").focus();
  }

  async function compare(event) {
    event.preventDefault();
    const version = ++compareVersion;
    const button = $("#compareRunButton");
    button.disabled = true;
    $("#compareResult").textContent = "Comparing…";
    try {
      const query = new URLSearchParams({ path: comparePath, base: $("#compareBase").value, target: $("#compareTarget").value });
      const payload = await request(`/api/repo/compare?${query}`);
      if (version !== compareVersion) return;
      $("#compareResult").innerHTML = `<p class="compare-summary">${escapeHtml(payload.summary || "No file changes.")} · ${payload.ahead} target-only / ${payload.behind} base-only commits</p><div class="compare-files">${payload.files.map((file) => `<div><span class="count-pill">${escapeHtml(file.status)}</span> ${escapeHtml(file.file)}</div>`).join("")}</div>${payload.truncated ? '<p class="muted">Large diff truncated. Use Git locally to inspect the full patch.</p>' : ""}<pre class="diff-code"><code>${highlightDiff(payload.patch || "The trees are identical.")}</code></pre>`;
    } catch (error) { if (version === compareVersion) $("#compareResult").textContent = error.message; }
    finally { if (version === compareVersion) button.disabled = false; }
  }

  function bind() {
    $("#commitComposer").addEventListener("submit", (event) => { event.preventDefault(); commit().catch((e) => showToast(e.message)); });
    $("#commitMessage").addEventListener("input", () => { saveDraft(); render(); });
    $("#amendCommit").addEventListener("change", async () => {
      const path = state.repoPath;
      const version = ++amendVersion;
      amendHead = "";
      amendLoading = $("#amendCommit").checked;
      render();
      if ($("#amendCommit").checked) {
        try {
          const payload = await request(`/api/repo/commit-message?path=${encodeURIComponent(path)}`);
          if (version !== amendVersion || path !== state.repoPath || !$("#amendCommit").checked) return;
          amendHead = payload.hash;
          if (!$("#commitMessage").value.trim()) $("#commitMessage").value = payload.message;
        } catch (error) { if (version === amendVersion && path === state.repoPath) { $("#amendCommit").checked = false; showToast(error.message); } }
      }
      if (version !== amendVersion || path !== state.repoPath) return;
      amendLoading = false;
      saveDraft(); render();
    });
    $("#changesButton").addEventListener("click", showChanges);
    $("#mergeButton").addEventListener("click", () => integrate("merge").catch((e) => showToast(e.message)));
    $("#rebaseButton").addEventListener("click", () => integrate("rebase").catch((e) => showToast(e.message)));
    for (const action of ["continue", "abort"]) $("#" + action + "OperationButton").addEventListener("click", () => operation(action).catch((e) => showToast(e.message)));
    $("#compareButton").addEventListener("click", () => openCompare());
    $("#compareCloseButton").addEventListener("click", () => $("#compareDialog").close());
    $("#compareDialog").addEventListener("close", () => { compareVersion++; });
    $("#compareForm").addEventListener("submit", compare);
    document.addEventListener("keydown", (event) => {
      if (!(event.metaKey || event.ctrlKey) || state.actionDialogResolve || !$("#actionDialog").hidden || $("#compareDialog").open) return;
      if (event.key === "Enter" && event.target.closest("#commitComposer")) { event.preventDefault(); commit().catch((e) => showToast(e.message)); }
      if (event.key === "f" && !event.target.closest("input, textarea")) { event.preventDefault(); $("#historySearch").focus(); }
    });
  }
  return { render, bind, stage, integrate, branchAction, openCompare, isConflict };
}
