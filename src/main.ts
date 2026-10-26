import {
  EventRef,
  Plugin,
  TAbstractFile,
  WorkspaceLeaf,
  normalizePath,
  Notice,
} from "obsidian";
import { GitHubSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import GitHubSyncSettingsTab from "./settings/tab";
import SyncManager, { ConflictFile, ConflictResolution } from "./sync-manager";
import Logger from "./logger";
import AutoSync from "./auto-sync";
import {
  ConflictsResolutionView,
  CONFLICTS_RESOLUTION_VIEW_TYPE,
} from "./views/conflicts-resolution/view";

// Sync when Obsidian comes back to the foreground, unless it synced this recently
const RESUME_SYNC_AFTER_MS = 30 * 1000;

export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  syncManager: SyncManager;
  logger: Logger;

  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  conflictsRibbonIcon: HTMLElement | null = null;

  activeLeafChangeListener: EventRef | null = null;
  vaultCreateListener: EventRef | null = null;
  vaultModifyListener: EventRef | null = null;

  // Called in ConflictResolutionView when the user solves all the conflicts.
  // This is initialized every time we open the view to set new conflicts so
  // we can notify the SyncManager that everything has been resolved and the sync
  // process can continue on.
  conflictsResolver: ((resolutions: ConflictResolution[]) => void) | null =
    null;

  // We keep track of the sync conflicts in here too in case the
  // conflicts view must be rebuilt, or the user closes the view
  // and it gets destroyed.
  // By keeping them here we can recreate it easily.
  private conflicts: ConflictFile[] = [];

  // Syncs a few seconds after the last edit
  private autoSync = new AutoSync(async () => {
    if (this.syncManager.isSyncing()) {
      return false;
    }
    await this.sync({ quiet: true });
    return true;
  });

  async onUserEnable() {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Go to settings to configure syncing");
    }
  }

  getConflictsView(): ConflictsResolutionView | null {
    const leaves = this.app.workspace.getLeavesOfType(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
    );
    if (leaves.length === 0) {
      return null;
    }
    return leaves[0].view as ConflictsResolutionView;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CONFLICTS_RESOLUTION_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf(false)!;
      await leaf.setViewState({
        type: CONFLICTS_RESOLUTION_VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.enableLogging);
    this.logger.init();

    this.registerView(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
      (leaf) => new ConflictsResolutionView(leaf, this, this.conflicts),
    );

    this.addSettingTab(new GitHubSyncSettingsTab(this.app, this));

    this.syncManager = new SyncManager(
      this.app.vault,
      this.settings,
      this.onConflicts.bind(this),
      this.logger,
    );
    await this.syncManager.loadState();

    if (this.settings.syncStrategy == "interval") {
      this.restartSyncInterval();
    }

    this.app.workspace.onLayoutReady(async () => {
      // Load the ribbons after layout is ready so they're shown after the core
      // buttons
      if (this.settings.showStatusBarItem) {
        this.showStatusBarItem();
      }

      if (this.settings.showConflictsRibbonButton) {
        this.showConflictsRibbonIcon();
      }

      if (this.settings.showSyncRibbonButton) {
        this.showSyncRibbonIcon();
      }

      // Register vault events only now, Obsidian fires a create event for
      // every file while loading the vault.
      for (const name of ["create", "modify", "delete"] as const) {
        this.registerEvent(
          this.app.vault.on(name as "create", (file: TAbstractFile) =>
            this.onVaultChange(file.path),
          ),
        );
      }
      this.registerEvent(
        this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) =>
          this.onVaultChange(file.path, oldPath),
        ),
      );

      // On mobile Obsidian is usually resumed rather than restarted.
      this.registerDomEvent(document, "visibilitychange", async () => {
        if (document.visibilityState === "hidden") {
          // The app is being backgrounded, timers won't run anymore:
          // push the pending edits now.
          await this.autoSync.flush();
        } else if (
          this.settings.syncOnStartup &&
          Date.now() - this.syncManager.lastSyncTime() > RESUME_SYNC_AFTER_MS
        ) {
          await this.sync({ quiet: true });
        }
      });

      if (this.settings.syncOnStartup) {
        await this.sync({ quiet: true });
      }
    });

    this.addCommand({
      id: "sync-files",
      name: "Sync with GitHub",
      repeatable: false,
      icon: "refresh-cw",
      callback: () => this.sync(),
    });

    this.addCommand({
      id: "merge",
      name: "Open sync conflicts view",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.openConflictsView.bind(this),
    });
  }

  /**
   * Called for every file change in the vault, schedules a sync if enabled.
   */
  private onVaultChange(...paths: string[]) {
    if (!this.settings.syncOnEdit || !this.isConfigured()) {
      return;
    }
    const relevant = paths.some(
      (p) =>
        p !== undefined &&
        this.syncManager.isSyncable(p) &&
        !this.syncManager.isOwnChange(p),
    );
    if (relevant) {
      this.autoSync.schedule(Math.max(1, this.settings.syncOnEditDelay) * 1000);
    }
  }

  isConfigured(): boolean {
    return !(
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    );
  }

  /**
   * @param quiet Automatic sync, see SyncManager.sync
   */
  async sync({ quiet = false }: { quiet?: boolean } = {}) {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      if (!quiet) {
        new Notice("Sync plugin not configured");
      }
      return;
    }
    // There's no special first sync anymore, the first sync of this version
    // merges local and remote files without deleting anything.
    const success = await this.syncManager.sync({ quiet });
    if (success && this.settings.firstSync) {
      this.settings.firstSync = false;
      await this.saveSettings();
    }
    this.updateStatusBarItem();
  }

  async onunload() {
    this.stopSyncInterval();
    this.autoSync.cancel();
  }

  showStatusBarItem() {
    if (this.statusBarItem) {
      return;
    }
    this.statusBarItem = this.addStatusBarItem();

    if (!this.activeLeafChangeListener) {
      this.activeLeafChangeListener = this.app.workspace.on(
        "active-leaf-change",
        () => this.updateStatusBarItem(),
      );
    }
    if (!this.vaultCreateListener) {
      this.vaultCreateListener = this.app.vault.on("create", () => {
        this.updateStatusBarItem();
      });
    }
    if (!this.vaultModifyListener) {
      this.vaultModifyListener = this.app.vault.on("modify", () => {
        this.updateStatusBarItem();
      });
    }
  }

  hideStatusBarItem() {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  updateStatusBarItem() {
    if (!this.statusBarItem) {
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return;
    }

    const state = this.syncManager.getFileStatus(
      activeFile.path,
      activeFile.stat.mtime,
    );
    this.statusBarItem.setText(`GitHub: ${state}`);
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitHub",
      () => this.sync(),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  showConflictsRibbonIcon() {
    if (this.conflictsRibbonIcon) {
      return;
    }
    this.conflictsRibbonIcon = this.addRibbonIcon(
      "merge",
      "Open sync conflicts view",
      this.openConflictsView.bind(this),
    );
  }

  hideConflictsRibbonIcon() {
    this.conflictsRibbonIcon?.remove();
    this.conflictsRibbonIcon = null;
  }

  async openConflictsView() {
    await this.activateView();
    this.getConflictsView()?.setConflictFiles(this.conflicts);
  }

  async onConflicts(conflicts: ConflictFile[]): Promise<ConflictResolution[]> {
    this.conflicts = conflicts;
    return await new Promise(async (resolve) => {
      this.conflictsResolver = resolve;
      await this.activateView();
      this.getConflictsView()?.setConflictFiles(conflicts);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Proxy methods from sync manager to ease handling the interval
  // when settings are changed
  startSyncInterval() {
    const intervalID = this.syncManager.startSyncInterval(
      this.settings.syncInterval,
    );
    this.registerInterval(intervalID);
  }

  stopSyncInterval() {
    this.syncManager.stopSyncInterval();
  }

  restartSyncInterval() {
    this.syncManager.stopSyncInterval();
    this.syncManager.startSyncInterval(this.settings.syncInterval);
  }

  async reset() {
    this.settings = DEFAULT_SETTINGS;
    this.saveSettings();
    await this.syncManager.resetState();
  }
}
