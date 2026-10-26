// A simulated device: a vault folder on disk plus its own SyncManager.
import { promises as fs, existsSync, mkdirSync, rmSync } from "fs";
import * as path from "path";
import { Vault } from "./mock-obsidian";
import SyncManager, {
  ConflictFile,
  ConflictResolution,
} from "../src/sync-manager";
import Logger from "../src/logger";
import { DEFAULT_SETTINGS, GitHubSyncSettings } from "../src/settings/settings";

export type ConflictHandler = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

export class Device {
  vault: Vault;
  settings: GitHubSyncSettings;
  manager!: SyncManager;
  seenConflicts: ConflictFile[][] = [];
  // Default: keep the local content
  onConflicts: ConflictHandler = async (conflicts) =>
    conflicts.map((c) => ({ filePath: c.filePath, content: c.localContent }));

  constructor(
    public root: string,
    settings: Partial<GitHubSyncSettings> = {},
  ) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(path.join(root, ".obsidian"), { recursive: true });
    this.vault = new Vault(root);
    this.settings = {
      ...DEFAULT_SETTINGS,
      githubToken: "fake-token",
      githubOwner: "owner",
      githubRepo: "repo",
      githubBranch: "main",
      firstSync: false,
      ...settings,
    };
  }

  /** Simulates (re)starting Obsidian with the plugin enabled */
  async start() {
    const logger = new Logger(this.vault as any, true);
    await logger.init();
    this.manager = new SyncManager(
      this.vault as any,
      this.settings,
      async (conflicts) => {
        this.seenConflicts.push(conflicts);
        return this.onConflicts(conflicts);
      },
      logger,
    );
    await this.manager.loadState();
    return this;
  }

  async sync(): Promise<boolean> {
    return await this.manager.sync();
  }

  private full(p: string) {
    return path.join(this.root, p);
  }
  async write(p: string, content: string) {
    await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
    await fs.writeFile(this.full(p), content, "utf8");
  }
  read(p: string): string | undefined {
    return existsSync(this.full(p))
      ? require("fs").readFileSync(this.full(p), "utf8")
      : undefined;
  }
  exists(p: string) {
    return existsSync(this.full(p));
  }
  async remove(p: string) {
    await fs.unlink(this.full(p));
  }
  async rename(from: string, to: string) {
    await fs.mkdir(path.dirname(this.full(to)), { recursive: true });
    await fs.rename(this.full(from), this.full(to));
  }
  /** Note files in the vault, excluding hidden folders */
  async notes(dir = ""): Promise<{ [p: string]: string }> {
    const out: { [p: string]: string } = {};
    for (const e of await fs.readdir(this.full(dir), { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) Object.assign(out, await this.notes(rel));
      else out[rel] = this.read(rel)!;
    }
    return out;
  }
  state() {
    return JSON.parse(this.read(".obsidian/github-sync-state.json")!);
  }
}
