import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";

const MAX_LOG_BYTES = 10 * 1024 * 1024;

export const createRotatingLogStream = (directory: string): Writable => {
  const currentPath = join(directory, "mdcz.log");
  let file: FileHandle | undefined;
  let size = 0;
  const closeFile = async () => {
    const opened = file;
    file = undefined;
    await opened?.close();
  };

  return new Writable({
    async construct(callback) {
      try {
        await mkdir(directory, { recursive: true });
        file = await open(currentPath, "a");
        size = (await file.stat()).size;
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    async write(chunk: Buffer, _encoding, callback) {
      try {
        if (!file) throw new Error("Log file is not open");
        if (size > 0 && size + chunk.byteLength > MAX_LOG_BYTES) {
          await closeFile();
          await rm(join(directory, "mdcz2.log"), { force: true });
          await rename(join(directory, "mdcz1.log"), join(directory, "mdcz2.log")).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
          await rename(currentPath, join(directory, "mdcz1.log"));
          file = await open(currentPath, "a");
          size = 0;
        }
        await file.writeFile(chunk);
        size += chunk.byteLength;
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    async final(callback) {
      try {
        await closeFile();
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    async destroy(error, callback) {
      try {
        await closeFile();
        callback(error);
      } catch (closeError) {
        callback(closeError as Error);
      }
    },
  });
};
