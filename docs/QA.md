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

Unavailable in this release: undo/redo, merge/rebase/cherry-pick/reset/revert commands, worktree creation, cloud patches, commit comparison, GitHub PR/issue/team views. Unsupported context-menu commands are omitted; reserved toolbar/navigation controls are disabled and labelled unavailable.
