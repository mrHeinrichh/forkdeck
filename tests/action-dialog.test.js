const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function makeDialog() {
  const source = await fs.readFile(path.join(__dirname, "../public/src/ui/actionDialog.js"), "utf8");
  const { createActionDialog } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const document = { activeElement: null };
  const elements = new Map();
  function element(id, parent = null) {
    const target = {
      id, parentElement: parent, ownerDocument: document, children: [], dataset: {}, hidden: false,
      inert: false, disabled: false, isConnected: true, value: "", handlers: {}, classList: { toggle() {} },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, listener) { this.handlers[name] = listener; },
      closest(selector) {
        let current = this;
        while (current) {
          if ((selector.includes("[hidden]") && current.hidden) || (selector.includes("[inert]") && current.inert)) return current;
          current = current.parentElement;
        }
        return null;
      },
      focus() { if (!this.closest("[hidden], [inert]")) document.activeElement = this; },
      select() { this.selected = true; },
      getClientRects() { return this.closest("[hidden]") ? [] : [{}]; }
    };
    if (parent) parent.children.push(target);
    elements.set(`#${id}`, target);
    return target;
  }
  const main = element("main");
  const background = element("background", main);
  const alreadyInert = element("alreadyInert", main);
  alreadyInert.inert = true;
  const opener = element("opener", background);
  opener.focus();
  const menu = element("commitContextMenu");
  const dialog = element("actionDialog", main);
  dialog.hidden = true;
  const panel = element("actionDialogPanel", dialog);
  for (const id of ["actionDialogIcon", "actionDialogOutput", "actionDialogEyebrow", "actionDialogTitle", "actionDialogMessage", "actionDialogClose", "actionDialogCancel", "actionDialogConfirm"]) element(id, panel);
  const inputWrap = element("actionDialogInputWrap", panel);
  element("actionDialogInputLabel", inputWrap);
  const input = element("actionDialogInput", inputWrap);
  const $ = (id) => elements.get(id);
  const close = $("#actionDialogClose");
  const cancel = $("#actionDialogCancel");
  const confirm = $("#actionDialogConfirm");
  dialog.querySelectorAll = () => [close, input, cancel, confirm].filter((item) => !item.disabled);
  const state = { repoActionInFlight: false, repoMutationVersion: 0 };
  const messages = [];
  const actions = createActionDialog({ state, $, iconRefresh() {}, escapeHtml: String, showToast: (text) => messages.push(text) });
  function tab(shiftKey = false) {
    let prevented = false;
    dialog.handlers.keydown({ key: "Tab", shiftKey, preventDefault() { prevented = true; } });
    return prevented;
  }
  return { ...actions, state, document, dialog, panel, input, opener, background, alreadyInert, menu, close, cancel, confirm, messages, tab };
}

test("confirmation isolates background, traps keyboard focus, and restores prior state on cancellation", async () => {
  const ui = await makeDialog();
  const confirmation = ui.confirmAction({ title: "Delete profile?" });
  assert.equal(ui.document.activeElement, ui.cancel);
  assert.equal(ui.background.inert, true);
  assert.equal(ui.menu.inert, true);
  ui.opener.focus();
  assert.equal(ui.document.activeElement, ui.cancel, "background controls must not receive focus");
  ui.confirm.focus();
  assert.equal(ui.tab(), true);
  assert.equal(ui.document.activeElement, ui.close);
  assert.equal(ui.tab(true), true);
  assert.equal(ui.document.activeElement, ui.confirm);
  ui.cancelActionDialog();
  assert.equal(await confirmation, false);
  assert.equal(ui.dialog.hidden, true);
  assert.equal(ui.background.inert, false);
  assert.equal(ui.menu.inert, false);
  assert.equal(ui.alreadyInert.inert, true);
  assert.equal(ui.document.activeElement, ui.opener);
});

test("prompt selects its input and replacement confirmation settles previous prompt", async () => {
  const ui = await makeDialog();
  const first = ui.promptAction({ inputValue: "old" });
  assert.equal(ui.document.activeElement, ui.input);
  assert.equal(ui.input.selected, true);
  const second = ui.promptAction({ inputValue: "  new-branch  " });
  assert.equal(await first, null);
  ui.confirmActionDialog();
  assert.equal(await second, "new-branch");
  assert.equal(ui.document.activeElement, ui.opener);
});

test("running actions cannot overlap or close, and completion invalidates older snapshots", async () => {
  const ui = await makeDialog();
  let finish;
  let runs = 0;
  const task = () => { runs++; return new Promise((resolve) => { finish = resolve; }); };
  const result = ui.runActionDialog({ task });
  assert.equal(ui.document.activeElement, ui.panel);
  assert.equal(ui.state.repoActionInFlight, true);
  assert.equal(ui.state.repoMutationVersion, 1);
  assert.equal(ui.tab(), true);
  assert.equal(ui.document.activeElement, ui.panel);
  ui.cancelActionDialog();
  ui.confirmActionDialog();
  assert.equal(ui.dialog.hidden, false);
  assert.equal(await ui.runActionDialog({ task }), null);
  assert.equal(runs, 1);
  finish({ output: "Finished" });
  assert.deepEqual(await result, { output: "Finished" });
  assert.equal(ui.state.repoActionInFlight, false);
  assert.equal(ui.state.repoMutationVersion, 2);
  assert.equal(ui.document.activeElement, ui.confirm);
  assert.equal(ui.background.inert, true);
  ui.confirmActionDialog();
  assert.equal(ui.document.activeElement, ui.opener);
  assert.equal(ui.background.inert, false);
});

test("failed operations keep errors focused and release background on close even without original opener", async () => {
  const ui = await makeDialog();
  const result = await ui.runActionDialog({ task: async () => { throw new Error("Git rejected the operation"); } });
  assert.equal(result, null);
  assert.equal(ui.dialog.dataset.mode, "error");
  assert.equal(ui.document.activeElement, ui.confirm);
  assert.equal(ui.state.repoActionInFlight, false);
  assert.equal(ui.state.repoMutationVersion, 2);
  assert.deepEqual(ui.messages, ["Git rejected the operation"]);
  ui.opener.isConnected = false;
  ui.closeActionDialog();
  assert.equal(ui.background.inert, false);
});
