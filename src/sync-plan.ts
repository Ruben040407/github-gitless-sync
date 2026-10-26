/**
 * Pure 3-way sync decision logic.
 *
 * For every path we compare three git blob SHAs:
 *  - base:   what this device recorded for the path at its last successful sync
 *            (both the local and the remote SHA at that moment)
 *  - local:  the SHA of the file currently on disk, or null if it doesn't exist
 *  - remote: the SHA of the file in the current remote git tree, or null
 *
 * The base is kept per device and never shared through the repository, so a
 * stale device can't poison the decisions of the others.
 *
 * This module has no Obsidian dependencies so it can be unit tested in Node.
 */

export interface BaseEntry {
  // SHA of the local file right after the last successful sync
  local: string;
  // SHA of the remote file right after the last successful sync
  remote: string;
}

export type BaseFiles = { [path: string]: BaseEntry };
export type FileShas = { [path: string]: string };

export type SyncActionType =
  // Local file is new or changed, remote untouched: push it
  | "upload"
  // Remote file is new or changed, local untouched: pull it
  | "download"
  // Deleted remotely, unchanged locally: delete the local copy
  | "delete_local"
  // Deleted locally, unchanged remotely: delete the remote copy
  | "delete_remote"
  // Both sides changed to different content
  | "conflict"
  // Both sides already hold identical content, only the base must be updated
  | "record"
  // Gone on both sides, only the base entry must be dropped
  | "forget";

export interface SyncAction {
  type: SyncActionType;
  filePath: string;
}

/**
 * Decides what to do for a single path.
 * Returns null when nothing has to be done.
 */
export function decide(
  base: BaseEntry | undefined,
  local: string | null,
  remote: string | null,
): SyncActionType | null {
  const localChanged = base ? local !== base.local : local !== null;
  const remoteChanged = base ? remote !== base.remote : remote !== null;

  if (!localChanged && !remoteChanged) {
    return null;
  }

  if (localChanged && !remoteChanged) {
    if (local !== null) return "upload";
    // Deleted locally. If remote is also missing there's nothing to delete.
    return remote !== null ? "delete_remote" : "forget";
  }

  if (!localChanged && remoteChanged) {
    if (remote !== null) return "download";
    return local !== null ? "delete_local" : "forget";
  }

  // Both sides changed since the base (or there is no base and both exist)
  if (local === null && remote === null) return "forget";
  if (local !== null && remote !== null) {
    return local === remote ? "record" : "conflict";
  }
  // One side deleted the file, the other edited it: never lose the edit.
  return local === null ? "download" : "upload";
}

/**
 * Computes the sync actions for all known paths.
 *
 * @param base Per-device record of the last successful sync
 * @param local SHAs of the syncable files currently in the vault
 * @param remote SHAs of the syncable files in the current remote tree
 */
export function planSync(
  base: BaseFiles,
  local: FileShas,
  remote: FileShas,
): SyncAction[] {
  const paths = new Set<string>([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  const actions: SyncAction[] = [];
  for (const filePath of Array.from(paths).sort()) {
    const type = decide(
      base[filePath],
      local[filePath] ?? null,
      remote[filePath] ?? null,
    );
    if (type !== null) {
      actions.push({ type, filePath });
    }
  }
  return actions;
}

/**
 * Computes the git blob SHA1 of some content, same algorithm git uses.
 */
export async function gitBlobSha(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const store = new Uint8Array(header.length + content.length);
  store.set(header, 0);
  store.set(content, header.length);
  const hash = await crypto.subtle.digest("SHA-1", store);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Runs fn on every item with at most `limit` calls in flight at once.
 * Avoids flooding the GitHub API (and mobile network stacks) with requests.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
