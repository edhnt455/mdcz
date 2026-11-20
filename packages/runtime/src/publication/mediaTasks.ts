import { AsyncLocalStorage } from "node:async_hooks";

type Request = {
  keys: Set<string>;
  label: string;
  resolve(release: () => void): void;
  signal?: AbortSignal;
  abort(): void;
};

const holders = new Map<string, string>();
const waiting: Request[] = [];
const context = new AsyncLocalStorage<ReadonlySet<string>>();

export const movieTaskKey = (movieId: string): string => `movie:${movieId}`;

export function mediaTaskConflict(keys: Iterable<string>): string | null {
  const requested = new Set(keys);
  for (const key of requested) {
    const label = holders.get(key);
    if (label) return label;
  }
  return waiting.find((request) => [...request.keys].some((key) => requested.has(key)))?.label ?? null;
}

function occupy(keys: Set<string>, label: string): () => void {
  for (const key of keys) holders.set(key, label);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) holders.delete(key);
    const blocked = new Set<string>();
    for (const request of [...waiting]) {
      if ([...request.keys].some((key) => holders.has(key) || blocked.has(key))) {
        for (const key of request.keys) blocked.add(key);
        continue;
      }
      waiting.splice(waiting.indexOf(request), 1);
      request.signal?.removeEventListener("abort", request.abort);
      request.resolve(occupy(request.keys, request.label));
    }
  };
}

export function tryAcquireMediaTask(keys: Iterable<string>, label: string): (() => void) | null {
  const requested = new Set(keys);
  return mediaTaskConflict(requested) ? null : occupy(requested, label);
}

export async function acquireMediaTask(
  keys: Iterable<string>,
  label: string,
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  const requested = new Set(keys);
  const release = tryAcquireMediaTask(requested, label);
  if (release) return release;
  return await new Promise<() => void>((resolve, reject) => {
    const request: Request = {
      keys: requested,
      label,
      resolve,
      signal,
      abort: () => {
        waiting.splice(waiting.indexOf(request), 1);
        reject(signal?.reason);
        // Removing a waiter can make an otherwise independent request admissible.
        occupy(new Set(), label)();
      },
    };
    waiting.push(request);
    signal?.addEventListener("abort", request.abort, { once: true });
  });
}

export async function withMovieTask<T>(
  movieId: string,
  label: string,
  write: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = movieTaskKey(movieId);
  const held = context.getStore();
  if (held?.has(key)) return await write();
  const release = await acquireMediaTask([key], label, signal);
  try {
    return await context.run(new Set([...(held ?? []), key]), write);
  } finally {
    release();
  }
}
