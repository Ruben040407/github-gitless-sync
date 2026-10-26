# Fork notes

Fork of [silvanocerza/github-gitless-sync](https://github.com/silvanocerza/github-gitless-sync)
v1.0.7 (unmaintained since May 2025). Plugin id is unchanged (`github-gitless-sync`)
so existing settings (`data.json`: token, owner, repo, branch) carry over.

## What changed and why

### Sync engine: per-device 3-way sync (`src/sync-plan.ts`, `src/sync-manager.ts`)

Upstream kept one shared `.obsidian/github-sync-metadata.json` in the repo that every
device overwrote with its own copy (last writer wins). A stale device re-poisoned it,
and every decision was based on it instead of on the actual repo content. That caused:

- deletions not reaching devices whose copy was unchanged (everything was gated by
  `remote.sha !== localSHA`, so `deleted` was never looked at), and those devices later
  re-announcing the file;
- `TypeError: Cannot set properties of undefined (setting 'sha')` when the metadata
  listed a file the git tree didn't have (upstream #21, #60; PRs #28/#52 only add guards);
- remote edits made outside the plugin being ignored (#45);
- an empty "Sync" commit on every interval tick, since the metadata always changed (#63).

Now each device keeps its own record of the last successful sync in
`.obsidian/github-sync-state.json` (never uploaded): for every file the blob SHA it
had locally and the blob SHA it had remotely. Each sync compares, per file:

| local vs record | remote vs record | action |
|---|---|---|
| same | same | nothing |
| changed / new | same | upload |
| deleted | same | delete remote |
| same | changed / new | download |
| same | deleted | delete local (moved to `.trash`) |
| changed | changed | conflict view (or nothing if both are identical) |
| changed | deleted (or the reverse) | keep the edited version |
| deleted | deleted | forget |

The remote side is always the real git tree of the branch, never a metadata file.
Renames are a delete plus a create. Unknown or missing entries can't crash anything,
every path is just looked up in three maps.

The pure decision function is `decide()` in `src/sync-plan.ts`.

### Other fixes

- **Edits reverted by the next sync (#37).** Cause: on desktop, Obsidian's `requestUrl`
  goes through Electron's `net.request` with the default HTTP cache (checked in
  Obsidian 1.14.5's code), and GitHub marks API responses cacheable for 60 s. So a
  sync within a minute of a push could read the pre-push `git/trees/main` and
  "download" the old file. Now the branch read is cache-busted, and if the branch is
  *behind* the commit this device last synced, the plugin waits and re-reads instead
  of acting on it. PR #38 (compare `lastModified` timestamps) was not used: clocks
  differ between devices.
- **Concurrent pushes.** Upstream committed on top of the *current* head with a tree
  built from an *older* read, silently undoing another device's push made in between.
  Now the commit's parent is the commit that was read, the ref update is not forced,
  and a rejected push restarts the sync. Nothing changes locally until the push succeeded.
- **Exact bytes.** Text files are only sent inline when they decode as UTF-8 exactly
  (BOM and CRLF preserved), otherwise as base64 blobs. After pushing, the real blob
  SHAs are read back from the new tree.
- **Local deletions are recoverable:** files deleted because they were deleted on
  another device go to the vault's `.trash` folder; emptied folders are removed.
- **Edits during a sync are not overwritten:** before replacing or deleting a local
  file it is re-hashed; if it changed since the scan it's left for the next sync.
- **Hidden files** (`.trash`, `.git`, `.DS_Store`, ...) are never synced, nor are
  `workspace*.json`, the log, the state file and the legacy metadata file.
- **"Sync on startup"** existed as a setting but did nothing upstream; it now syncs
  once when Obsidian has loaded.
- **Performance:** file hashes are cached by mtime and size (with git's "racy clean"
  rule: hashes taken within 2 s of the file's mtime are not trusted). Requests run
  at most 4 at a time instead of all at once (#13).
- Removed: the special first sync (zip download, "both remote and local have files"
  error), the vault events listener, the shared metadata store.
- Kept: GitHub client, conflict views, settings tab, ribbon icons, status bar,
  interval sync, mobile support.

### Migration from v1.0.7

On the first sync after switching there is no state file yet, so every file is "new
on both sides": identical files are just recorded, local-only files are uploaded,
remote-only files are downloaded, files that differ open the conflict view.
**Nothing is deleted or overwritten on the first sync.** The flip side: a file deleted
on one device while another device still has it comes back once; delete it again.

The old `.obsidian/github-sync-metadata.json` (local and in the repo) is never read,
written or deleted, so rolling back to v1.0.7 stays possible. Once every device runs
the fork and you don't want to roll back anymore, you can delete it on github.com
and locally.

## Build and test

```bash
npm ci
npm test          # unit tests + 25 multi-device scenarios against an in-memory GitHub fake
npm run build     # main.js
```

End-to-end against a real, **throwaway** repository (force-reset by every scenario):

```bash
GITHUB_TOKEN="$(gh auth token)" E2E_REPO=Ruben040407/gitless-sync-e2e-test npm run test:e2e
```

Scenarios live in `test/scenarios.ts` and run in both modes (a few need the fake to
simulate races). `E2E_ONLY=<part of a name>` runs a subset.

## Release

1. Bump `version` in `manifest.json`, `manifest-beta.json`, `package.json`, add it to `versions.json`.
2. Commit, then tag without a `v` prefix and push:
   ```bash
   git tag 2.0.1
   git push origin main 2.0.1
   ```
3. `.github/workflows/release.yml` tests, builds and creates the GitHub release with
   `main.js`, `manifest.json`, `styles.css`. BRAT picks it up on its next update check.

Remotes: `origin` = Ruben040407/github-gitless-sync, `upstream` = silvanocerza/github-gitless-sync.
