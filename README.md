# ForkDeck

A local visual Git workspace for macOS and Windows. Explore commit history, work with branches and stash entries, review diffs, and switch commit identities.

## Download

Visit the [download website](https://forkdeck.vercel.app), or download installers from [GitHub Releases](https://github.com/mrHeinrichh/forkdeck/releases/latest). Each release includes SHA-256 checksums.

| Platform | Installer | Requirements |
| --- | --- | --- |
| macOS Apple Silicon | ARM64 `.dmg` or `.zip` | macOS 13 Ventura or newer |
| macOS Intel | x64 `.dmg` or `.zip` | macOS 13 Ventura or newer |
| Windows | x64 `.exe` installer | Windows 10 or 11, Intel/AMD 64-bit |

Install [Git](https://git-scm.com/downloads) before opening a repository. [GitHub CLI](https://cli.github.com/) is optional; it is required for the GitHub authentication repair feature. The desktop app includes its own Node.js runtime. Windows on ARM is not a native target of this release.

On macOS, open the disk image and drag ForkDeck to Applications. On Windows, run the installer. These community builds are not Apple notarized or signed with a Windows publisher certificate. The operating system may require approval for an unknown developer. Only approve a release you trust, and verify its checksum when needed.

## Develop

Use Node.js 22 or newer:

```sh
npm ci
npm run desktop
```

To use the browser version:

```sh
npm start
```

Open `http://127.0.0.1:4173`. Git operations run locally. Repository paths and profiles are kept in your operating system's application-data folder, outside the install directory. `FORKDECK_DATA_DIR` can override that location for isolated development or tests. Existing data from the old `data/*.json` launcher is not uploaded or included in installers.

## Validate and package

```sh
npm run check
npm test
npm run dist:mac
```

Windows installers are built on Windows with `npm run dist:win`. macOS installers are built on macOS. The GitHub Actions release workflow builds on native macOS and Windows runners, runs checks, and publishes installers with `SHA256SUMS.txt` after every platform succeeds. Push a version tag matching `package.json` (for example, `v1.1.0`) to publish a release.

## GitHub authentication repair

If a push reports access denied for the wrong GitHub account, the **Fix Auth** action checks your active GitHub CLI account and HTTPS credential helper. With an existing authenticated account, it can run `gh auth switch` and `gh auth setup-git`. Commit profiles change the repository's `user.name` and `user.email`; they do not independently grant remote access.

## Project layout

- `desktop/`: desktop window, native folder picker, and lifecycle management.
- `server/`: local HTTP API, Git commands, storage, and repository services.
- `public/`: the Git workspace interface and bundled UI assets.
- `website/`: the public download website, deployable to Vercel as static files.
- `.github/workflows/`: cross-platform validation and release packaging.
- `tests/`: local API and portability checks.

The download website can be deployed from `website/` with the Vercel CLI. Installers are served by GitHub Releases, so Vercel does not host the desktop application or access local repositories.

## License

[MIT](LICENSE).
