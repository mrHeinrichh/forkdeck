const state = {
  profiles: [],
  repos: [],
  selectedId: "",
  activeIdentity: "",
  repoPath: localStorage.getItem("repoPath") || "",
  repo: null,
  selectedFile: "",
  selectedCommit: "",
  selectedCommitFiles: [],
  selectedCommitFile: "",
  browserPath: localStorage.getItem("browserPath") || "/Users/heinric",
  browserTarget: "local",
  inspectorOpen: false,
  centerMode: "graph",
  repoPollTimer: null,
  repoRefreshInFlight: false,
  repoActionInFlight: false,
  lastRepoSignature: "",
  selectedCommitPatch: "",
  selectedCommitPatchHash: "",
  actionDialogResolve: null,
  actionDialogAutoClose: null
};

const $ = (selector) => document.querySelector(selector);
const accountMenuProfiles = $("#accountMenuProfiles");
const repoList = $("#repoList");
const repoTabs = $("#repoTabs");
const form = $("#profileForm");
const toast = $("#toast");
const commitContextMenu = $("#commitContextMenu");
const graphColors = ["#00c2ff", "#f97316", "#22c55e", "#a855f7", "#f43f5e", "#eab308", "#14b8a6", "#60a5fa"];
const GRAPH_LANE_WIDTH = 36;
const GRAPH_ROW_HEIGHT = 52;
const STASH_NODE_ANCHOR_Y = 14;
const REPO_LIVE_SYNC_MS = 3200;
let contextMenuScrollGuardUntil = 0;

function iconRefresh() {
  if (window.lucide) window.lucide.createIcons();
}

function showToast(message, tone = "") {
  toast.textContent = message;
  toast.classList.toggle("is-success", tone === "success");
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove("is-visible", "is-success");
  }, 2800);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

function setLiveSyncStatus(message = "Live local sync", mode = "idle") {
  const status = $("#liveSyncStatus");
  if (!status) return;
  status.classList.toggle("is-syncing", mode === "syncing");
  status.classList.toggle("is-updated", mode === "updated");
  status.innerHTML = `<i data-lucide="${mode === "syncing" ? "refresh-cw" : mode === "updated" ? "badge-check" : "activity"}"></i>${escapeHtml(message)}`;
  iconRefresh();
  if (mode === "updated") {
    clearTimeout(setLiveSyncStatus.timer);
    setLiveSyncStatus.timer = setTimeout(() => setLiveSyncStatus("Live local sync", "idle"), 1800);
  }
}

function repoSignature(repo) {
  if (!repo) return "";
  return JSON.stringify({
    root: repo.root,
    branch: repo.branch,
    ahead: repo.ahead,
    behind: repo.behind,
    head: repo.commits?.[0]?.hash || "",
    refs: (repo.commits || []).map((commit) => `${commit.hash}:${commit.refs}`).join("|"),
    files: (repo.files || []).map((file) => `${file.index}${file.worktree}:${file.file}:${file.label}`).join("|"),
    branches: (repo.branches || []).map((branch) => `${branch.name}:${branch.current}:${branch.upstream}`).join("|"),
    remoteBranches: (repo.remoteBranches || []).join("|"),
    stashes: (repo.stashes || []).map((stash) => `${stash.ref}:${stash.hash}:${stash.subject}`).join("|")
  });
}

function renderRepoPreservingGraph() {
  const graph = $("#commitGraph");
  const scrollTop = graph?.scrollTop || 0;
  const scrollLeft = graph?.scrollLeft || 0;
  renderRepo();
  requestAnimationFrame(() => {
    const nextGraph = $("#commitGraph");
    if (!nextGraph) return;
    nextGraph.scrollTop = scrollTop;
    nextGraph.scrollLeft = scrollLeft;
  });
}

function applyRepoSnapshot(repo, { source = "manual", preserveGraph = true } = {}) {
  const previous = state.repo;
  const previousSignature = repoSignature(previous);
  const nextSignature = repoSignature(repo);
  const previousHead = previous?.commits?.[0]?.hash || "";
  const nextHead = repo?.commits?.[0]?.hash || "";

  state.repo = repo;
  state.repoPath = repo.root;
  state.lastRepoSignature = nextSignature;

  if (previousSignature && previousSignature === nextSignature) {
    setLiveSyncStatus("Live local sync", "idle");
    return false;
  }

  if (!repo.commits.some((commit) => commit.hash === state.selectedCommit)) {
    state.selectedCommit = repo.commits[0]?.hash || "";
    state.selectedCommitFiles = [];
    state.selectedCommitPatch = "";
    state.selectedCommitPatchHash = "";
  }

  if (preserveGraph) renderRepoPreservingGraph();
  else renderRepo();

  if (source === "poll") {
    const message = previousHead && nextHead && previousHead !== nextHead
      ? `New local commit: ${repo.commits[0]?.shortHash || "HEAD"}`
      : "Repository updated";
    setLiveSyncStatus(message, "updated");
    showToast(message, "success");
  }

  return true;
}

function stopRepoLiveSync() {
  if (state.repoPollTimer) clearInterval(state.repoPollTimer);
  state.repoPollTimer = null;
}

function startRepoLiveSync() {
  stopRepoLiveSync();
  if (!state.repoPath) return;
  setLiveSyncStatus("Live local sync", "idle");
  state.repoPollTimer = setInterval(() => {
    refreshRepo({ silent: true, source: "poll" }).catch(() => {});
  }, REPO_LIVE_SYNC_MS);
}

function setActionDialog(options = {}) {
  const mode = options.mode || "confirm";
  const dialog = $("#actionDialog");
  const panel = $("#actionDialogPanel");
  const icon = $("#actionDialogIcon");
  const output = $("#actionDialogOutput");
  const inputWrap = $("#actionDialogInputWrap");
  const input = $("#actionDialogInput");
  const cancel = $("#actionDialogCancel");
  const confirm = $("#actionDialogConfirm");

  clearTimeout(state.actionDialogAutoClose);
  dialog.dataset.mode = mode;
  dialog.dataset.input = options.input ? "true" : "false";
  dialog.hidden = false;
  panel.classList.toggle("is-success", mode === "success");
  icon.className = `action-dialog-icon is-${mode}`;
  icon.innerHTML = mode === "running"
    ? `<i data-lucide="${escapeHtml(options.icon || "refresh-cw")}"></i>`
    : `<i data-lucide="${escapeHtml(options.icon || (mode === "success" ? "check" : mode === "error" ? "alert-triangle" : "git-pull-request"))}"></i>`;
  $("#actionDialogEyebrow").textContent = options.eyebrow || "Git Action";
  $("#actionDialogTitle").textContent = options.title || "Confirm action";
  $("#actionDialogMessage").textContent = options.message || "Review this Git action before it runs.";
  inputWrap.hidden = !options.input;
  if (options.input) {
    $("#actionDialogInputLabel").textContent = options.inputLabel || "Name";
    input.value = options.inputValue || "";
    input.placeholder = options.inputPlaceholder || "";
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
  output.hidden = !options.output;
  output.textContent = options.output || "";
  cancel.hidden = mode !== "confirm";
  confirm.disabled = mode === "running";
  confirm.textContent = mode === "confirm" ? (options.confirmLabel || "Run") : mode === "running" ? "Running..." : "Close";
  confirm.classList.toggle("is-danger-action", Boolean(options.danger));
  confirm.classList.toggle("accent", !options.danger);
  iconRefresh();
}

function closeActionDialog(result = false) {
  clearTimeout(state.actionDialogAutoClose);
  $("#actionDialog").hidden = true;
  const resolver = state.actionDialogResolve;
  state.actionDialogResolve = null;
  if (resolver) resolver(result);
}

function confirmAction(options) {
  return new Promise((resolve) => {
    if (state.actionDialogResolve) state.actionDialogResolve(false);
    state.actionDialogResolve = resolve;
    setActionDialog({ mode: "confirm", ...options });
  });
}

function promptAction(options) {
  return new Promise((resolve) => {
    if (state.actionDialogResolve) state.actionDialogResolve(null);
    state.actionDialogResolve = resolve;
    setActionDialog({ mode: "confirm", input: true, ...options });
  });
}

function confirmActionDialog() {
  const dialog = $("#actionDialog");
  const mode = dialog.dataset.mode || "";
  if (mode === "running") return;
  if (mode !== "confirm") return closeActionDialog(true);
  if (dialog.dataset.input === "true") {
    const value = $("#actionDialogInput").value.trim();
    if (!value) return showToast("Enter a value first.");
    return closeActionDialog(value);
  }
  closeActionDialog(true);
}

function cancelActionDialog() {
  if (($("#actionDialog").dataset.mode || "") === "running") return;
  closeActionDialog(false);
}

async function runActionDialog(options) {
  state.repoActionInFlight = true;
  setActionDialog({
    mode: "running",
    eyebrow: options.eyebrow || "Git Action",
    title: options.runningTitle || options.title || "Running Git action",
    message: options.runningMessage || "Working in your local repository...",
    icon: options.icon || "refresh-cw"
  });

  try {
    const result = await options.task();
    const output = String(result?.output || "").trim();
    setActionDialog({
      mode: "success",
      eyebrow: options.eyebrow || "Git Action",
      title: options.successTitle || "Action complete",
      message: options.successMessage || "Your local repository is up to date in the app.",
      icon: "check",
      output: output || options.successOutput || ""
    });
    showToast(options.successToast || options.successMessage || "Action complete.", "success");
    state.actionDialogAutoClose = setTimeout(() => closeActionDialog(true), 1700);
    return result;
  } catch (error) {
    setActionDialog({
      mode: "error",
      eyebrow: options.eyebrow || "Git Action",
      title: options.errorTitle || "Action failed",
      message: error.message,
      icon: "alert-triangle",
      output: error.message
    });
    showToast(error.message);
    return null;
  } finally {
    state.repoActionInFlight = false;
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function identityText(identity) {
  if (!identity?.name && !identity?.email) return "Not set";
  if (!identity.email) return identity.name;
  if (!identity.name) return identity.email;
  return `${identity.name} <${identity.email}>`;
}

function selectedProfile() {
  return state.profiles.find((profile) => profile.id === state.selectedId);
}

function initials(profile) {
  return (profile.label || profile.name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function colorFromText(value) {
  const palette = ["#18c7b8", "#f28a38", "#66c56f", "#a777e3", "#ff6b64", "#f4c84a", "#60a5fa"];
  const text = String(value || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length];
}

function authorColor(author) {
  const profile = state.profiles.find((item) => {
    const haystack = `${item.name} ${item.github} ${item.label}`.toLowerCase();
    return haystack.includes(String(author || "").toLowerCase());
  });
  return profile?.color || colorFromText(author);
}

function authorProfile(author) {
  const target = String(author || "").toLowerCase();
  return state.profiles.find((item) => {
    const parts = [item.name, item.github, item.label].filter(Boolean).map((value) => String(value).toLowerCase());
    return parts.some((part) => part === target);
  });
}

function generatedAvatar(author, color) {
  const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : "#18c7b8";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${safeColor}"/>
          <stop offset="1" stop-color="#101515"/>
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="32" fill="url(#bg)"/>
      <circle cx="32" cy="25" r="12" fill="rgba(255,255,255,.92)"/>
      <path d="M12 57c3.4-14 13-21 20-21s16.6 7 20 21" fill="rgba(255,255,255,.88)"/>
      <circle cx="21" cy="15" r="4" fill="rgba(255,255,255,.3)"/>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function commitAvatar(commit) {
  const color = authorColor(commit.author);
  const profile = authorProfile(commit.author);
  const github = String(profile?.github || "").trim().replace(/^@/, "");
  const authorAsGithub = String(commit.author || "").trim().replace(/^@/, "");
  const githubUser = github || (/^[a-z0-9-]{1,39}$/.test(authorAsGithub) ? authorAsGithub : "");
  const fallback = generatedAvatar(commit.author, color);
  return {
    color,
    fallback,
    src: githubUser ? `https://github.com/${encodeURIComponent(githubUser)}.png?size=64` : fallback
  };
}

function statusClass(value) {
  const label = String(value || "changed").toLowerCase();
  if (label.includes("delete") || label === "d") return "status-deleted";
  if (label.includes("add") || label === "a" || label.includes("untracked")) return "status-added";
  if (label.includes("rename") || label === "r") return "status-renamed";
  if (label.includes("conflict") || label === "u") return "status-conflict";
  if (label.includes("modif") || label === "m") return "status-modified";
  return "status-changed";
}

function highlightDiff(text) {
  const value = String(text || "");
  if (!value) return "";
  return value
    .split("\n")
    .map((line) => {
      let className = "diff-line";
      if (line.startsWith("@@")) className += " diff-hunk";
      else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) className += " diff-file";
      else if (line.startsWith("+") && !line.startsWith("+++")) className += " diff-add";
      else if (line.startsWith("-") && !line.startsWith("---")) className += " diff-del";
      return `<span class="${className}">${line ? escapeHtml(line) : " "}</span>`;
    })
    .join("");
}

function setDiff(selector, text) {
  const target = $(selector);
  if (target) target.innerHTML = highlightDiff(text);
}

function highlightConflictText(text) {
  let section = "";
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (line.startsWith("<<<<<<<")) section = "ours";
      else if (line.startsWith("=======")) section = "divider";
      else if (line.startsWith(">>>>>>>")) section = "theirs";
      const marker = line.startsWith("<<<<<<<") || line.startsWith("=======") || line.startsWith(">>>>>>>");
      const className = marker ? "conflict-marker" : section === "ours" ? "conflict-ours-line" : section === "theirs" ? "conflict-theirs-line" : "conflict-line";
      if (line.startsWith("=======")) section = "theirs";
      if (line.startsWith(">>>>>>>")) section = "";
      return `<span class="${className}">${line ? escapeHtml(line) : " "}</span>`;
    })
    .join("");
}

function conflictPane(title, subtitle, text, tone) {
  return `
    <section class="conflict-pane ${tone}">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(subtitle)}</span>
      </header>
      <div class="conflict-code">${highlightConflictText(text || "No content available for this side.")}</div>
    </section>
  `;
}

function renderConflictResolver(payload) {
  const file = escapeHtml(payload.file);
  $("#commitPatch").innerHTML = `
    <div class="conflict-resolver">
      <div class="conflict-summary">
        <strong>${escapeHtml(payload.file)}</strong>
        <span>Review each side, then choose which version to stage as resolved.</span>
      </div>
      <div class="conflict-action-bar conflict-action-bar-main">
        <button type="button" data-conflict-resolve="ours" data-conflict-file="${file}"><i data-lucide="check"></i>Accept Current</button>
        <button type="button" data-conflict-resolve="theirs" data-conflict-file="${file}"><i data-lucide="arrow-down-left"></i>Accept Incoming</button>
        <button type="button" data-conflict-resolve="mark" data-conflict-file="${file}"><i data-lucide="badge-check"></i>Mark Resolved</button>
      </div>
      <div class="conflict-grid">
        ${conflictPane("Current", "Your branch / ours", payload.ours, "ours")}
        ${conflictPane("Incoming", "Merged branch / theirs", payload.theirs, "theirs")}
        ${conflictPane("Base", "Common ancestor", payload.base, "base")}
        ${conflictPane("Working File", "Conflict markers in the file", payload.current, "working")}
      </div>
    </div>
  `;
}

async function copyText(value, label = "Value") {
  const text = String(value || "");
  if (!text) return showToast("Nothing to copy.");
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied.`);
  } catch (error) {
    showToast("Clipboard permission was not available.");
  }
}

function commitByHash(hash) {
  return state.repo?.commits.find((commit) => commit.hash === hash);
}

function commitRefItems(commit) {
  return String(commit?.refs || "")
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => !/^refs\/stash\b/.test(ref) && !/^stash\b/.test(ref))
    .filter(Boolean)
    .map((ref) => {
      const clean = ref.replace(/^HEAD -> /, "").replace(/^tag: /, "");
      const kind = ref.includes("tag:") ? "tag" : clean.includes("origin/") ? "remote" : "branch";
      return { clean, kind };
    })
    .filter((ref) => ref.clean && !ref.clean.endsWith("/HEAD"));
}

function commitBranchRef(commit) {
  const refs = commitRefItems(commit);
  return refs.find((ref) => ref.kind === "branch") || refs.find((ref) => ref.kind === "remote") || refs[0];
}

function commitRemoteUrl(commit) {
  const remote = String(state.repo?.remote || "");
  const httpsMatch = remote.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  const sshMatch = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  const match = httpsMatch || sshMatch;
  if (!match) return "";
  return `https://github.com/${match[1]}/${match[2]}/commit/${commit.hash}`;
}

function contextMenuItems(commit) {
  const branchRef = commitBranchRef(commit);
  return [
    { id: "merge", label: "Merge", icon: "git-merge" },
    { id: "rebase", label: "Rebase", icon: "git-compare-arrows" },
    { id: "checkout", label: "Checkout", icon: "git-branch", detail: branchRef?.clean || "No branch ref" },
    { id: "worktree", label: "Create worktree from here", icon: "folder-plus" },
    { id: "branch", label: "Create branch here", icon: "git-branch-plus" },
    { id: "cherry-pick", label: "Cherry pick", icon: "cherry" },
    { id: "reset", label: "Reset", icon: "rotate-ccw", danger: true },
    { id: "revert", label: "Revert", icon: "undo-2", danger: true },
    { id: "explain", label: "Explain", icon: "sparkles" },
    { id: "delete", label: "Delete", icon: "trash-2", danger: true },
    { separator: true },
    { id: "copy-branch", label: "Copy branch", icon: "copy" },
    { id: "copy-commit", label: "Copy commit", icon: "copy" },
    { id: "copy-link", label: "Copy link to this commit", icon: "link" },
    { id: "patch", label: "Create patch from commit", icon: "file-code-2" },
    { id: "cloud-patch", label: "Share commit as cloud patch", icon: "cloud-upload" },
    { separator: true },
    { id: "pin", label: "Pin to left side", icon: "pin" },
    { id: "solo", label: "Solo", icon: "focus" },
    { id: "compare", label: "Compare commit", icon: "columns-2" },
    { id: "tag", label: "Create tag here", icon: "tag" },
    { id: "annotated-tag", label: "Create annotated tag here", icon: "badge-plus" }
  ];
}

function hideCommitContextMenu() {
  commitContextMenu.hidden = true;
  commitContextMenu.innerHTML = "";
}

function rememberContextMenuWheel(event) {
  if (commitContextMenu.hidden) return;
  const target = event.target;
  const rect = commitContextMenu.getBoundingClientRect();
  const pointInsideMenu =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  const targetInsideMenu = target instanceof Element && commitContextMenu.contains(target);
  if (pointInsideMenu || targetInsideMenu) contextMenuScrollGuardUntil = performance.now() + 400;
}

function handleContextMenuScroll(event) {
  if (commitContextMenu.hidden) return;
  if (performance.now() < contextMenuScrollGuardUntil) return;
  const target = event.target;
  if (target instanceof Element && commitContextMenu.contains(target)) return;
  hideCommitContextMenu();
}

function showCommitContextMenu(event, commit) {
  event.preventDefault();
  if (!commit) return;
  state.selectedCommit = commit.hash;
  renderCommitGraph();

  commitContextMenu.innerHTML = `
    <div class="context-menu-head">
      <strong>${escapeHtml(commit.shortHash)}</strong>
      <span>${escapeHtml(commit.subject)}</span>
    </div>
    ${contextMenuItems(commit).map((item) => {
      if (item.separator) return `<div class="context-separator"></div>`;
      return `
        <button class="context-menu-item ${item.danger ? "is-danger" : ""}" type="button" data-commit-action="${escapeHtml(item.id)}" data-commit-hash="${escapeHtml(commit.hash)}">
          <i data-lucide="${escapeHtml(item.icon)}"></i>
          <span>${escapeHtml(item.label)}</span>
          ${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}
        </button>
      `;
    }).join("")}
  `;

  commitContextMenu.hidden = false;
  iconRefresh();
  const padding = 10;
  const rect = commitContextMenu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - rect.width - padding);
  const top = Math.min(event.clientY, window.innerHeight - rect.height - padding);
  commitContextMenu.style.left = `${Math.max(padding, left)}px`;
  commitContextMenu.style.top = `${Math.max(padding, top)}px`;
}

async function createBranchAtCommit(commit) {
  const name = await promptAction({
    eyebrow: "Branch",
    title: "Create branch here",
    message: `Create a new branch at ${commit.shortHash}.`,
    icon: "git-branch-plus",
    confirmLabel: "Create branch",
    inputLabel: "Branch name",
    inputValue: `branch/${commit.shortHash}`,
    inputPlaceholder: "feature/new-work"
  });
  if (!name) return;
  const repo = await runActionDialog({
    eyebrow: "Branch",
    runningTitle: "Creating branch...",
    runningMessage: `Creating ${name} at ${commit.shortHash}.`,
    successTitle: "Branch created",
    successMessage: `${name} is checked out.`,
    successToast: `Created branch ${name}.`,
    icon: "git-branch-plus",
    task: () => request("/api/repo/branch", {
      method: "POST",
      body: JSON.stringify({ path: state.repoPath, name, startPoint: commit.hash })
    })
  });
  if (!repo) return;
  state.selectedCommit = commit.hash;
  state.centerMode = "graph";
  state.inspectorOpen = false;
  applyRepoSnapshot(repo, { source: "action" });
}

async function createTagAtCommit(commit, annotated = false) {
  const name = await promptAction({
    eyebrow: "Tag",
    title: annotated ? "Create annotated tag" : "Create tag",
    message: `Create a tag at ${commit.shortHash}.`,
    icon: annotated ? "badge-plus" : "tag",
    confirmLabel: "Continue",
    inputLabel: "Tag name",
    inputValue: `v-${commit.shortHash}`,
    inputPlaceholder: "v1.0.0"
  });
  if (!name) return;
  const message = annotated ? await promptAction({
    eyebrow: "Tag",
    title: "Annotated tag message",
    message: `Add a message for ${name}.`,
    icon: "badge-plus",
    confirmLabel: "Create tag",
    inputLabel: "Message",
    inputValue: `Tag ${name}`,
    inputPlaceholder: `Tag ${name}`
  }) : "";
  if (annotated && !message) return;
  const repo = await runActionDialog({
    eyebrow: "Tag",
    runningTitle: "Creating tag...",
    runningMessage: `Creating ${name} at ${commit.shortHash}.`,
    successTitle: "Tag created",
    successMessage: `${name} is now visible on the graph refs.`,
    successToast: `Created tag ${name}.`,
    icon: annotated ? "badge-plus" : "tag",
    task: () => request("/api/repo/tag", {
      method: "POST",
      body: JSON.stringify({ path: state.repoPath, hash: commit.hash, name, message, annotated })
    })
  });
  if (!repo) return;
  applyRepoSnapshot(repo, { source: "action" });
}

async function handleCommitContextAction(action, hash) {
  const commit = commitByHash(hash);
  if (!commit) return;
  hideCommitContextMenu();

  const branchRef = commitBranchRef(commit);
  const remoteUrl = commitRemoteUrl(commit);
  const branchName = branchRef?.clean || state.repo?.branch || "";

  if (action === "explain") return loadCommitDetails(commit.hash, false, true);
  if (action === "copy-commit") return copyText(commit.hash, "Commit hash");
  if (action === "copy-branch") return copyText(branchName, "Branch");
  if (action === "copy-link") return copyText(remoteUrl || commit.hash, remoteUrl ? "Commit link" : "Commit hash");
  if (action === "branch") return createBranchAtCommit(commit);
  if (action === "tag") return createTagAtCommit(commit, false);
  if (action === "annotated-tag") return createTagAtCommit(commit, true);
  if (action === "patch") {
    const payload = await request(`/api/repo/patch?path=${encodeURIComponent(state.repoPath)}&hash=${encodeURIComponent(commit.hash)}`);
    return copyText(payload.patch, "Patch");
  }
  if (action === "checkout") {
    if (!branchRef) return showToast("This commit has no branch ref to checkout.");
    if (branchRef.kind === "remote") return showToast("Remote branch checkout needs local tracking setup first.");
    return checkoutBranch(branchRef.clean);
  }

  const guarded = {
    merge: "Merge is shown here, but not run yet because it can rewrite your working tree.",
    rebase: "Rebase is shown here, but not run yet because it rewrites history.",
    worktree: "Worktree creation needs a destination picker before it can run.",
    "cherry-pick": "Cherry pick is shown here, but not run yet because it modifies your working tree.",
    reset: "Reset is disabled here so your files/history are not changed accidentally.",
    revert: "Revert is shown here, but not run yet because it creates a new commit.",
    delete: "Delete is disabled here so branches/tags are not removed accidentally.",
    "cloud-patch": "Cloud patches need a sharing backend before this can upload anything.",
    pin: "Pinned commit view is ready for a left-side pin panel next.",
    solo: "Solo mode is ready for filtering the graph to this commit path next.",
    compare: "Compare commit needs a second selected commit."
  };
  showToast(guarded[action] || "Action ready.");
}

function renderInspectorMode() {
  $("#graphView").hidden = state.inspectorOpen;
  $("#inspectorView").hidden = !state.inspectorOpen;
}

function renderRightFileList() {
  const repo = state.repo;
  if (!repo) return;

  const showingCommit = state.centerMode === "commit";
  $("#filePanelEyebrow").textContent = showingCommit ? "Commit" : "Working Tree";
  $("#filePanelTitle").textContent = showingCommit ? "Changed Files" : "Changed Files";

  if (showingCommit) {
    $("#fileList").innerHTML = state.selectedCommitFiles.length
      ? state.selectedCommitFiles.map((file) => `
        <button class="commit-file-row ${statusClass(file.label || file.status)} ${file.file === state.selectedCommitFile ? "is-current" : ""}" data-commit-file="${escapeHtml(file.file)}">
          <span><i data-lucide="file-diff"></i>${escapeHtml(file.file)}</span>
          <small>${escapeHtml(file.label)}</small>
        </button>
      `).join("")
      : `<div class="empty compact-empty">Loading changed files for this commit.</div>`;
    return;
  }

  $("#fileList").innerHTML = repo.files.length
    ? repo.files.map((file) => `
      <button class="row file-row ${statusClass(file.label)} ${file.file === state.selectedFile ? "is-current" : ""}" data-file="${escapeHtml(file.file)}">
        <span><i data-lucide="file-diff"></i>${escapeHtml(file.file)}</span>
        <small>${escapeHtml(file.label)}</small>
      </button>
    `).join("")
    : `<div class="empty compact-empty">Working tree is clean.</div>`;
}

function fillForm(profile = {}) {
  $("#profileId").value = profile.id || "";
  $("#label").value = profile.label || "";
  $("#github").value = profile.github || "";
  $("#name").value = profile.name || "";
  $("#email").value = profile.email || "";
  $("#color").value = profile.color || "#2563eb";
  $("#formTitle").textContent = profile.id ? profile.label : "New identity";
  $("#deleteButton").disabled = !profile.id;
}

function renderProfiles() {
  if (!state.profiles.length) {
    accountMenuProfiles.innerHTML = `<div class="empty compact-empty">No users yet.</div>`;
    $("#accountButtonLabel").textContent = "Add account";
    $("#accountAvatar").textContent = "?";
    iconRefresh();
    return;
  }

  const active = state.profiles.find((profile) => identityText({ name: profile.name, email: profile.email }) === state.activeIdentity) || selectedProfile() || state.profiles[0];
  $("#accountButtonLabel").textContent = active.label;
  $("#accountAvatar").textContent = initials(active);
  $("#accountAvatar").style.setProperty("--profile-color", active.color);

  accountMenuProfiles.innerHTML = state.profiles
    .map((profile) => {
      const selected = profile.id === state.selectedId ? " is-selected" : "";
      return `
        <article class="profile-card account-row${selected}" style="--profile-color:${escapeHtml(profile.color)}" data-id="${escapeHtml(profile.id)}">
          <div class="avatar">${escapeHtml(initials(profile))}</div>
          <div class="profile-main">
            <strong>${escapeHtml(profile.label)}</strong>
            <span>${profile.github ? `@${escapeHtml(profile.github)}` : "Git profile"} · ${escapeHtml(profile.name)}</span>
          </div>
          <button class="quick-activate" title="Use identity" aria-label="Use identity" data-activate="${escapeHtml(profile.id)}">
            <i data-lucide="user-check"></i>
          </button>
        </article>
      `;
    })
    .join("");
  iconRefresh();
}

async function loadProfiles() {
  const payload = await request("/api/profiles");
  state.profiles = payload.profiles;
  if (!state.selectedId && state.profiles.length) state.selectedId = state.profiles[0].id;
  renderProfiles();
  fillForm(selectedProfile());
}

async function loadStatus() {
  const status = await request("/api/status");
  state.activeIdentity = identityText(status.global);
  renderProfiles();
}

async function saveCurrentProfile() {
  const payload = await request("/api/profiles", {
    method: "POST",
    body: JSON.stringify({
      id: $("#profileId").value || undefined,
      label: $("#label").value,
      github: $("#github").value,
      name: $("#name").value,
      email: $("#email").value,
      color: $("#color").value
    })
  });
  state.profiles = payload.profiles;
  state.selectedId = payload.profile.id;
  renderProfiles();
  fillForm(payload.profile);
  $("#accountEditorPanel").hidden = true;
  showToast("Identity saved.");
}

async function activateProfile(id = state.selectedId) {
  if (!id) return showToast("Pick an identity first.");
  const payload = await request("/api/switch", {
    method: "POST",
    body: JSON.stringify({ profileId: id })
  });
  state.activeIdentity = identityText(payload.status.global);
  $("#accountMenu").hidden = true;
  renderProfiles();
  showToast(`${payload.profile.label} is active for commits.`);
}

async function deleteCurrentProfile() {
  if (!state.selectedId) return;
  const profile = selectedProfile();
  const confirmed = await confirmAction({
    eyebrow: "Identity",
    title: "Delete commit profile?",
    message: `Remove "${profile?.label || "selected profile"}" from this app. Your Git config and commits are not deleted.`,
    icon: "trash-2",
    confirmLabel: "Delete",
    danger: true
  });
  if (!confirmed) return;
  await request(`/api/profiles/${encodeURIComponent(state.selectedId)}`, { method: "DELETE" });
  state.profiles = state.profiles.filter((profile) => profile.id !== state.selectedId);
  state.selectedId = state.profiles[0]?.id || "";
  renderProfiles();
  fillForm(selectedProfile());
  showToast("Identity removed.");
}

async function loadRepos() {
  const payload = await request("/api/repos");
  state.repos = payload.repos;
  renderRepos();
}

function renderRepos() {
  $("#repoNavCount").textContent = state.repos.length;
  repoTabs.innerHTML = state.repos.length
    ? state.repos.map((repo) => `
      <div class="repo-tab ${repo.root === state.repoPath ? "is-current" : ""}" data-repo-path="${escapeHtml(repo.root)}" role="tab" tabindex="0">
        <span>${escapeHtml(repo.name)}</span>
        <button class="repo-tab-close" type="button" data-close-repo-tab="${escapeHtml(repo.root)}" title="Close repository tab" aria-label="Close ${escapeHtml(repo.name)} tab">
          <i data-lucide="x"></i>
        </button>
      </div>
    `).join("")
    : `<button class="repo-tab is-empty" type="button" data-open-repo-dialog><i data-lucide="folder-plus"></i><span>Add repository</span></button>`;

  repoList.innerHTML = state.repos.length
    ? state.repos.map((repo) => `
      <button class="repo-row ${repo.root === state.repoPath ? "is-current" : ""}" data-repo-path="${escapeHtml(repo.root)}">
        <strong>${escapeHtml(repo.name)}</strong>
        <span>${escapeHtml(repo.remote || repo.root)}</span>
      </button>
    `).join("")
    : `<div class="empty compact-empty">Use the plus tab above to add or clone.</div>`;
  iconRefresh();
}

function clearRepoView() {
  stopRepoLiveSync();
  state.repo = null;
  state.repoPath = "";
  state.selectedFile = "";
  state.selectedCommit = "";
  state.selectedCommitFile = "";
  state.selectedCommitFiles = [];
  state.selectedCommitPatch = "";
  state.selectedCommitPatchHash = "";
  state.lastRepoSignature = "";
  state.inspectorOpen = false;
  state.centerMode = "graph";
  localStorage.removeItem("repoPath");

  $("#repoName").textContent = "Open a local repository";
  $("#repoRemote").textContent = "Use the plus tab to add or clone.";
  $("#branchPill").textContent = "No branch";
  $("#branchButtonLabel").textContent = "No branch";
  $("#aheadBehindPill").textContent = "0 ahead / 0 behind";
  $("#changePill").textContent = "0 changes";
  $("#localNavCount").textContent = "0";
  $("#remoteNavCount").textContent = "0";
  $("#stashNavCount").textContent = "0";
  $("#toolbarBranchList").innerHTML = `<div class="empty compact-empty">No repository open.</div>`;
  $("#localBranchList").innerHTML = "";
  $("#remoteBranchList").innerHTML = "";
  $("#graphCount").textContent = "0 commits";
  $("#commitGraph").innerHTML = `<div class="empty compact-empty">Open a repository to see its commit graph.</div>`;
  $("#filePanelEyebrow").textContent = "Working Tree";
  $("#filePanelTitle").textContent = "Changed Files";
  $("#fileList").innerHTML = `<div class="empty compact-empty">No repository open.</div>`;
  $("#diffTitle").textContent = "Select a file";
  $("#diffView").textContent = "Select a changed file on the right. Its changes will replace the graph.";
  $("#stashList").innerHTML = `<div class="empty compact-empty">No stashes.</div>`;
  renderInspectorMode();
  iconRefresh();
}

async function closeRepoTab(path) {
  const closingIndex = state.repos.findIndex((repo) => repo.root === path);
  const wasActive = path === state.repoPath;
  const payload = await request(`/api/repos/${encodeURIComponent(path)}`, { method: "DELETE" });
  state.repos = payload.repos;

  if (wasActive) {
    const nextRepo = state.repos[Math.min(Math.max(closingIndex, 0), state.repos.length - 1)];
    if (nextRepo) {
      await openRepo(nextRepo.root);
    } else {
      renderRepos();
      clearRepoView();
    }
  } else {
    renderRepos();
  }

  showToast("Repository tab closed. Local files were not deleted.");
}

async function addRepo(path = $("#localPathInput").value.trim()) {
  if (!path) return showToast("Paste a local repository path first.");
  const payload = await request("/api/repos", {
    method: "POST",
    body: JSON.stringify({ path })
  });
  state.repos = payload.repos;
  $("#repoDialog").hidden = true;
  renderRepos();
  await openRepo(payload.repo.root);
}

async function cloneRepo() {
  const remote = $("#cloneUrl").value.trim();
  const destination = $("#cloneDestination").value.trim();
  if (!remote || !destination) return showToast("Clone URL and destination are required.");
  const confirmed = await confirmAction({
    eyebrow: "Clone",
    title: "Clone repository?",
    message: `Clone ${remote} into ${destination}.`,
    icon: "download",
    confirmLabel: "Clone"
  });
  if (!confirmed) return;
  const payload = await runActionDialog({
    eyebrow: "Clone",
    title: "Cloning repository",
    runningTitle: "Cloning repository...",
    runningMessage: "Downloading the repository into the selected local folder.",
    successTitle: "Repository cloned",
    successMessage: "The new repository is open and live sync is running.",
    successToast: "Repository cloned.",
    icon: "download",
    task: () => request("/api/repo/clone", {
      method: "POST",
      body: JSON.stringify({ remote, destination })
    })
  });
  if (!payload) return;
  state.repos = payload.repos;
  state.selectedFile = "";
  state.selectedCommit = payload.repo.commits[0]?.hash || "";
  state.selectedCommitFile = "";
  state.selectedCommitFiles = [];
  state.selectedCommitPatch = "";
  state.selectedCommitPatchHash = "";
  state.inspectorOpen = false;
  state.centerMode = "graph";
  state.repoPath = payload.repo.root;
  localStorage.setItem("repoPath", state.repoPath);
  $("#cloneUrl").value = "";
  $("#cloneDestination").value = "";
  $("#repoDialog").hidden = true;
  renderRepos();
  applyRepoSnapshot(payload.repo, { source: "action", preserveGraph: false });
  startRepoLiveSync();
}

async function openRepo(path = state.repoPath) {
  if (!path) return showToast("Paste a local repository path first.");
  const repo = await request(`/api/repo?path=${encodeURIComponent(path)}`);
  stopRepoLiveSync();
  state.selectedFile = "";
  state.selectedCommit = repo.commits[0]?.hash || "";
  state.selectedCommitFile = "";
  state.selectedCommitFiles = [];
  state.selectedCommitPatch = "";
  state.selectedCommitPatchHash = "";
  state.inspectorOpen = false;
  state.centerMode = "graph";
  localStorage.setItem("repoPath", repo.root);
  await loadRepos();
  applyRepoSnapshot(repo, { source: "open", preserveGraph: false });
  if (state.selectedCommit) await loadCommitDetails(state.selectedCommit, true, false);
  startRepoLiveSync();
  showToast("Repository opened.");
}

async function browsePath(path = state.browserPath) {
  const payload = await request(`/api/fs?path=${encodeURIComponent(path)}`);
  state.browserPath = payload.path;
  localStorage.setItem("browserPath", payload.path);
  $("#pathBrowserCurrent").textContent = payload.path;
  if (state.browserTarget === "local") $("#localPathInput").value = payload.path;
  else $("#cloneDestination").value = payload.path;
  $("#pathBrowserList").innerHTML = `
    <button class="path-row ${payload.isGitRepo ? "is-git" : ""}" data-select-path="${escapeHtml(payload.path)}">
      <i data-lucide="${payload.isGitRepo ? "folder-git-2" : "folder"}"></i>
      <span>${escapeHtml(payload.path.split("/").filter(Boolean).pop() || payload.path)}</span>
      <small>${payload.isGitRepo ? "Git repo" : "Current folder"}</small>
    </button>
    ${payload.directories.map((entry) => `
      <button class="path-row" data-browse-path="${escapeHtml(entry.path)}">
        <i data-lucide="folder"></i>
        <span>${escapeHtml(entry.name)}</span>
      </button>
    `).join("")}
  `;
  iconRefresh();
}

function openRepoDialog(mode = "local") {
  $("#repoDialog").hidden = false;
  setRepoDialogMode(mode);
  browsePath(state.browserPath).catch((error) => showToast(error.message));
}

function setRepoDialogMode(mode) {
  const isLocal = mode === "local";
  state.browserTarget = isLocal ? "local" : "clone";
  $("#localRepoDialogTab").classList.toggle("is-active", isLocal);
  $("#cloneRepoDialogTab").classList.toggle("is-active", !isLocal);
  $("#localRepoDialogPanel").hidden = !isLocal;
  $("#cloneRepoDialogPanel").hidden = isLocal;
}

function renderRepo() {
  const repo = state.repo;
  if (!repo) return;

  $("#repoName").textContent = repo.root.split("/").filter(Boolean).pop() || repo.root;
  $("#repoRemote").textContent = repo.remote || repo.root;
  $("#branchPill").textContent = repo.branch;
  $("#branchButtonLabel").textContent = repo.branch || "No branch";
  $("#aheadBehindPill").textContent = `${repo.ahead} ahead / ${repo.behind} behind`;
  $("#changePill").textContent = `${repo.files.length} changes`;
  $("#localNavCount").textContent = repo.branches.length;
  $("#remoteNavCount").textContent = repo.remoteBranches.length;
  $("#stashNavCount").textContent = repo.stashes.length;
  renderRepos();

  $("#toolbarBranchList").innerHTML = repo.branches.length
    ? repo.branches.map((branch) => `
      <button class="toolbar-branch-row ${branch.current ? "is-current" : ""}" data-checkout="${escapeHtml(branch.name)}">
        <span><i data-lucide="git-branch"></i>${escapeHtml(branch.name)}</span>
        <small>${branch.current ? "current" : escapeHtml(branch.upstream || "local")}</small>
      </button>
    `).join("")
    : `<div class="empty compact-empty">No branches found.</div>`;

  $("#localBranchList").innerHTML = repo.branches.length
    ? repo.branches.map((branch) => `
      <button class="side-row ${branch.current ? "is-current" : ""}" data-checkout="${escapeHtml(branch.name)}">
        <i data-lucide="git-branch"></i>
        <span>${escapeHtml(branch.name)}</span>
      </button>
    `).join("")
    : `<div class="empty compact-empty">No local branches.</div>`;

  $("#remoteBranchList").innerHTML = repo.remoteBranches.length
    ? repo.remoteBranches.map((branch) => `
      <div class="side-row">
        <i data-lucide="cloud"></i>
        <span>${escapeHtml(branch)}</span>
      </div>
    `).join("")
    : `<div class="empty compact-empty">No remote branches.</div>`;

  if (!repo.commits.some((commit) => commit.hash === state.selectedCommit)) {
    state.selectedCommit = repo.commits[0]?.hash || "";
  }
  renderCommitGraph();
  if (state.centerMode !== "worktree") renderCommitInspector();
  renderInspectorMode();
  renderRightFileList();

  $("#stashList").innerHTML = repo.stashes.length
    ? `<div class="stash-graph-note"><i data-lucide="git-graph"></i><span>${repo.stashes.length} stash${repo.stashes.length === 1 ? "" : "es"} in graph</span></div>`
    : `<div class="empty compact-empty">No stashes.</div>`;

  iconRefresh();
}

function graphRows(commits) {
  const lanes = [];
  const remaining = new Set(commits.map((commit) => commit.hash));
  return commits.map((commit) => {
    remaining.delete(commit.hash);
    let lane = lanes.indexOf(commit.hash);
    const isNewHead = lane === -1;
    if (lane === -1) {
      lane = lanes.findIndex((value) => !value);
      if (lane === -1) lane = lanes.length;
      lanes[lane] = commit.hash;
    }

    const before = [...lanes];
    const parents = commit.parents || [];
    const bridges = [];
    lanes[lane] = parents[0] || "";
    parents.slice(1).forEach((parent) => {
      if (lanes.includes(parent)) {
        bridges.push({ from: lane, to: lanes.indexOf(parent) });
        return;
      }
      const slot = lanes.findIndex((value) => !value);
      const parentLane = slot === -1 ? lanes.length : slot;
      if (slot === -1) lanes.push(parent);
      else lanes[parentLane] = parent;
      bridges.push({ from: lane, to: parentLane });
    });

    const laneCount = Math.max(before.length, lanes.length, 1);
    const active = Array.from({ length: laneCount }, (_, index) => before[index] || lanes[index] || "");
    lanes.forEach((value, index) => {
      if (value && !remaining.has(value)) lanes[index] = "";
    });
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    return {
      commit,
      lane,
      active,
      bridges,
      parentCount: parents.length,
      isNewHead,
      isTerminal: parents.length === 0
    };
  });
}

function commitRefItemsFromRefs(refs) {
  if (!refs) return [];
  return refs
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => !/^refs\/stash\b/.test(ref) && !/^stash\b/.test(ref))
    .filter(Boolean)
    .map((ref) => {
      const clean = ref.replace(/^HEAD -> /, "");
      const kind = ref.includes("tag:") ? "tag" : ref.includes("origin/") ? "remote" : "branch";
      const icon = kind === "tag" ? "tag" : kind === "remote" ? "cloud" : "git-branch";
      return { clean: clean.replace(/^tag: /, ""), icon, kind };
    });
}

function refPills(refs) {
  return commitRefItemsFromRefs(refs)
    .map((ref) => `<span class="ref-pill ${ref.kind}"><i data-lucide="${ref.icon}"></i>${escapeHtml(ref.clean)}</span>`)
    .join("");
}

function branchRail(refs, extra = "", color = "#18c7b8") {
  const items = commitRefItemsFromRefs(refs)
    .filter((ref) => ref.kind !== "tag")
    .map((ref) => {
      const branchName = ref.clean.replace(/^origin\//, "");
      const isCurrent = ref.kind === "branch" && branchName === state.repo?.branch;
      const icon = ref.kind === "remote" ? "github" : "monitor";
      return `
        <button
          type="button"
          class="branch-rail-pill ${ref.kind} ${isCurrent ? "is-current" : ""}"
          data-graph-branch="${escapeHtml(ref.clean)}"
          data-branch-kind="${escapeHtml(ref.kind)}"
          data-full-name="${escapeHtml(ref.clean)}"
          aria-label="${escapeHtml(ref.clean)}"
          title="Double-click to checkout ${escapeHtml(ref.clean)}"
        >
          ${isCurrent ? `<i data-lucide="check"></i>` : ""}
          <span>${escapeHtml(branchName)}</span>
          <i data-lucide="${icon}"></i>
        </button>
      `;
    })
    .join("");
  return `<span class="graph-branch-rail ${items || extra ? "has-refs" : ""}" style="--ref-color:${escapeHtml(color)}">${items}${extra}</span>`;
}

function nearestCommitForStash(stash, commits) {
  const stashTime = Number(stash.timestamp);
  if (!stashTime || !commits.length) return null;
  return commits.reduce((best, commit) => {
    const commitTime = Number(commit.timestamp);
    if (!commitTime) return best;
    const distance = Math.abs(commitTime - stashTime);
    if (!best || distance < best.distance) return { commit, distance };
    return best;
  }, null)?.commit || null;
}

function groupedStashes(repo) {
  const commitHashes = new Set(repo.commits.map((commit) => commit.hash));
  const byCommit = new Map(repo.commits.map((commit) => [commit.hash, []]));
  const unplaced = [];

  repo.stashes.forEach((stash, index) => {
    const item = { stash, index, placement: "base" };
    if (stash.baseHash && commitHashes.has(stash.baseHash)) {
      byCommit.get(stash.baseHash).push(item);
      return;
    }

    const nearest = nearestCommitForStash(stash, repo.commits);
    if (nearest) {
      item.placement = "date";
      byCommit.get(nearest.hash).push(item);
      return;
    }

    item.placement = "unplaced";
    unplaced.push(item);
  });

  return { byCommit, unplaced };
}

function stashLaneForItem(item, laneCount, stashLaneStart) {
  const available = Math.max(1, laneCount - stashLaneStart);
  return Math.min(laneCount - 1, stashLaneStart + (item.index % available));
}

function stashColorForItem(item, stashLaneStart) {
  return graphColors[(stashLaneStart + item.index) % graphColors.length] || "#f28a38";
}

function laneConnectorGeometry(sourceLane, targetLane) {
  const start = Math.min(sourceLane, targetLane);
  return {
    left: start * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2,
    width: Math.abs(sourceLane - targetLane) * GRAPH_LANE_WIDTH
  };
}

function stashOriginConnectorsMarkup(items, sourceLane, laneCount, stashLaneStart) {
  return items.map((item, rowOffset) => {
    const color = stashColorForItem(item, stashLaneStart);
    const verticalHeight = rowOffset * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2 + STASH_NODE_ANCHOR_Y;
    return `<span class="stash-origin-connector" style="--stash-source-left:${sourceLane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2}px; --stash-vertical-height:${verticalHeight}px; --lane-color:${color}"></span>`;
  }).join("");
}

function stashRowConnectorMarkup(sourceLane, stashLane, color) {
  if (sourceLane === stashLane) return "";
  const { left, width } = laneConnectorGeometry(sourceLane, stashLane);
  return `<span class="stash-row-connector" style="--stash-left:${left}px; --stash-width:${width}px; --stash-anchor-y:${STASH_NODE_ANCHOR_Y}px; --lane-color:${color}"></span>`;
}

function stashRowMarkup(item, laneCount, sourceLane = 0, active = [], stashLaneStart = 1) {
  const { stash, index, placement } = item;
  const base = stash.baseHash ? stash.baseHash.slice(0, 7) : "";
  const relation = placement === "base" && base ? `from ${base}` : placement === "date" ? "near this date" : `stash ${index + 1}`;
  const stashColor = stashColorForItem(item, stashLaneStart);
  const stashLane = stashLaneForItem(item, laneCount, stashLaneStart);
  const laneMarkup = Array.from({ length: laneCount }, (_, laneIndex) => {
    const laneColor = graphColors[laneIndex % graphColors.length];
    const hasMainLine = Boolean(active[laneIndex]);
    const isStashLane = laneIndex === stashLane;
    const stashNode = isStashLane
      ? `<span class="graph-node utility-node stash-node" style="--lane-color:${stashColor}; --author-color:${stashColor}">
          <i data-lucide="archive"></i>
          <small>${escapeHtml(stash.ref)}</small>
        </span>`
      : "";
    return `<span class="lane${hasMainLine ? " has-line" : ""}${isStashLane ? " has-stash-line" : ""}" style="--lane-color:${laneColor}; --stash-color:${stashColor}">${stashNode}</span>`;
  }).join("");
  return `
    <article class="graph-row graph-stash-row ${placement === "date" ? "is-date-matched" : ""}" data-stash-row="${escapeHtml(stash.ref)}" style="--lane-count:${laneCount}">
      <span class="graph-branch-rail"></span>
      <span class="graph-lanes">${stashRowConnectorMarkup(sourceLane, stashLane, stashColor)}${laneMarkup}</span>
      <span class="graph-copy">
        <strong>${escapeHtml(stash.subject || "Stashed changes")}</strong>
        <span>${escapeHtml(stash.relativeDate)} · ${escapeHtml(relation)}</span>
        <span class="graph-inline-actions">
          <button type="button" data-stash-apply="${escapeHtml(stash.ref)}"><i data-lucide="copy-check"></i>Apply</button>
          <button type="button" data-stash-pop="${escapeHtml(stash.ref)}"><i data-lucide="archive-restore"></i>Pop</button>
        </span>
      </span>
    </article>
  `;
}

function graphBridgeMarkup(bridges) {
  return bridges
    .filter((bridge) => bridge.from !== bridge.to)
    .map((bridge) => {
      const start = Math.min(bridge.from, bridge.to);
      const span = Math.abs(bridge.from - bridge.to);
      const color = graphColors[bridge.to % graphColors.length];
      const direction = bridge.to > bridge.from ? "to-right" : "to-left";
      const left = start * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
      const width = span * GRAPH_LANE_WIDTH;
      return `
        <span
          class="lane-bridge ${direction}"
          style="--bridge-left:${left}px; --bridge-width:${width}px; --lane-color:${color}"
        ></span>
      `;
    })
    .join("");
}

function branchLaneConnectorMarkup(lane, color) {
  const width = lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
  return `<span class="branch-lane-connector" style="--branch-link-width:${width}px; --lane-color:${color}"></span>`;
}

function graphLaneRailsMarkup(laneCount) {
  return `
    <div class="graph-lane-rails" aria-hidden="true">
      ${Array.from({ length: laneCount }, (_, index) => `
        <span
          class="graph-lane-rail"
          style="--rail-left:${index * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2}px; --lane-color:${graphColors[index % graphColors.length]}"
        ></span>
      `).join("")}
    </div>
  `;
}

function renderCommitGraph() {
  const repo = state.repo;
  const graph = $("#commitGraph");
  $("#graphCount").textContent = `${repo.commits.length} commits`;

  const rows = graphRows(repo.commits);
  const activeLaneCount = Math.max(1, ...rows.map((row) => row.active.length));
  const stashLaneCount = repo.stashes.length ? 2 : 0;
  const graphLaneCount = activeLaneCount + stashLaneCount;
  const graphRowCount = 1 + rows.length + repo.stashes.length;
  graph.style.setProperty("--graph-lanes-width", `${graphLaneCount * GRAPH_LANE_WIDTH}px`);
  graph.style.setProperty("--graph-rows-height", `${Math.max(676, graphRowCount * GRAPH_ROW_HEIGHT)}px`);
  const wipRows = `
    <article class="graph-row graph-wip-row ${state.centerMode === "worktree" ? "is-selected" : ""}" data-wip-row style="--lane-count:${graphLaneCount}">
      <span class="graph-branch-rail"></span>
      <span class="graph-lanes">${graphUtilityLanes(graphLaneCount, "wip")}</span>
      <span class="graph-copy">
        <strong>${repo.files.length ? "Working tree changes" : "Working tree clean"}</strong>
        <span>${repo.files.length ? `${repo.files.length} changed file${repo.files.length === 1 ? "" : "s"}` : "0 changed files"} on ${escapeHtml(repo.branch || "current branch")}</span>
        ${repo.files.length ? `
          <span class="graph-inline-actions">
            <button type="button" data-graph-stash><i data-lucide="archive"></i>Stash</button>
          </span>
        ` : ""}
      </span>
    </article>
  `;
  const stashes = groupedStashes(repo);

  const commitRowsMarkup = rows
    .map(({ commit, lane, active, bridges, parentCount, isNewHead, isTerminal }) => {
      const selected = commit.hash === state.selectedCommit ? " is-selected" : "";
      const attachedStashes = stashes.byCommit.get(commit.hash) || [];
      const laneMarkup = Array.from({ length: graphLaneCount }, (_, index) => {
        const value = active[index] || "";
        const color = graphColors[index % graphColors.length];
        const avatar = commitAvatar(commit);
        const node = index === lane
          ? `<span class="graph-node" title="${escapeHtml(commit.author)}" style="--lane-color:${color}; --author-color:${avatar.color}">
                <img src="${escapeHtml(avatar.src)}" alt="${escapeHtml(commit.author)}" data-fallback-avatar="${escapeHtml(avatar.fallback)}" />
              </span>`
          : "";
        const lineClass = value || index === lane ? " has-line" : "";
        const headClass = isNewHead && index === lane ? " terminal-start" : "";
        const endClass = isTerminal && index === lane ? " terminal-end" : "";
        const nodeClass = index === lane ? " has-node" : "";
        return `<span class="lane${lineClass}${headClass}${endClass}${nodeClass}" style="--lane-color:${color}">${node}</span>`;
      })
        .join("");
      const mergeBadge = parentCount > 1 ? `<span class="merge-badge"><i data-lucide="git-merge"></i>merge</span>` : "";
      const laneColor = graphColors[lane % graphColors.length];
      const hasBranchConnector = Boolean(commitRefItemsFromRefs(commit.refs).some((ref) => ref.kind !== "tag") || mergeBadge);
      return `
        <article class="graph-row graph-commit-row${selected}" data-commit="${escapeHtml(commit.hash)}" role="button" tabindex="0" style="--lane-count:${graphLaneCount}">
          ${branchRail(commit.refs, mergeBadge, laneColor)}
          <span class="graph-lanes">${hasBranchConnector ? branchLaneConnectorMarkup(lane, laneColor) : ""}${laneMarkup}${graphBridgeMarkup(bridges)}${stashOriginConnectorsMarkup(attachedStashes, lane, graphLaneCount, activeLaneCount)}</span>
          <span class="graph-copy">
            <strong>${escapeHtml(commit.subject)}</strong>
            <span>${escapeHtml(commit.shortHash)} · ${escapeHtml(commit.author)} · ${escapeHtml(commit.relativeDate)}</span>
          </span>
        </article>
        ${attachedStashes.map((item) => stashRowMarkup(item, graphLaneCount, lane, active, activeLaneCount)).join("")}
      `;
    })
    .join("");
  const unplacedStashRows = stashes.unplaced.map((item) => stashRowMarkup(item, graphLaneCount, 0, [], activeLaneCount)).join("");

  graph.innerHTML = `${graphLaneRailsMarkup(activeLaneCount)}${wipRows}${commitRowsMarkup}${unplacedStashRows}`;
  iconRefresh();
}

function graphUtilityLanes(count, type, nodeLane = 0, label = "") {
  return Array.from({ length: count }, (_, index) => {
    const color = type === "wip" ? "#18c7b8" : "#f28a38";
    const isNode = index === nodeLane;
    const node = isNode
      ? `<span class="graph-node utility-node ${type}-node" style="--lane-color:${color}; --author-color:${color}">
          <i data-lucide="${type === "wip" ? "pencil-line" : "archive"}"></i>
          ${type === "stash" ? `<small>${escapeHtml(label)}</small>` : ""}
        </span>`
      : "";
    const terminalClass = type === "wip" && index === nodeLane ? " terminal-start" : "";
    return `<span class="lane ${index === nodeLane ? "has-line" : ""}${terminalClass}" style="--lane-color:${color}">${node}</span>`;
  }).join("");
}

function renderCommitInspector(patchText) {
  const commit = state.repo?.commits.find((item) => item.hash === state.selectedCommit);
  if (!commit) {
    $("#commitDetailTitle").textContent = "Select a commit";
    $("#commitMeta").textContent = "Click a commit in the graph to see details.";
    $("#commitFiles").innerHTML = "";
    $("#commitPatch").textContent = "No commit selected.";
    renderInspectorMode();
    return;
  }

  $("#commitDetailTitle").textContent = commit.subject;
  $("#commitMeta").innerHTML = `
    <span>${escapeHtml(commit.shortHash)}</span>
    <span>${escapeHtml(commit.author)}</span>
    <span>${escapeHtml(commit.relativeDate)}</span>
    <span>${commit.parents.length} parent${commit.parents.length === 1 ? "" : "s"}</span>
    ${refPills(commit.refs)}
  `;
  $("#commitFiles").innerHTML = state.selectedCommitFiles.length
    ? `<div class="selected-file-note">Commit files stay in the right panel. Pick one there to focus only that file's changes.</div>`
    : `<div class="empty compact-empty">No changed files listed for this commit.</div>`;
  const cachedPatch = state.selectedCommitPatchHash === commit.hash ? state.selectedCommitPatch : "";
  const patch = patchText || cachedPatch;
  if (patch) setDiff("#commitPatch", patch);
  else $("#commitPatch").textContent = "Click this commit to load the stat and patch.";
  renderInspectorMode();
}

async function refreshRepo(options = {}) {
  const silent = options.silent ?? false;
  const source = options.source || "manual";
  if (!state.repoPath || state.repoRefreshInFlight || state.repoActionInFlight) return false;
  state.repoRefreshInFlight = true;
  if (!silent) setLiveSyncStatus("Syncing local repo...", "syncing");
  try {
    const repo = await request(`/api/repo?path=${encodeURIComponent(state.repoPath)}`);
    const changed = applyRepoSnapshot(repo, { source, preserveGraph: source === "poll" });
    if (!changed && !silent) setLiveSyncStatus("Already up to date", "updated");
    return changed;
  } catch (error) {
    setLiveSyncStatus("Live sync paused", "idle");
    if (!silent) throw error;
    return false;
  } finally {
    state.repoRefreshInFlight = false;
  }
}

async function loadCommitDetails(hash, silent = false, openInspector = true) {
  if (!state.repoPath) return;
  state.selectedCommit = hash;
  state.selectedCommitFile = "";
  state.selectedCommitFiles = [];
  if (state.selectedCommitPatchHash !== hash) {
    state.selectedCommitPatch = "";
    state.selectedCommitPatchHash = "";
  }
  state.inspectorOpen = openInspector;
  state.centerMode = "commit";
  renderCommitGraph();
  renderRightFileList();
  if (openInspector) renderCommitInspector("Loading commit details...");
  else {
    $("#diffTitle").textContent = "Select a file";
    $("#diffView").textContent = "Select a changed file on the right. Its changes will replace the graph.";
    renderInspectorMode();
  }
  const endpoint = openInspector ? "commit" : "commit-files";
  const payload = await request(`/api/repo/${endpoint}?path=${encodeURIComponent(state.repoPath)}&hash=${encodeURIComponent(hash)}`);
  state.selectedCommitFiles = payload.files || [];
  if (openInspector) {
    state.selectedCommitPatch = payload.patch || "";
    state.selectedCommitPatchHash = hash;
  }
  renderRightFileList();
  if (openInspector) renderCommitInspector(payload.patch);
  iconRefresh();
  if (!silent) showToast(openInspector ? "Commit selected." : "Commit files loaded.");
}

async function loadCommitFileDiff(file) {
  if (!state.repoPath || !state.selectedCommit) return;
  state.selectedCommitFile = file;
  state.centerMode = "commit";
  state.inspectorOpen = true;
  renderRightFileList();
  renderCommitInspector("Loading file diff...");
  const payload = await request(`/api/repo/commit-file?path=${encodeURIComponent(state.repoPath)}&hash=${encodeURIComponent(state.selectedCommit)}&file=${encodeURIComponent(file)}`);
  $("#commitDetailTitle").textContent = file;
  setDiff("#commitPatch", payload.diff);
  $("#diffTitle").textContent = file;
  $("#diffView").textContent = "Selected commit file. Its changes are open in the main panel.";
  iconRefresh();
  showToast("File diff loaded.");
}

async function loadDiff(file) {
  if (!state.repoPath) return;
  const status = state.repo?.files.find((item) => item.file === file)?.label || "Changed";
  if (String(status).toLowerCase().includes("conflict")) return loadConflict(file);
  state.selectedFile = file;
  state.selectedCommitFile = "";
  state.centerMode = "worktree";
  state.inspectorOpen = true;
  renderRepo();
  $("#commitDetailTitle").textContent = file;
  $("#commitMeta").innerHTML = `
    <span>Working tree</span>
    <span>${escapeHtml(status)}</span>
    <span>${escapeHtml(state.repo?.branch || "No branch")}</span>
  `;
  $("#commitFiles").innerHTML = `<div class="selected-file-note">The selected file stays highlighted in the right panel while its changes replace the graph.</div>`;
  $("#commitPatch").textContent = "Loading file changes...";
  renderInspectorMode();
  $("#diffTitle").textContent = file;
  $("#diffView").textContent = "Selected working tree file. Its changes are open in the main panel.";
  const payload = await request(`/api/repo/diff?path=${encodeURIComponent(state.repoPath)}&file=${encodeURIComponent(file)}`);
  setDiff("#commitPatch", payload.diff);
}

async function loadConflict(file) {
  state.selectedFile = file;
  state.selectedCommitFile = "";
  state.centerMode = "worktree";
  state.inspectorOpen = true;
  renderRepo();
  $("#commitDetailTitle").textContent = file;
  $("#commitMeta").innerHTML = `
    <span>Merge conflict</span>
    <span>${escapeHtml(state.repo?.branch || "No branch")}</span>
    <span>Choose current or incoming</span>
  `;
  $("#commitFiles").innerHTML = `
    <div class="conflict-action-bar">
      <button type="button" data-conflict-resolve="ours" data-conflict-file="${escapeHtml(file)}"><i data-lucide="check"></i>Accept Current</button>
      <button type="button" data-conflict-resolve="theirs" data-conflict-file="${escapeHtml(file)}"><i data-lucide="arrow-down-left"></i>Accept Incoming</button>
      <button type="button" data-conflict-resolve="mark" data-conflict-file="${escapeHtml(file)}"><i data-lucide="badge-check"></i>Mark Resolved</button>
    </div>
  `;
  $("#commitPatch").textContent = "Loading conflict sides...";
  renderInspectorMode();
  $("#diffTitle").textContent = file;
  $("#diffView").textContent = "Merge conflict open. Accept a side in the main inspector.";
  iconRefresh();
  const payload = await request(`/api/repo/conflict?path=${encodeURIComponent(state.repoPath)}&file=${encodeURIComponent(file)}`);
  renderConflictResolver(payload);
}

async function resolveConflict(file, action) {
  const labels = {
    ours: "Accept Current",
    theirs: "Accept Incoming",
    mark: "Mark Resolved"
  };
  const detail = action === "mark"
    ? "stage the file as resolved using its current contents"
    : `replace the working file with the ${action === "ours" ? "current branch" : "incoming branch"} version and stage it as resolved`;
  const confirmed = await confirmAction({
    eyebrow: "Merge Conflict",
    title: `${labels[action] || "Resolve"}?`,
    message: `${file}: this will ${detail}.`,
    icon: "git-merge",
    confirmLabel: labels[action] || "Resolve"
  });
  if (!confirmed) return;
  const repo = await runActionDialog({
    eyebrow: "Merge Conflict",
    runningTitle: "Resolving conflict...",
    runningMessage: "Applying your selected conflict resolution and staging the file.",
    successTitle: "Conflict staged",
    successMessage: "The file is staged as resolved.",
    successToast: "Conflict resolution staged.",
    icon: "git-merge",
    task: () => request("/api/repo/conflict/resolve", {
      method: "POST",
      body: JSON.stringify({ path: state.repoPath, file, action })
    })
  });
  if (!repo) return;
  state.inspectorOpen = false;
  state.centerMode = "worktree";
  state.selectedFile = "";
  applyRepoSnapshot(repo, { source: "action" });
}

async function checkoutBranch(branch) {
  const confirmed = await confirmAction({
    eyebrow: "Checkout",
    title: "Checkout branch?",
    message: `Switch to "${branch}". Git can block this if your uncommitted changes would be overwritten.`,
    icon: "git-branch",
    confirmLabel: "Checkout"
  });
  if (!confirmed) return;
  const repo = await runActionDialog({
    eyebrow: "Checkout",
    runningTitle: `Checking out ${branch}...`,
    runningMessage: "Switching the current local branch.",
    successTitle: "Branch checked out",
    successMessage: `${branch} is now active.`,
    successToast: `Checked out ${branch}.`,
    icon: "git-branch",
    task: () => request("/api/repo/checkout", {
      method: "POST",
      body: JSON.stringify({ path: state.repoPath, branch })
    })
  });
  if (!repo) return;
  applyRepoSnapshot(repo, { source: "action" });
}

async function createBranch() {
  const name = $("#newBranchName").value.trim();
  if (!name) return showToast("Enter a branch name first.");
  const repo = await runActionDialog({
    eyebrow: "Branch",
    runningTitle: "Creating branch...",
    runningMessage: `Creating and checking out ${name}.`,
    successTitle: "Branch created",
    successMessage: `${name} is now active.`,
    successToast: `Created and checked out ${name}.`,
    icon: "git-branch-plus",
    task: () => request("/api/repo/branch", {
      method: "POST",
      body: JSON.stringify({ path: state.repoPath, name })
    })
  });
  if (!repo) return;
  $("#newBranchName").value = "";
  applyRepoSnapshot(repo, { source: "action" });
}

async function stashChanges() {
  if (!state.repoPath) return showToast("Open a repository first.");
  const repo = await runActionDialog({
    eyebrow: "Stash",
    runningTitle: "Stashing changes...",
    runningMessage: "Saving the current working tree to the stash stack.",
    successTitle: "Changes stashed",
    successMessage: "Your WIP is now visible in the commit graph.",
    successToast: "Changes stashed.",
    icon: "archive",
    task: () => request("/api/repo/stash", {
      method: "POST",
      body: JSON.stringify({
        path: state.repoPath,
        message: $("#stashMessage").value.trim(),
        includeUntracked: $("#stashUntracked").checked
      })
    })
  });
  if (!repo) return;
  $("#stashMessage").value = "";
  applyRepoSnapshot(repo, { source: "action" });
}

async function quickStash() {
  if (!state.repoPath) return showToast("Open a repository first.");
  const confirmed = await confirmAction({
    eyebrow: "Stash",
    title: "Stash current changes?",
    message: "Save the current working tree as WIP so it appears in the graph.",
    icon: "archive",
    confirmLabel: "Stash"
  });
  if (!confirmed) return;
  await stashChanges();
}

async function applyStash(ref, pop = false) {
  const verb = pop ? "pop" : "apply";
  const confirmed = await confirmAction({
    eyebrow: "Stash",
    title: `${pop ? "Pop" : "Apply"} stash?`,
    message: `${verb.toUpperCase()} ${ref}. This can modify your working tree.`,
    icon: pop ? "archive-restore" : "copy-check",
    confirmLabel: pop ? "Pop stash" : "Apply stash"
  });
  if (!confirmed) return;
  const repo = await runActionDialog({
    eyebrow: "Stash",
    runningTitle: `${pop ? "Popping" : "Applying"} stash...`,
    runningMessage: `${ref} is being ${pop ? "popped" : "applied"} to your working tree.`,
    successTitle: "Stash action complete",
    successMessage: `${ref} ${verb} complete.`,
    successToast: `Stash ${verb} complete.`,
    icon: pop ? "archive-restore" : "copy-check",
    task: () => request("/api/repo/stash/apply", {
      method: "POST",
      body: JSON.stringify({ path: state.repoPath, ref, pop })
    })
  });
  if (!repo) return;
  applyRepoSnapshot(repo, { source: "action" });
}

async function dropStash(ref) {
  const confirmed = await confirmAction({
    eyebrow: "Stash",
    title: "Drop stash?",
    message: `Remove ${ref} from the stash stack.`,
    icon: "trash-2",
    confirmLabel: "Drop",
    danger: true
  });
  if (!confirmed) return;
  const repo = await runActionDialog({
    eyebrow: "Stash",
    runningTitle: "Dropping stash...",
    runningMessage: `Removing ${ref} from the stash stack.`,
    successTitle: "Stash dropped",
    successMessage: `${ref} was removed.`,
    successToast: "Stash dropped.",
    icon: "trash-2",
    task: () => request("/api/repo/stash/drop", {
      method: "POST",
      body: JSON.stringify({ path: state.repoPath, ref })
    })
  });
  if (!repo) return;
  applyRepoSnapshot(repo, { source: "action" });
}

async function runRepoAction(action) {
  if (!state.repoPath) return showToast("Open a repository first.");
  const config = {
    fetch: {
      title: "Fetch from remote",
      message: "Fetch all remotes and prune deleted remote refs.",
      icon: "download-cloud",
      confirmLabel: "Fetch",
      runningTitle: "Fetching...",
      runningMessage: "Checking the remote and updating local remote refs.",
      successTitle: "Fetch complete",
      successMessage: "Remote refs are updated locally.",
      successToast: "Fetch complete."
    },
    pull: {
      title: "Pull latest commits?",
      message: "Pull with fast-forward only. This can update files in the opened local repository.",
      icon: "arrow-down-to-line",
      confirmLabel: "Pull",
      runningTitle: "Pulling latest commits...",
      runningMessage: "Fast-forwarding your current branch if the remote has newer commits.",
      successTitle: "Pull complete",
      successMessage: "The graph has been updated with the latest local commits.",
      successToast: "Pull complete."
    },
    push: {
      title: "Push current branch?",
      message: "Push your local commits to the configured remote for this branch.",
      icon: "arrow-up-from-line",
      confirmLabel: "Push",
      runningTitle: "Pushing commits...",
      runningMessage: "Sending your local commits to the configured Git remote.",
      successTitle: "Push complete",
      successMessage: "Your commits were pushed and the local graph is refreshed.",
      successToast: "Push complete."
    }
  }[action];
  if (!config) return showToast("Unsupported Git action.");

  const confirmed = await confirmAction({ eyebrow: "Git Remote", ...config });
  if (!confirmed) return;
  const payload = await runActionDialog({
    eyebrow: "Git Remote",
    icon: config.icon,
    runningTitle: config.runningTitle,
    runningMessage: config.runningMessage,
    successTitle: config.successTitle,
    successMessage: config.successMessage,
    successToast: config.successToast,
    task: () => request("/api/repo/action", {
      method: "POST",
      body: JSON.stringify({ path: state.repoPath, action })
    })
  });
  if (!payload) return;
  applyRepoSnapshot(payload.repo, { source: "action" });
}

function bindEvents() {
  document.addEventListener("error", (event) => {
    const image = event.target?.closest?.(".graph-node img");
    if (!image) return;
    const fallback = image.dataset.fallbackAvatar;
    if (fallback && image.getAttribute("src") !== fallback) image.setAttribute("src", fallback);
  }, true);

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".commit-context-menu")) hideCommitContextMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideCommitContextMenu();
      if (!$("#actionDialog").hidden) cancelActionDialog();
    }
  });

  window.addEventListener("wheel", rememberContextMenuWheel, true);
  window.addEventListener("scroll", handleContextMenuScroll, true);
  window.addEventListener("beforeunload", stopRepoLiveSync);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.repoPath) refreshRepo({ silent: true, source: "poll" }).catch(() => {});
  });

  $("#actionDialogCancel").addEventListener("click", cancelActionDialog);
  $("#actionDialogClose").addEventListener("click", cancelActionDialog);
  $("#actionDialogConfirm").addEventListener("click", confirmActionDialog);
  $("#actionDialogInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    confirmActionDialog();
  });

  commitContextMenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-commit-action]");
    if (!button) return;
    handleCommitContextAction(button.dataset.commitAction, button.dataset.commitHash).catch((error) => showToast(error.message));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveCurrentProfile();
    } catch (error) {
      showToast(error.message);
    }
  });

  $("#accountButton").addEventListener("click", () => {
    $("#accountMenu").hidden = !$("#accountMenu").hidden;
  });

  $("#addAccountMenuButton").addEventListener("click", () => {
    state.selectedId = "";
    fillForm();
    $("#accountMenu").hidden = true;
    $("#accountEditorPanel").hidden = false;
  });

  $("#closeAccountEditor").addEventListener("click", () => {
    $("#accountEditorPanel").hidden = true;
  });

  accountMenuProfiles.addEventListener("click", async (event) => {
    const card = event.target.closest("[data-id]");
    const activate = event.target.closest("[data-activate]");
    if (!card) return;
    state.selectedId = card.dataset.id;
    renderProfiles();
    fillForm(selectedProfile());
    if (!activate) $("#accountEditorPanel").hidden = false;
    if (activate) {
      try {
        await activateProfile(activate.dataset.activate);
      } catch (error) {
        showToast(error.message);
      }
    }
  });

  $("#activateButton").addEventListener("click", () => activateProfile().catch((error) => showToast(error.message)));
  $("#deleteButton").addEventListener("click", () => deleteCurrentProfile().catch((error) => showToast(error.message)));
  $("#newRepoTabButton").addEventListener("click", () => openRepoDialog("local"));
  $("#closeRepoDialog").addEventListener("click", () => {
    $("#repoDialog").hidden = true;
  });
  $("#localRepoDialogTab").addEventListener("click", () => setRepoDialogMode("local"));
  $("#cloneRepoDialogTab").addEventListener("click", () => setRepoDialogMode("clone"));
  $("#addRepoButton").addEventListener("click", () => addRepo().catch((error) => showToast(error.message)));
  $("#cloneRepoButton").addEventListener("click", () => cloneRepo().catch((error) => showToast(error.message)));
  $("#pathUpButton").addEventListener("click", () => {
    const current = $("#pathBrowserCurrent").textContent;
    const parent = current.split("/").slice(0, -1).join("/") || "/";
    browsePath(parent).catch((error) => showToast(error.message));
  });
  $("#fetchButton").addEventListener("click", () => runRepoAction("fetch").catch((error) => showToast(error.message)));
  $("#pullButton").addEventListener("click", () => runRepoAction("pull").catch((error) => showToast(error.message)));
  $("#pushButton").addEventListener("click", () => runRepoAction("push").catch((error) => showToast(error.message)));
  $("#undoButton").addEventListener("click", () => showToast("Undo history is ready visually; Git reset is intentionally manual for now."));
  $("#redoButton").addEventListener("click", () => showToast("Redo history is ready visually; no destructive Git action ran."));
  $("#stashQuickButton").addEventListener("click", () => quickStash().catch((error) => showToast(error.message)));
  $("#popQuickButton").addEventListener("click", () => applyStash("stash@{0}", true).catch((error) => showToast(error.message)));
  $("#createBranchButton").addEventListener("click", () => createBranch().catch((error) => showToast(error.message)));
  $("#stashButton").addEventListener("click", () => stashChanges().catch((error) => showToast(error.message)));

  repoTabs.addEventListener("click", (event) => {
    if (event.target.closest("[data-open-repo-dialog]")) return openRepoDialog("local");
    const closeButton = event.target.closest("[data-close-repo-tab]");
    if (closeButton) {
      event.stopPropagation();
      return closeRepoTab(closeButton.dataset.closeRepoTab).catch((error) => showToast(error.message));
    }
    const tab = event.target.closest("[data-repo-path]");
    if (tab) openRepo(tab.dataset.repoPath).catch((error) => showToast(error.message));
  });

  repoTabs.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const tab = event.target.closest("[data-repo-path]");
    if (!tab || event.target.closest("[data-close-repo-tab]")) return;
    event.preventDefault();
    openRepo(tab.dataset.repoPath).catch((error) => showToast(error.message));
  });

  repoList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-repo-path]");
    if (row) openRepo(row.dataset.repoPath).catch((error) => showToast(error.message));
  });

  $("#pathBrowserList").addEventListener("click", (event) => {
    const browse = event.target.closest("[data-browse-path]");
    const select = event.target.closest("[data-select-path]");
    if (browse) browsePath(browse.dataset.browsePath).catch((error) => showToast(error.message));
    if (select) {
      if (state.browserTarget === "local") $("#localPathInput").value = select.dataset.selectPath;
      else $("#cloneDestination").value = select.dataset.selectPath;
    }
  });

  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-nav]").forEach((item) => item.classList.toggle("is-active", item === button));
      const target = $(`#${button.dataset.nav}Panel`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  $("#branchButton").addEventListener("click", () => {
    $("#branchMenu").hidden = !$("#branchMenu").hidden;
  });

  $("#toolbarBranchList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-checkout]");
    if (!button) return;
    $("#branchMenu").hidden = true;
    if (!button.classList.contains("is-current")) checkoutBranch(button.dataset.checkout).catch((error) => showToast(error.message));
  });

  $("#localBranchList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-checkout]");
    if (button && !button.classList.contains("is-current")) checkoutBranch(button.dataset.checkout).catch((error) => showToast(error.message));
  });

  $("#fileList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-file]");
    const commitFile = event.target.closest("[data-commit-file]");
    if (commitFile) loadCommitFileDiff(commitFile.dataset.commitFile).catch((error) => showToast(error.message));
    if (button) loadDiff(button.dataset.file).catch((error) => showToast(error.message));
  });

  $("#commitGraph").addEventListener("dblclick", (event) => {
    const branch = event.target.closest("[data-graph-branch]");
    if (!branch) return;
    event.preventDefault();
    event.stopPropagation();
    const branchName = branch.dataset.graphBranch || "";
    const localName = branchName.replace(/^origin\//, "");
    const target = state.repo?.branches.some((item) => item.name === branchName) ? branchName : localName;
    const canCheckout = state.repo?.branches.some((item) => item.name === target);
    if (!canCheckout) return showToast(`${branchName} needs a local tracking branch before checkout.`);
    return checkoutBranch(target).catch((error) => showToast(error.message));
  });

  $("#commitGraph").addEventListener("click", (event) => {
    if (event.target.closest("[data-graph-branch]")) return;
    const graphStash = event.target.closest("[data-graph-stash]");
    const graphApply = event.target.closest("[data-stash-apply]");
    const graphPop = event.target.closest("[data-stash-pop]");
    if (graphStash) return quickStash().catch((error) => showToast(error.message));
    if (graphApply) return applyStash(graphApply.dataset.stashApply, false).catch((error) => showToast(error.message));
    if (graphPop) return applyStash(graphPop.dataset.stashPop, true).catch((error) => showToast(error.message));

    const wip = event.target.closest("[data-wip-row]");
    if (wip) {
      state.inspectorOpen = false;
      state.centerMode = "worktree";
      state.selectedCommitFile = "";
      renderRightFileList();
      renderCommitGraph();
      renderInspectorMode();
      iconRefresh();
      showToast("Working tree selected.");
      return;
    }

    const row = event.target.closest("[data-commit]");
    if (row) loadCommitDetails(row.dataset.commit, false, false).catch((error) => showToast(error.message));
  });

  $("#commitGraph").addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const row = event.target.closest("[data-commit]");
    if (!row) return;
    event.preventDefault();
    loadCommitDetails(row.dataset.commit, false, false).catch((error) => showToast(error.message));
  });

  $("#commitGraph").addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-commit]");
    if (!row) return;
    const commit = commitByHash(row.dataset.commit);
    showCommitContextMenu(event, commit);
  });

  $("#commitFiles").addEventListener("click", (event) => {
    const resolve = event.target.closest("[data-conflict-resolve]");
    if (resolve) {
      resolveConflict(resolve.dataset.conflictFile, resolve.dataset.conflictResolve).catch((error) => showToast(error.message));
      return;
    }
    const row = event.target.closest("[data-commit-file]");
    if (row) loadCommitFileDiff(row.dataset.commitFile).catch((error) => showToast(error.message));
  });

  $("#commitPatch").addEventListener("click", (event) => {
    const resolve = event.target.closest("[data-conflict-resolve]");
    if (!resolve) return;
    resolveConflict(resolve.dataset.conflictFile, resolve.dataset.conflictResolve).catch((error) => showToast(error.message));
  });

  $("#fitGraphButton").addEventListener("click", () => {
    const graph = $("#commitGraph");
    graph.scrollTop = 0;
    graph.scrollLeft = 0;
    showToast("Graph reset to the latest commit.");
  });

  $("#backToGraphButton").addEventListener("click", () => {
    state.inspectorOpen = false;
    state.centerMode = "graph";
    state.selectedCommitFile = "";
    renderRightFileList();
    renderCommitGraph();
    renderInspectorMode();
    iconRefresh();
    showToast("Back to graph.");
  });

  $("#stashList").addEventListener("click", (event) => {
    const apply = event.target.closest("[data-stash-apply]");
    const pop = event.target.closest("[data-stash-pop]");
    const drop = event.target.closest("[data-stash-drop]");
    if (apply) applyStash(apply.dataset.stashApply, false).catch((error) => showToast(error.message));
    if (pop) applyStash(pop.dataset.stashPop, true).catch((error) => showToast(error.message));
    if (drop) dropStash(drop.dataset.stashDrop).catch((error) => showToast(error.message));
  });

  $("#refreshButton").addEventListener("click", async () => {
    try {
      await Promise.all([loadStatus(), refreshRepo()]);
      showToast("Refreshed.");
    } catch (error) {
      showToast(error.message);
    }
  });
}

async function boot() {
  bindEvents();
  if (location.protocol === "file:") {
    $("#fileModeBanner").hidden = false;
    state.activeIdentity = "Open localhost first";
    renderProfiles();
    showToast("Open http://localhost:4173 so Git actions can work.");
    iconRefresh();
    return;
  }

  try {
    await Promise.all([loadProfiles(), loadStatus(), loadRepos()]);
    const rememberedRepo = state.repos.some((repo) => repo.root === state.repoPath) ? state.repoPath : "";
    const initialRepo = rememberedRepo || state.repos[0]?.root || "";
    if (initialRepo) await openRepo(initialRepo);
    else clearRepoView();
  } catch (error) {
    showToast(error.message);
  }
  iconRefresh();
}

boot();
