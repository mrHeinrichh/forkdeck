# ForkDeck QA coverage

All mutation checks use disposable repositories and an isolated Git configuration. Authentication checks simulate GitHub CLI responses and exercise a real local Git credential helper; they do not change the developer's signed-in accounts or push to real projects.

| Area | Checks / observable result | Evidence |
| --- | --- | --- |
| Repository library | Add, reject invalid path, select, close without deleting, reopen, concurrent saves | Git/API regressions + interactive UI |
| Folder browser / clone | Browse, parent, local/clone switch, invalid URL/destination, successful clone | API regressions + UI; native picker policy |
| Identity | Create/edit/delete, validate fields, activate only for selected repo, actual commit author, unchanged global config | Profile regressions + UI |
| History | Graph, branch pills, fit, selection, changed files, empty/root/merge commits, details and patches | Git regressions + UI |
| Diffs | Untracked, staged + unstaged, deleted, renamed, binary, unusual names, live refresh | Git regressions + UI |
| Branches/tags | Create, checkout, remote tracking, lightweight/annotated tag, invalid names | Git regressions + UI |
| Stashes | Include untracked, apply, pop, drop, no stash, conflict/error | Git regressions + UI |
| Remotes | Fetch, fast-forward pull, push, missing upstream, failed action feedback | Local bare remote regressions + UI |
| Conflicts | Read each side, current/incoming including deleted side, mark resolved, invalid file/action | Git regressions + UI |
| Auth | Preflight, HTTPS/SSH distinction, effective account checks, credential redaction | Isolated auth regressions; real external account switching excluded |
| Desktop | Startup, sandbox, local API token, external URLs, clipboard, preferences across restarts, writable data | Native smoke + policy regressions |
| Interface | Loading/empty/error states, rapid selection races, viewport 960×640 and 1440×960, dialogs, disabled unavailable controls | Browser checks/screenshots + native smoke |
| Packaging | macOS arm64/x64 and Windows x64 installable builds and launch checks | Release workflow |

## Version 1.2 workflow inventory

| Control / claim | Functional check | Visual / recovery check |
| --- | --- | --- |
| Unstaged / staged file groups; single/all stage and unstage | Actual index contents including unborn repos, rename/deletion/literal filenames; preserve working edits | Empty groups, mixed staged/unstaged file appears in both groups, buttons stay usable |
| Commit composer / Cmd or Ctrl+Enter / amend | Commit only staged content; prefill original message; preserve authorship; reject stale HEAD | Empty-message guard, per-repository drafts, explicit amend confirmation |
| Merge / rebase toolbar and commit context commands | Fast-forward/diverged merges and rebase; regular cherry-pick/revert | Clean-worktree rejection, conflicts return a visible operation banner |
| Conflict Continue / Abort | Every operation tested through conflict, resolution, continuation and abort | Rebase sides accurately labelled; empty cherry-pick cannot falsely continue |
| Rename / delete branch | Rename current and other branches; refuse unmerged or checked-out deletion | Accessible branch controls and confirmation |
| Search loaded history | Message, author, hash and ref filtering over latest 120 commits | Matching count, no results, no misleading graph lines on filtered results |
| Compare refs dialog | Exact-tree patch, changed files, renamed paths and divergence; bounded output | Error, identical trees, keyboard close and focus |
| Dense desktop layout | Existing browser and native smoke suites still pass | Independent scroll, 960×640 and 1440×900, composer visible and no horizontal page overflow |

UI automation lives in `scripts/test-ui.js` and `scripts/test-workspace-ui.js`. New server regressions live in `tests/commit-workflows.test.js` and `tests/history-workflows.test.js`. Off-happy-path cases include stale HEAD during amend, literal pathspec characters, dirty worktree rejection, empty cherry-pick, and a rebase that pauses at multiple conflicts.

Not implemented: line/hunk staging, interactive rebase, merge-commit cherry-pick/revert, undo/redo, reset, worktree creation, cloud patches, GitHub PR/issue/team views. External authenticated network operations continue to use local bare remote fixtures in tests.
