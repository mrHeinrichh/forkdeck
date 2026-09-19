ForkDeck 1.1.3 fixes issues found during a full pass through the existing Git, identity, desktop, and interface workflows.

## Fixes

- Commit profiles apply only to the selected repository; global Git identity remains unchanged.
- New files and staged/unstaged changes display correctly, including unusual filenames, deleted files, and merge commits.
- Remote checkout creates tracking branches; pushing a new branch configures its upstream.
- Merge conflict resolution handles deleted sides; stash actions include a visible Drop control, and helper commits no longer clutter the graph.
- Repository/folder selections persist across desktop restarts. Concurrent saves preserve all changes.
- Small windows fit, empty commits stop loading correctly, and stale requests cannot replace a newer selection or Git action.
- GitHub auth diagnostics check the actual push remote and effective account, and hide credentials.
- Unsupported actions are no longer presented as working commands.

## Verification

Real Git regression tests use disposable repositories and local bare remotes. Browser tests use real interface clicks. Native packaged launch checks run on macOS Apple silicon, macOS Intel, and Windows x64. External GitHub account changes are simulated in tests; native folder-dialog results are stubbed.

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
