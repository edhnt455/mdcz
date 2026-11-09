import { chmod, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { moveDatabaseAside } from "@mdcz/persistence";
import Database from "better-sqlite3";
import { acquireDatabaseLease } from "./databaseFiles";
import { resolveServerRuntimePaths } from "./services/configService";

const usage =
  "用法：node server.js doctor | database backup <file> | database verify <file> | database restore <file> --confirm | database rebuild <file> --confirm";

export const runMaintenanceCli = async (args: string[]): Promise<void> => {
  const paths = resolveServerRuntimePaths();
  const [command, action, file, confirmation] = args;
  if (command === "doctor" && args.length === 1) {
    const database = new Database(paths.databasePath, { readonly: true, fileMustExist: true });
    try {
      const integrity = database.prepare("PRAGMA quick_check").pluck().all();
      const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
      const healthy = integrity.length === 1 && integrity[0] === "ok" && foreignKeys.length === 0;
      console.log(
        JSON.stringify(
          {
            healthy,
            databasePath: paths.databasePath,
            configDir: paths.configDir,
            sqliteVersion: database.prepare("SELECT sqlite_version() AS version").get(),
            journalMode: database.pragma("journal_mode", { simple: true }),
            integrity,
            foreignKeys,
          },
          null,
          2,
        ),
      );
      if (!healthy) process.exitCode = 1;
    } finally {
      database.close();
    }
    return;
  }
  if (
    command !== "database" ||
    !file ||
    !["backup", "verify", "restore", "rebuild"].includes(action ?? "") ||
    (action === "restore" || action === "rebuild"
      ? confirmation !== "--confirm" || args.length !== 4
      : args.length !== 3)
  ) {
    throw new Error(usage);
  }
  const filePath = resolve(file);
  if (action === "rebuild") {
    const target = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      if (!target.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get()) {
        throw new Error(`不是 MDCz 数据库：${filePath}`);
      }
    } finally {
      target.close();
    }
    const lease = acquireDatabaseLease(filePath);
    try {
      const backupPath = moveDatabaseAside(await realpath(filePath));
      console.log(`数据库已移动到 ${backupPath}。下次启动时将创建新数据库，配置及档案已保留。`);
    } finally {
      lease.close();
    }
    return;
  }
  if (action === "backup") {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const reservation = await open(filePath, "wx", 0o600);
    await reservation.close();
    let database: Database.Database | undefined;
    try {
      database = new Database(paths.databasePath, { readonly: true, fileMustExist: true });
      await database.backup(filePath);
      await chmod(filePath, 0o600);
      console.log(`数据库备份已创建：${filePath}。请另行备份 ${paths.configDir} 以保留身份验证及档案。`);
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    } finally {
      database?.close();
    }
    return;
  }
  const source = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = source.prepare("PRAGMA integrity_check").pluck().all();
    if (integrity.length !== 1 || integrity[0] !== "ok" || source.prepare("PRAGMA foreign_key_check").all().length) {
      throw new Error(`备份完整性检查失败：${filePath}`);
    }
    for (const table of ["__drizzle_migrations", "media_roots", "scan_tasks", "scrape_runs"]) {
      if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`不是 MDCz 数据库：缺少 ${table}`);
      }
    }
    if (action === "verify") {
      console.log(`备份核验通过：${filePath}`);
      return;
    }

    const lease = acquireDatabaseLease(paths.databasePath);
    try {
      const destination = await realpath(paths.databasePath);
      const [sourceStats, destinationStats] = await Promise.all([stat(filePath), stat(destination)]);
      if (
        (await realpath(filePath)) === destination ||
        (sourceStats.ino !== 0 && sourceStats.ino === destinationStats.ino && sourceStats.dev === destinationStats.dev)
      ) {
        throw new Error("恢复来源不能与当前数据库相同");
      }
      if (destinationStats.size > 0) {
        const previous = new Database(destination, { readonly: true, fileMustExist: true });
        const recoveryPath = `${destination}.before-restore-${Date.now()}.sqlite`;
        try {
          const reservation = await open(recoveryPath, "wx", 0o600);
          await reservation.close();
          await previous.backup(recoveryPath);
          console.log(`恢复前的数据库已保存：${recoveryPath}`);
        } finally {
          previous.close();
        }
      }
      await source.backup(destination);
      await chmod(destination, 0o600);
      console.log(`数据库已恢复：${destination}。身份验证及 TOML 档案未被替换。`);
    } finally {
      lease.close();
    }
  } finally {
    source.close();
  }
};
