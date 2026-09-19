ForkDeck 1.2.0 brings a redesigned desktop workspace and complete everyday Git workflows.

## New workflows

- Compact three-panel interface with independently scrolling history, navigation and changes.
- Staged and unstaged file groups, individual/all staging and unstaging, and a commit composer with a keyboard shortcut.
- Amend the latest commit with a confirmation, message prefill and stale-HEAD protection.
- Merge, rebase, cherry-pick and revert from toolbar or commit context actions.
- Conflict recovery with Continue/Abort controls and accurate rebase-side labels.
- Rename local branches and safely delete fully merged branches.
- Search loaded commit history and compare the trees at any two branches, tags or commits.
- Repository-specific commit drafts remain available while the app stays open.

## Verification

Actual Git tests use disposable repositories and local bare remotes. Browser checks exercise the controls and conflict states. Packaged app launch checks run natively on Apple silicon, Intel macOS, and Windows x64. The full UI suite runs on Linux Chromium. No private profiles or repositories are packaged.

Line/hunk staging, interactive rebase, merge-commit cherry-pick/revert, undo/redo, worktree creation and GitHub PR/issue/team views remain outside this release. Rebase and amend rewrite commits; use them for unpublished work.

## Downloads

- **Mac with Apple silicon:** choose `mac-arm64.dmg` (or `.zip`).
- **Mac with Intel:** choose `mac-x64.dmg` (or `.zip`).
- **Windows:** choose `win-x64.exe` and follow the installer.

Requires **macOS 13 or later** or **Windows 10/11 64-bit**. Install Git separately; GitHub CLI is optional for GitHub account detection and switching. Node.js is already included.

The macOS app is ad-hoc signed for bundle integrity but is not Apple notarized. The Windows installer is unsigned. macOS Gatekeeper or Windows SmartScreen may require an explicit confirmation before it opens. Verify the download source and the SHA256SUMS.txt checksum before continuing.

Profiles and the repository list are stored per user, outside the installed app. Builds do not contain the developer's local profiles or repositories.

Download website: https://forkdeck.vercel.app

## Author

Created by **[Heinric Fabros](https://mrheinrich.vercel.app/)**. Visit the [portfolio](https://mrheinrich.vercel.app/) for more about the author and their work.
