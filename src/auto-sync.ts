/**
 * Debounced trigger for automatic syncs, e.g. a few seconds after the user
 * stopped editing. Each new request pushes the pending sync further away.
 */
export default class AutoSync {
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param run Runs a sync, resolves to false if it couldn't start because
   * another sync was already running
   */
  constructor(private run: () => Promise<boolean>) {}

  get pending(): boolean {
    return this.timer !== null;
  }

  /** (Re)starts the countdown to the next sync */
  schedule(delayMs: number) {
    this.cancel();
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!(await this.run())) {
        // Another sync was running, it might have missed the latest edits
        this.schedule(delayMs);
      }
    }, delayMs);
  }

  /** Runs the pending sync right away, if there is one */
  async flush() {
    if (this.timer === null) {
      return;
    }
    this.cancel();
    await this.run();
  }

  cancel() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
