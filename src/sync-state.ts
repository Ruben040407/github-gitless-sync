import { Vault, normalizePath } from "obsidian";
import { BaseFiles } from "./sync-plan";

// Per-device sync state. It lives in the config dir but is never synced.
export const STATE_FILE_NAME = "github-sync-state.json" as const;

// Shared metadata file used by v1.0.7 and earlier. This fork never reads,
// writes, uploads or deletes it, so rolling back to v1.0.7 stays possible.
export const LEGACY_METADATA_FILE_NAME = "github-sync-metadata.json" as const;

export interface StatCacheEntry {
  mtime: number;
  size: number;
  sha: string;
  // When the file was hashed, used to detect edits in the same mtime tick
  hashedAt: number;
}

export interface SyncState {
  version: 2;
  // Time of the last successful sync
  lastSync: number;
  // Remote commit this device last synced with
  lastCommit: string | null;
  // What each file looked like locally and remotely after the last successful sync
  files: BaseFiles;
  // Cache of local file SHAs keyed by path, reused while mtime and size don't change
  cache: { [path: string]: StatCacheEntry };
}

function emptyState(): SyncState {
  return { version: 2, lastSync: 0, lastCommit: null, files: {}, cache: {} };
}

/**
 * Stores the per-device sync state between sessions.
 */
export default class SyncStateStore {
  data: SyncState = emptyState();
  readonly stateFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private vault: Vault) {
    this.stateFile = normalizePath(`${this.vault.configDir}/${STATE_FILE_NAME}`);
  }

  async load() {
    if (!(await this.vault.adapter.exists(this.stateFile))) {
      // First run of this version: an empty base makes the next sync merge
      // local and remote without deleting anything.
      this.data = emptyState();
      return;
    }
    try {
      const parsed = JSON.parse(await this.vault.adapter.read(this.stateFile));
      if (parsed?.version !== 2) {
        this.data = emptyState();
        return;
      }
      this.data = { ...emptyState(), ...parsed };
    } catch {
      // A corrupted state is not fatal, the next sync is just a safe merge
      this.data = emptyState();
    }
  }

  async save() {
    const content = JSON.stringify(this.data);
    this.writeQueue = this.writeQueue.then(() =>
      this.vault.adapter.write(this.stateFile, content),
    );
    return this.writeQueue;
  }

  async reset() {
    this.data = emptyState();
    await this.save();
  }
}
