export function createActionDialog({ state, $, iconRefresh, escapeHtml, showToast }) {
const dialogElement = $("#actionDialog");
const document = dialogElement.ownerDocument;
let backgroundState = null;
let previousFocus = null;

function isolateDialog() {
  if (backgroundState) return;
  previousFocus = document.activeElement;
  const background = [...dialogElement.parentElement.children, $("#commitContextMenu")]
    .filter((element) => element && element !== dialogElement);
  backgroundState = new Map(background.map((element) => [element, element.inert]));
  for (const element of backgroundState.keys()) element.inert = true;
}

function focusDialog(mode, hasInput) {
  const panel = $("#actionDialogPanel");
  panel.setAttribute("tabindex", "-1");
  if (mode === "running") panel.focus();
  else if (hasInput) {
    $("#actionDialogInput").focus();
    $("#actionDialogInput").select();
  } else if (mode === "confirm") $("#actionDialogCancel").focus();
  else $("#actionDialogConfirm").focus();
}

dialogElement.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || dialogElement.hidden) return;
  const focusable = [...dialogElement.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.closest("[hidden]") && element.getClientRects().length);
  if (!focusable.length) {
    event.preventDefault();
    $("#actionDialogPanel").focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
});

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
  isolateDialog();
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
  }
  output.hidden = !options.output;
  output.textContent = options.output || "";
  cancel.hidden = mode !== "confirm";
  confirm.disabled = mode === "running";
  $("#actionDialogClose").disabled = mode === "running";
  confirm.textContent = mode === "confirm" ? (options.confirmLabel || "Run") : mode === "running" ? "Running..." : "Close";
  confirm.classList.toggle("is-danger-action", Boolean(options.danger));
  confirm.classList.toggle("accent", !options.danger);
  iconRefresh();
  focusDialog(mode, Boolean(options.input));
}

function closeActionDialog(result = false) {
  clearTimeout(state.actionDialogAutoClose);
  $("#actionDialog").hidden = true;
  if (backgroundState) {
    for (const [element, inert] of backgroundState) element.inert = inert;
    backgroundState = null;
  }
  if (previousFocus?.isConnected && !previousFocus.closest("[hidden], [inert]")) previousFocus.focus();
  previousFocus = null;
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
  if (state.repoActionInFlight) return null;
  state.repoActionInFlight = true;
  state.repoMutationVersion = (state.repoMutationVersion || 0) + 1;
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
    state.repoMutationVersion = (state.repoMutationVersion || 0) + 1;
    state.repoActionInFlight = false;
  }
}

  return {
    setActionDialog,
    closeActionDialog,
    confirmAction,
    promptAction,
    confirmActionDialog,
    cancelActionDialog,
    runActionDialog
  };
}
