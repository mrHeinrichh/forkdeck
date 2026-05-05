const initialState = {
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

function createStore(seed) {
  const listeners = new Set();
  const state = {
    ...seed,
    profiles: [...seed.profiles],
    repos: [...seed.repos],
    selectedCommitFiles: [...seed.selectedCommitFiles]
  };

  function notify() {
    for (const listener of listeners) listener(state);
  }

  return {
    state,
    patch(values) {
      Object.assign(state, values);
      notify();
      return state;
    },
    set(key, value) {
      state[key] = value;
      notify();
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export const store = createStore(initialState);
export const state = store.state;
