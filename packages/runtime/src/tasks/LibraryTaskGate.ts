export type LibraryTaskKind = "scrape" | "maintenance" | "pending" | "edit" | "subtitle";

const CONFLICT_MESSAGES: Record<LibraryTaskKind, string> = {
  edit: "媒体库批量编辑正在运行，请等待完成后再开始媒体任务",
  pending: "文件处理任务正在运行，请等待完成后再开始媒体任务",
  maintenance: "维护任务正在运行，请停止后再开始刮削",
  scrape: "刮削任务正在运行，请停止后再开始维护",
  subtitle: "字幕更新任务正在运行，请等待完成后再开始媒体任务",
};

export class LibraryTaskConflictError extends Error {
  constructor(readonly running: LibraryTaskKind) {
    super(CONFLICT_MESSAGES[running]);
    this.name = "LibraryTaskConflictError";
  }
}

/**
 * Scrapes and maintenance both move source files and rewrite library records, and the output directory mutex only
 * serializes writes into the same folder, so one kind of task never starts while the other is live.
 */
export class LibraryTaskGate {
  readonly #busy = new Map<LibraryTaskKind, () => boolean>();
  readonly #foreground = new Set<() => void>();
  #manualWrites = 0;

  get foregroundBusy(): boolean {
    return (
      this.#manualWrites > 0 ||
      this.#foreground.size > 0 ||
      [...this.#busy].some(([kind, busy]) => kind !== "subtitle" && busy())
    );
  }

  get subtitleBusy(): boolean {
    return this.#busy.get("subtitle")?.() ?? false;
  }

  async waitForSubtitle(): Promise<void> {
    if (!this.subtitleBusy) return;
    let waiter!: () => void;
    try {
      await new Promise<void>((resolve) => {
        waiter = resolve;
        this.#foreground.add(resolve);
      });
    } finally {
      this.#foreground.delete(waiter);
    }
  }

  subtitleFinished(): void {
    for (const resolve of this.#foreground) resolve();
  }

  async runManualWrite<T>(write: () => Promise<T>): Promise<T> {
    await this.waitForSubtitle();
    this.#manualWrites++;
    try {
      return await write();
    } finally {
      this.#manualWrites--;
    }
  }

  track(kind: LibraryTaskKind, busy: () => boolean): void {
    this.#busy.set(kind, busy);
  }

  /** Call in the same synchronous step that registers the task, so a concurrent start of the other kind cannot slip in. */
  assertAvailable(kind?: LibraryTaskKind): void {
    if (kind === "subtitle" && this.#foreground.size) throw new LibraryTaskConflictError("subtitle");
    if (kind === "subtitle" && this.#manualWrites) throw new LibraryTaskConflictError("edit");
    for (const [holder, busy] of this.#busy) if (holder !== kind && busy()) throw new LibraryTaskConflictError(holder);
  }
}
