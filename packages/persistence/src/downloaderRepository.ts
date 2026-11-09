import { isPathInside } from "@mdcz/media-store";
import { eq } from "drizzle-orm";
import type { PersistenceDatabase } from "./database";
import { downloaderSources, downloaderTorrents } from "./schema";

/** Torrents MDCz took from a polled downloader category, so restarts and repeated polls never scrape one twice. */
export class DownloaderRepository {
  constructor(private readonly database: PersistenceDatabase) {}

  /** Records the category's current save path and returns when polling of `sourceKey` began; the first call records `now`. */
  track(sourceKey: string, savePath: string, now = new Date()): Date {
    this.database.db
      .insert(downloaderSources)
      .values({ key: sourceKey, since: now, savePath })
      .onConflictDoUpdate({ target: downloaderSources.key, set: { savePath } })
      .run();
    const row = this.database.db
      .select({ since: downloaderSources.since })
      .from(downloaderSources)
      .where(eq(downloaderSources.key, sourceKey))
      .get();
    if (!row) throw new Error(`下载器来源未记录：${sourceKey}`);
    return row.since;
  }

  /** Whether the file lies in a polled category's save path, where the downloader keeps seeding it. */
  ownsPath(filePath: string): boolean {
    return this.database.db
      .select({ savePath: downloaderSources.savePath })
      .from(downloaderSources)
      .all()
      .some((row) => isPathInside(row.savePath, filePath));
  }

  handledHashes(sourceKey: string): Set<string> {
    return new Set(
      this.database.db
        .select({ hash: downloaderTorrents.hash })
        .from(downloaderTorrents)
        .where(eq(downloaderTorrents.sourceKey, sourceKey))
        .all()
        .map((row) => row.hash),
    );
  }

  markHandled(sourceKey: string, hash: string, now = new Date()): void {
    this.database.db.insert(downloaderTorrents).values({ sourceKey, hash, handledAt: now }).onConflictDoNothing().run();
  }
}
