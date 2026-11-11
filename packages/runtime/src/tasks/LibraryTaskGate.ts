export type LibraryTaskKind = "scrape" | "maintenance" | "pending";

const CONFLICT_MESSAGES: Record<LibraryTaskKind, string> = {
  pending: "文件处理任务正在运行，请等待完成后再开始媒体任务",
  maintenance: "维护任务正在运行，请停止后再开始刮削",
  scrape: "刮削任务正在运行，请停止后再开始维护",
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

  track(kind: LibraryTaskKind, busy: () => boolean): void {
    this.#busy.set(kind, busy);
  }

  /** Call in the same synchronous step that registers the task, so a concurrent start of the other kind cannot slip in. */
  assertAvailable(kind: LibraryTaskKind): void {
    for (const [holder, busy] of this.#busy) if (holder !== kind && busy()) throw new LibraryTaskConflictError(holder);
  }
}
