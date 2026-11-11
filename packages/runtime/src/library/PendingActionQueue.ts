import type { PendingActionRecord, PendingActionRepository } from "@mdcz/persistence";
import { toErrorMessage } from "@mdcz/shared/error";
import { runtimeLoggerService } from "../shared";

export class PendingActionQueue {
  private timer?: ReturnType<typeof setInterval>;
  private worker?: Promise<void>;
  private closed = false;
  isExecuting = false;
  private readonly logger = runtimeLoggerService.getLogger("PendingActions");

  constructor(
    private readonly deps: {
      repository(): Promise<PendingActionRepository>;
      busy(): Promise<boolean>;
      execute(job: PendingActionRecord, progress: (message: string) => void): Promise<void>;
      changed(): void;
      progressed(): void;
    },
  ) {}

  async start(): Promise<void> {
    (await this.deps.repository()).recover();
    this.timer = setInterval(() => this.wake(), 1_000);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.closed || this.worker) return;
    this.worker = this.drain().finally(() => {
      this.worker = undefined;
    });
    void this.worker.catch((error) => this.logger.error(`处理任务队列失败：${toErrorMessage(error)}`));
  }

  async waitForIdle(): Promise<void> {
    this.wake();
    await this.worker;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.worker;
  }

  private async drain(): Promise<void> {
    const repository = await this.deps.repository();
    while (!this.closed) {
      if (await this.deps.busy()) return;
      const job = repository.claim();
      if (!job) return;
      this.isExecuting = true;
      try {
        this.deps.changed();
        await this.deps.execute(job, (message) => {
          repository.progress(job.id, message);
          this.deps.progressed();
        });
        repository.finish(job);
      } catch (error) {
        const message = toErrorMessage(error);
        let transient = false;
        for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
          if (
            /timeout|timed? ?out|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|超时|连接失败|响应丢失|网络连接|HTTP (?:408|429|5\d\d)/iu.test(
              cause.message,
            )
          )
            transient = true;
        }
        const retryAt = transient && job.attempts < 3 ? Date.now() + 2_000 * 2 ** (job.attempts - 1) : undefined;
        repository.finish(job, message, retryAt);
        this.logger.error(`处理任务 ${job.id} ${retryAt ? "等待重试" : "失败"}：${message}`);
      } finally {
        this.isExecuting = false;
      }
      this.deps.changed();
    }
  }
}
