import {
  Vault,
  Notice,
  normalizePath,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from "obsidian";
import GithubClient, { NewTreeRequestItem } from "./github/client";
import SyncStateStore, {
  LEGACY_METADATA_FILE_NAME,
  STATE_FILE_NAME,
} from "./sync-state";
import { FileShas, gitBlobSha, mapLimit, planSync } from "./sync-plan";
import { GitHubSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import { decodeBase64String, hasTextExtension } from "./utils";

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

export type FileSyncStatus = "Untracked" | "Outdated" | "Up to date";

// Max number of GitHub requests or file reads in flight at once
const CONCURRENCY = 4;

// Cached hashes of files modified less than this before hashing are not trusted
const RACY_WINDOW_MS = 2000;

// Vault events this long after the plugin changed a file are its own
const OWN_WRITE_WINDOW_MS = 5000;

// How many times, and how long apart, to re-read a stale remote branch
const STALE_RETRIES = 3;
const STALE_RETRY_DELAY_MS = 2000;

// Committed when the remote repository is completely empty, since the Git
// Data API can't create trees in a repo without commits.
// It's hidden so it's never synced to the vault.
const INIT_FILE = ".gitless-sync";

// The branch moved between reading the remote and updating it,
// another device synced in the meantime.
class RemoteMovedError extends Error {}

interface RemoteState {
  commitSha: string;
  treeSha: string;
  files: FileShas;
}

/**
 * Decodes bytes as UTF-8 only if that round-trips exactly, so that uploading
 * the decoded string as tree content produces the same blob as the file.
 */
function decodeUtf8Exactly(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

export default class SyncManager {
  private state: SyncStateStore;
  private client: GithubClient;
  private syncIntervalId: number | null = null;

  // Use to track if syncing is in progress, this ideally
  // prevents multiple syncs at the same time and creation
  // of messy conflicts.
  private syncing: boolean = false;

  // Last error shown by an automatic sync, so being offline doesn't show
  // the same notice after every edit
  private lastQuietError: string | null = null;

  // Paths this plugin wrote or deleted, with the time. Vault events for these
  // must not trigger another sync.
  private ownWrites = new Map<string, number>();

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
  ) {
    this.state = new SyncStateStore(this.vault);
    this.client = new GithubClient(this.settings, this.logger);
  }

  async loadState() {
    await this.logger.info("Loading sync state");
    await this.state.load();
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  /** Time of the last successful sync, 0 if never */
  lastSyncTime(): number {
    return this.state.data.lastSync;
  }

  /**
   * True if the plugin itself changed this path in the last few seconds,
   * e.g. by downloading it.
   */
  isOwnChange(filePath: string): boolean {
    const time = this.ownWrites.get(filePath);
    return time !== undefined && Date.now() - time < OWN_WRITE_WINDOW_MS;
  }

  private markOwnWrite(filePath: string) {
    const now = Date.now();
    for (const [p, time] of this.ownWrites) {
      if (now - time >= OWN_WRITE_WINDOW_MS) this.ownWrites.delete(p);
    }
    this.ownWrites.set(filePath, now);
  }

  /**
   * Syncs local and remote files.
   * @param quiet Automatic sync: no progress notices, errors shown briefly
   * and not repeated
   * @returns true if the sync succeeded
   */
  async sync({ quiet = false }: { quiet?: boolean } = {}): Promise<boolean> {
    if (this.syncing) {
      await this.logger.info("Sync already in progress");
      return false;
    }

    const notice = quiet ? null : new Notice("Syncing...");
    this.syncing = true;
    let success = false;
    try {
      // If another device pushes while we sync our commit is rejected,
      // in that case we start over with the new remote state.
      for (let attempt = 0; ; attempt++) {
        try {
          await this.syncImpl();
          break;
        } catch (err) {
          if (err instanceof RemoteMovedError && attempt < 2) {
            await this.logger.warn("Remote changed during sync, retrying");
            continue;
          }
          throw err;
        }
      }
      success = true;
      this.lastQuietError = null;
      if (!quiet) {
        // Shown only if sync doesn't fail
        new Notice("Sync successful", 5000);
      }
    } catch (err) {
      await this.logger.error("Sync failed", `${err}`);
      if (!quiet) {
        // Show the error to the user, it's not automatically dismissed to make sure
        // the user sees it.
        new Notice(`Error syncing. ${err}`);
      } else if (`${err}` !== this.lastQuietError) {
        new Notice(`Error syncing. ${err}`, 10000);
      }
      if (quiet) {
        this.lastQuietError = `${err}`;
      }
    } finally {
      this.syncing = false;
      notice?.hide();
    }
    return success;
  }

  private async syncImpl() {
    await this.logger.info("Starting sync");
    const base = this.state.data.files;
    const cache = this.state.data.cache;

    const remote = await this.getRemote();
    const remoteFiles: FileShas = {};
    for (const [filePath, sha] of Object.entries(remote.files)) {
      if (this.isSyncable(filePath)) {
        remoteFiles[filePath] = sha;
      }
    }
    const localFiles = await this.scanLocal();

    // Paths that are not synced anymore, e.g. config files after the user
    // disabled config sync, are forgotten so that re-enabling is a safe merge.
    for (const filePath of Object.keys(base)) {
      if (!this.isSyncable(filePath)) {
        delete base[filePath];
      }
    }

    const actions = planSync(base, localFiles, remoteFiles);
    const paths = (type: string) =>
      actions.filter((a) => a.type === type).map((a) => a.filePath);
    const uploads = paths("upload");
    const downloads = paths("download");
    const deleteLocal = paths("delete_local");
    const deleteRemote = paths("delete_remote");
    const record = paths("record");
    const forget = paths("forget");

    // Content chosen by the user for conflicting files. These are uploaded and,
    // once the push succeeded, written locally.
    const resolutions = new Map<string, string>();
    const conflicts = paths("conflict");
    if (conflicts.length > 0) {
      await this.logger.warn("Found conflicts", conflicts);
      await this.handleConflicts(
        conflicts,
        remoteFiles,
        uploads,
        downloads,
        resolutions,
      );
    }

    if (actions.length === 0) {
      await this.logger.info("Nothing to sync");
      this.state.data.lastSync = Date.now();
      this.state.data.lastCommit = remote.commitSha;
      await this.state.save();
      return;
    }
    await this.logger.info("Actions to sync", actions);

    // Push local changes first. Nothing is changed locally until the remote
    // accepted our commit, so a rejected push can simply be retried.
    let newRemoteFiles = remote.files;
    const uploadedLocalSha = new Map<string, string>();
    if (uploads.length > 0 || deleteRemote.length > 0) {
      const treeItems: NewTreeRequestItem[] = [];
      await mapLimit(uploads, CONCURRENCY, async (filePath) => {
        const resolution = resolutions.get(filePath);
        if (resolution !== undefined) {
          treeItems.push({
            path: filePath,
            mode: "100644",
            type: "blob",
            content: resolution,
          });
          return;
        }
        const bytes = new Uint8Array(
          await this.vault.adapter.readBinary(normalizePath(filePath)),
        );
        uploadedLocalSha.set(filePath, await gitBlobSha(bytes));
        // Text files are sent inline to save requests, anything else
        // must be uploaded as a blob first.
        const text = hasTextExtension(filePath)
          ? decodeUtf8Exactly(bytes)
          : null;
        if (text !== null) {
          treeItems.push({
            path: filePath,
            mode: "100644",
            type: "blob",
            content: text,
          });
          return;
        }
        const { sha } = await this.client.createBlob({
          content: arrayBufferToBase64(bytes.buffer as ArrayBuffer),
          retry: true,
          maxRetries: 3,
        });
        treeItems.push({ path: filePath, mode: "100644", type: "blob", sha });
      });
      for (const filePath of deleteRemote) {
        treeItems.push({
          path: filePath,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }

      const newTreeSha = await this.client.createTree({
        tree: { tree: treeItems, base_tree: remote.treeSha },
        retry: true,
      });
      const commitSha = await this.client.createCommit({
        message: this.commitMessage(uploads.length, deleteRemote.length),
        treeSha: newTreeSha,
        // Parent is the commit we read, not the current head, so we never
        // overwrite what another device pushed in the meantime.
        parent: remote.commitSha,
        retry: true,
      });
      try {
        // Not a forced update, GitHub rejects it if the branch moved
        await this.client.updateBranchHead({ sha: commitSha });
      } catch (err) {
        if (err.status === 422) {
          throw new RemoteMovedError("Remote branch moved during sync");
        }
        throw err;
      }
      this.state.data.lastCommit = commitSha;
      // Read back the real blob SHAs, so the base matches the remote exactly
      newRemoteFiles = await this.client.getTree({
        sha: newTreeSha,
        retry: true,
      });
    } else {
      this.state.data.lastCommit = remote.commitSha;
    }

    // The remote is updated, now record the uploads and remote deletions.
    for (const filePath of uploads) {
      const remoteSha = newRemoteFiles[filePath];
      if (remoteSha === undefined) {
        await this.logger.error("Uploaded file missing from new tree", filePath);
        continue;
      }
      const resolution = resolutions.get(filePath);
      if (resolution !== undefined) {
        // Write the resolved content locally and record what is on disk
        this.markOwnWrite(filePath);
        await this.vault.adapter.write(normalizePath(filePath), resolution);
        const localSha = await this.refreshCache(filePath);
        base[filePath] = { local: localSha ?? remoteSha, remote: remoteSha };
        continue;
      }
      base[filePath] = {
        local: uploadedLocalSha.get(filePath)!,
        remote: remoteSha,
      };
    }
    for (const filePath of deleteRemote) {
      delete base[filePath];
      delete cache[filePath];
    }
    for (const filePath of record) {
      base[filePath] = {
        local: localFiles[filePath],
        remote: remoteFiles[filePath],
      };
    }
    for (const filePath of forget) {
      delete base[filePath];
      delete cache[filePath];
    }

    // Apply remote changes locally. Deletions go first so that case-only
    // renames work on case-insensitive file systems.
    const failed: string[] = [];
    for (const filePath of deleteLocal) {
      try {
        if (await this.changedSinceScan(filePath, localFiles[filePath])) {
          // Edited while we were syncing, the next sync will upload it again
          await this.logger.warn("Skipped deleting edited file", filePath);
          continue;
        }
        await this.deleteLocalFile(filePath);
        delete base[filePath];
        delete cache[filePath];
      } catch (err) {
        await this.logger.error("Failed to delete local file", {
          filePath,
          err: `${err}`,
        });
        failed.push(filePath);
      }
    }
    await mapLimit(downloads, CONCURRENCY, async (filePath) => {
      try {
        const remoteSha = remoteFiles[filePath];
        if (
          await this.changedSinceScan(filePath, localFiles[filePath] ?? null)
        ) {
          await this.logger.warn("Skipped overwriting edited file", filePath);
          return;
        }
        const localSha = await this.downloadFile(filePath, remoteSha);
        base[filePath] = { local: localSha, remote: remoteSha };
      } catch (err) {
        await this.logger.error("Failed to download file", {
          filePath,
          err: `${err}`,
        });
        failed.push(filePath);
      }
    });

    this.state.data.lastSync = Date.now();
    await this.state.save();
    await this.logger.info("Sync done");

    if (failed.length > 0) {
      // Everything else is saved, these are retried on the next sync
      throw new Error(`Failed to sync ${failed.length} file(s): ${failed}`);
    }
  }

  /**
   * Decides how to solve conflicts according to the user settings and adds
   * the outcome to the uploads, downloads or resolutions.
   */
  private async handleConflicts(
    conflicts: string[],
    remoteFiles: FileShas,
    uploads: string[],
    downloads: string[],
    resolutions: Map<string, string>,
  ) {
    if (this.settings.conflictHandling === "overwriteLocal") {
      downloads.push(...conflicts);
      return;
    }
    if (this.settings.conflictHandling === "overwriteRemote") {
      uploads.push(...conflicts);
      return;
    }

    const textConflicts: ConflictFile[] = [];
    for (const filePath of conflicts) {
      const [blob, localBytes] = await Promise.all([
        this.client.getBlob({ sha: remoteFiles[filePath], retry: true }),
        this.vault.adapter.readBinary(normalizePath(filePath)),
      ]);
      const remoteContent = hasTextExtension(filePath)
        ? decodeUtf8Exactly(new Uint8Array(base64ToArrayBuffer(blob.content)))
        : null;
      const localContent = hasTextExtension(filePath)
        ? decodeUtf8Exactly(new Uint8Array(localBytes))
        : null;
      if (remoteContent === null || localContent === null) {
        // Can't show a diff for binary files. Keep the local version,
        // the remote one stays available in the repository history.
        await this.logger.warn("Binary conflict, keeping local", filePath);
        new Notice(
          `Sync conflict on ${filePath}: kept this device's version, the other one is in the GitHub history.`,
        );
        uploads.push(filePath);
        continue;
      }
      textConflicts.push({ filePath, remoteContent, localContent });
    }
    if (textConflicts.length === 0) {
      return;
    }
    // Here we block the sync process until the user has resolved all the conflicts
    const userResolutions = await this.onConflicts(textConflicts);
    for (const resolution of userResolutions) {
      resolutions.set(resolution.filePath, resolution.content);
      uploads.push(resolution.filePath);
    }
  }

  private commitMessage(changed: number, deleted: number): string {
    const parts = [];
    if (changed > 0) parts.push(`${changed} changed`);
    if (deleted > 0) parts.push(`${deleted} deleted`);
    return `Sync: ${parts.join(", ")}`;
  }

  /**
   * Gets the current remote commit, tree and files.
   * Creates a first commit if the repository is completely empty.
   */
  private async getRemote(): Promise<RemoteState> {
    let branch: { commitSha: string; treeSha: string };
    try {
      branch = await this.client.getBranch({ retry: true });
    } catch (err) {
      // 409 is returned in case the remote repo has been just created
      // and contains no files, 404 if the branch doesn't exist yet.
      if (err.status !== 409 && err.status !== 404) {
        throw err;
      }
      await this.logger.info("Remote repository is empty, initializing it");
      await this.client.createFile({
        path: INIT_FILE,
        content: arrayBufferToBase64(
          new TextEncoder().encode(
            "This repository is synced by GitHub Gitless Sync.\n",
          ).buffer as ArrayBuffer,
        ),
        message: "Initialize repository",
        retry: true,
      });
      branch = await this.client.getBranch({ retry: true });
    }

    // Never act on a remote older than what this device already synced with,
    // that would look like the remote reverted our changes.
    const lastCommit = this.state.data.lastCommit;
    for (let attempt = 0; lastCommit && branch.commitSha !== lastCommit; ) {
      const status = await this.client.compareCommits({
        base: lastCommit,
        head: branch.commitSha,
      });
      if (status !== "behind") {
        // Newer, or unrelated after a force push: the 3-way merge handles it
        break;
      }
      if (++attempt > STALE_RETRIES) {
        throw new Error(
          "GitHub returned an outdated version of the repository, try again in a minute",
        );
      }
      await this.logger.warn("Remote branch read is stale, retrying");
      await new Promise((resolve) => setTimeout(resolve, STALE_RETRY_DELAY_MS));
      branch = await this.client.getBranch({ retry: true });
    }

    const files = await this.client.getTree({
      sha: branch.treeSha,
      retry: true,
    });
    return { ...branch, files };
  }

  /**
   * Lists all syncable files in the vault and computes their SHA.
   */
  private async scanLocal(): Promise<FileShas> {
    const filePaths: string[] = [];
    const folders = [this.vault.getRoot().path];
    while (folders.length > 0) {
      const folder = folders.pop()!;
      const res = await this.vault.adapter.list(folder);
      for (const sub of res.folders) {
        if (this.isSyncableFolder(normalizePath(sub))) {
          folders.push(sub);
        }
      }
      for (const file of res.files) {
        const filePath = normalizePath(file);
        if (this.isSyncable(filePath)) {
          filePaths.push(filePath);
        }
      }
    }

    const files: FileShas = {};
    await mapLimit(filePaths, CONCURRENCY, async (filePath) => {
      const sha = await this.localSha(filePath);
      if (sha !== null) {
        files[filePath] = sha;
      }
    });

    // Drop cache entries of files that don't exist anymore
    for (const filePath of Object.keys(this.state.data.cache)) {
      if (!(filePath in files)) {
        delete this.state.data.cache[filePath];
      }
    }
    return files;
  }

  /**
   * Returns the SHA of a local file, reusing the cached one if the file
   * modification time and size didn't change. Null if the file doesn't exist.
   */
  private async localSha(filePath: string): Promise<string | null> {
    const stat = await this.vault.adapter.stat(filePath);
    if (!stat || stat.type !== "file") {
      return null;
    }
    const cached = this.state.data.cache[filePath];
    if (
      cached &&
      cached.mtime === stat.mtime &&
      cached.size === stat.size &&
      // Like git's "racy clean" check: if the file was hashed right after it
      // was modified, a later edit might keep the same mtime, so hash again.
      cached.hashedAt - cached.mtime > RACY_WINDOW_MS
    ) {
      return cached.sha;
    }
    return await this.refreshCache(filePath);
  }

  /**
   * Hashes a local file and updates its cache entry.
   * The stat is taken before reading so an edit during the read is noticed later.
   */
  private async refreshCache(filePath: string): Promise<string | null> {
    const hashedAt = Date.now();
    const stat = await this.vault.adapter.stat(filePath);
    if (!stat || stat.type !== "file") {
      delete this.state.data.cache[filePath];
      return null;
    }
    const bytes = new Uint8Array(await this.vault.adapter.readBinary(filePath));
    const sha = await gitBlobSha(bytes);
    this.state.data.cache[filePath] = {
      mtime: stat.mtime,
      size: stat.size,
      sha,
      hashedAt,
    };
    return sha;
  }

  /**
   * True if the local file is not the one we saw at the start of the sync.
   */
  private async changedSinceScan(
    filePath: string,
    scannedSha: string | null,
  ): Promise<boolean> {
    const stat = await this.vault.adapter.stat(filePath);
    if (!stat) {
      return scannedSha !== null;
    }
    const bytes = new Uint8Array(await this.vault.adapter.readBinary(filePath));
    return (await gitBlobSha(bytes)) !== scannedSha;
  }

  /**
   * Whether a file is synced. Internal plugin files, workspace files, hidden
   * files and, unless enabled, the config dir are never synced.
   */
  isSyncable(filePath: string): boolean {
    const configDir = this.vault.configDir;
    const neverSynced = [
      STATE_FILE_NAME,
      LEGACY_METADATA_FILE_NAME,
      LOG_FILE_NAME,
      // Obsidian recommends not syncing the workspace files
      "workspace.json",
      "workspace-mobile.json",
    ].map((name) => `${configDir}/${name}`);
    if (neverSynced.includes(filePath)) {
      return false;
    }
    const parts = filePath.split("/");
    if (parts[0] === configDir) {
      return (
        this.settings.syncConfigDir &&
        !parts.slice(1).some((p) => p.startsWith("."))
      );
    }
    // Hidden files and folders (.trash, .git, .DS_Store...) are never synced
    return !parts.some((p) => p.startsWith("."));
  }

  private isSyncableFolder(folderPath: string): boolean {
    const parts = folderPath.split("/");
    if (parts[0] === this.vault.configDir) {
      return (
        this.settings.syncConfigDir &&
        !parts.slice(1).some((p) => p.startsWith("."))
      );
    }
    return !parts.some((p) => p.startsWith("."));
  }

  /**
   * Downloads a remote blob to a local file.
   * @returns the SHA of the written file
   */
  private async downloadFile(filePath: string, sha: string): Promise<string> {
    const blob = await this.client.getBlob({ sha, retry: true });
    const normalizedPath = normalizePath(filePath);
    this.markOwnWrite(normalizedPath);
    const parts = normalizedPath.split("/");
    if (parts.length > 1) {
      const fileFolder = parts.slice(0, -1).join("/");
      if (!(await this.vault.adapter.exists(fileFolder))) {
        await this.vault.adapter.mkdir(fileFolder);
      }
    }
    await this.vault.adapter.writeBinary(
      normalizedPath,
      base64ToArrayBuffer(blob.content),
    );
    return (await this.refreshCache(normalizedPath)) ?? sha;
  }

  /**
   * Moves a local file to the vault trash (.trash) so it can be recovered,
   * then removes the folders left empty.
   */
  private async deleteLocalFile(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    this.markOwnWrite(normalizedPath);
    if (await this.vault.adapter.exists(normalizedPath)) {
      await this.vault.adapter.trashLocal(normalizedPath);
    }
    // Cleaning up folders is best effort, the file is already gone
    try {
      const parts = normalizedPath.split("/");
      for (let i = parts.length - 1; i > 0; i--) {
        const folder = parts.slice(0, i).join("/");
        const { files, folders } = await this.vault.adapter.list(folder);
        if (files.length > 0 || folders.length > 0) {
          break;
        }
        this.markOwnWrite(folder);
        // Recursive because Obsidian desktop's non-recursive rmdir can't
        // remove directories at all. The folder was just checked to be empty.
        await this.vault.adapter.rmdir(folder, true);
      }
    } catch (err) {
      await this.logger.warn("Failed to remove empty folder", `${err}`);
    }
  }

  /**
   * Sync status of a local file, used by the status bar.
   * @param mtime current modification time of the file
   */
  getFileStatus(filePath: string, mtime: number): FileSyncStatus {
    const entry = this.state.data.files[filePath];
    if (!entry) {
      return "Untracked";
    }
    const cached = this.state.data.cache[filePath];
    if (cached && cached.mtime === mtime && cached.sha === entry.local) {
      return "Up to date";
    }
    return "Outdated";
  }

  /**
   * Starts a new sync interval.
   * Raises an error if the interval is already running.
   */
  startSyncInterval(minutes: number): number {
    if (this.syncIntervalId) {
      throw new Error("Sync interval is already running");
    }
    this.syncIntervalId = window.setInterval(
      async () => await this.sync({ quiet: true }),
      // Sync interval is set in minutes but setInterval expects milliseconds
      minutes * 60 * 1000,
    );
    return this.syncIntervalId;
  }

  /**
   * Stops the currently running sync interval
   */
  stopSyncInterval() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Util function that stops and restart the sync interval
   */
  restartSyncInterval(minutes: number) {
    this.stopSyncInterval();
    return this.startSyncInterval(minutes);
  }

  async resetState() {
    await this.state.reset();
  }
}
