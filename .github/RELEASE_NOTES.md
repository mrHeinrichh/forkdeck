ForkDeck is now a standalone desktop app for macOS and Windows, with its own bundled runtime, native folder selection, offline icons, and protected local Git API.

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
