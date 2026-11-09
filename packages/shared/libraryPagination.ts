export interface LibraryPageCursor {
  createdAt: Date;
  id: string;
}

export const encodeLibraryPageCursor = (cursor: LibraryPageCursor): string =>
  `${cursor.createdAt.getTime()}:${encodeURIComponent(cursor.id)}`;

export const decodeLibraryPageCursor = (value: string | null | undefined): LibraryPageCursor | undefined => {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const separator = normalized.indexOf(":");
  if (separator <= 0) {
    throw new Error("媒体库分页游标无效");
  }
  const timestamp = Number(normalized.slice(0, separator));
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("媒体库分页游标无效");
  }
  try {
    const id = decodeURIComponent(normalized.slice(separator + 1));
    if (!id) {
      throw new Error("媒体库分页游标无效");
    }
    return { createdAt: new Date(timestamp), id };
  } catch {
    throw new Error("媒体库分页游标无效");
  }
};
