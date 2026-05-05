# ForkDeck

ForkDeck is a local visual Git workspace for switching commit identities, opening repositories, inspecting history, resolving conflicts, and managing stash entries from a GitKraken-style interface.

## Run Locally

```sh
npm start
```

Open `http://localhost:4173`.

## Project Shape

- `server/` contains the local Node server, API routes, Git commands, storage helpers, and response utilities.
- `public/src/` contains the browser app modules.
- `public/src/core/store.js` owns shared UI state.
- `public/src/services/api.js` wraps API requests.
- `public/src/ui/` contains UI helpers and dialog logic.
- `public/src/git/` contains graph constants and Git view helpers.
- `data/*.json` stores local machine profiles and repo paths, and stays ignored by Git.

## Demonstration Branch Strategy

This repository uses a simple feature-branch flow:

1. Start from `main`.
2. Create a focused branch like `feature/server-modules`.
3. Commit one focused change at a time.
4. Merge back to `main` with `--no-ff` so the Git graph keeps the branch shape.
5. Push `main` and feature branches so the remote history shows the strategy.

