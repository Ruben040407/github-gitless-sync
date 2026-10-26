# Switching from GitHub Gitless Sync 1.0.7 to the fork

Order: **PC → laptop → phone**, all on the same day. Don't edit notes in between.
The fork keeps the same plugin id, so your token, repo and interval settings stay.

## 0. Backup (PC)

```powershell
Compress-Archive -Path C:\Users\Ruben\ObsidianVault -DestinationPath C:\Users\Ruben\ObsidianVault-backup-2026-10-26.zip
```

The repo history on GitHub is the second backup: every past version of every note is there.

## 1. Install on each device (PC first, then laptop, then phone)

1. Settings → Community plugins → Browse → install and enable **BRAT**
   ("Obsidian42 - BRAT").
2. Settings → BRAT → **Add beta plugin** → enter `Ruben040407/github-gitless-sync`,
   version *Latest* → **Add plugin**. BRAT overwrites the 1.0.7 files in
   `.obsidian/plugins/github-gitless-sync/` and keeps `data.json` (your settings).
3. Settings → Community plugins: the plugin is now called
   **GitHub Gitless Sync (3-way fork)**, version **2.1.0** or newer, and is enabled.
   If it still says 1.0.7, restart Obsidian.
4. Tap the sync icon (ribbon) once.
5. Settings → GitHub Gitless Sync: check **Sync after editing** is on (delay 5 s)
   and **Sync on startup** is on. Keep the 5-minute interval: it picks up the other
   devices' edits while you're only reading.

### What to check after the first sync on each device

- A "Sync successful" notice, no "Error syncing" notice.
- `.obsidian/github-sync-state.json` now exists (this device's own sync record).
- On the PC (first device) with all notes in sync, nothing changes and no new commit
  appears on GitHub. On a device with unsynced edits you'll see a commit
  "Sync: N changed".
- If the **conflict view** opens: that note differs between this device and GitHub.
  Pick what to keep; the other version stays in the GitHub history anyway.
- The first sync never deletes anything. If a note you had deleted earlier comes
  back (because another device still had it), just delete it again.

## 2. Final check (after all three are switched)

1. PC: create `sync-test.md` with some text, sync.
2. Phone: sync → the note appears. Edit it, sync.
3. PC: sync → the edit is there. Sync again → the edit is still there.
4. Laptop: sync, delete the note, sync.
5. PC and phone: sync → the note is gone (a copy is in the vault's `.trash` folder).

## 3. Optional cleanup (after a week without problems)

The old shared file `.obsidian/github-sync-metadata.json` is no longer used. Once you
don't want to roll back anymore, delete it on github.com (repo → `.obsidian` folder →
file → Delete) and from `.obsidian/` on each device.

## Rollback to 1.0.7 (per device)

1. Settings → BRAT → beta plugin list → remove `Ruben040407/github-gitless-sync`
   (otherwise BRAT updates it back).
2. BRAT → **Add beta plugin with frozen version** → `silvanocerza/github-gitless-sync`,
   version `1.0.7`. This puts upstream 1.0.7 back and keeps your settings.
   (Alternative: uninstall, reinstall from Community plugins, re-enter the token.)
3. If anything is missing, restore it from the backup zip or the GitHub history.

Caveat: 1.0.7 continues from its own old metadata file, which the fork left untouched.
It won't know about notes created while the fork was installed, and it brings back
all of 1.0.7's bugs.
